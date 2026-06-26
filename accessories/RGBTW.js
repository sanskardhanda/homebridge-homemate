'use strict';

/**
 * RGBTWLightV2Accessory
 *
 * For Tuya bulbs using the v2 data point schema:
 *   DP 20  switch_led        (bool)
 *   DP 21  work_mode         (enum: "white" | "colour" | "scene" | "music")
 *   DP 22  bright_value_v2   (integer 10–1000)
 *   DP 23  temp_value_v2     (integer 10–1000)
 *   DP 24  colour_data_v2    (12-hex HSB string: HHHHSSSSVVVV)
 *
 * Config example:
 * {
 *   "name": "Colour Bulb",
 *   "id":   "YOUR_DEVICE_ID",
 *   "key":  "YOUR_LOCAL_KEY",
 *   "ip":   "192.168.x.x",
 *   "version": "3.3",
 *   "type": "rgbtwlightv2"
 * }
 */

const TuyaLanDevice = require('../lib/TuyaLanDevice');

const RECONNECT_DELAY = 5000;
const POLL_INTERVAL   = 10000;
const COMMAND_GAP     = 150;

// DP numbers for v2 schema
const DP_POWER  = 20;
const DP_MODE   = 21;
const DP_BRIGHT = 22;
const DP_TEMP   = 23;
const DP_COLOR  = 24;

// Brightness range on the bulb
const BRIGHT_MIN = 10;
const BRIGHT_MAX = 1000;

class RGBTWLightV2Accessory {
  constructor(log, config, api) {
    this.log    = log;
    this.config = config;
    this.api    = api;
    this.state  = {};
    this._connected = false;
    this._commandQueue = Promise.resolve();
    this._pollTimer = null;
    this._reconnectTimer = null;

    const { Service, Characteristic, uuid } = api.hap;
    this.Service        = Service;
    this.Characteristic = Characteristic;

    // Allow DP overrides in config
    this.dpPower  = parseInt(config.dpPower)            || DP_POWER;
    this.dpMode   = parseInt(config.dpMode)             || DP_MODE;
    this.dpBright = parseInt(config.dpBrightness)       || DP_BRIGHT;
    this.dpTemp   = parseInt(config.dpColorTemperature) || DP_TEMP;
    this.dpColor  = parseInt(config.dpColor)            || DP_COLOR;

    // White (colour-temperature) DP value range on the device.
    this.minWhite = parseInt(config.minWhiteColor);
    if (!Number.isFinite(this.minWhite)) this.minWhite = 0;
    this.maxWhite = parseInt(config.maxWhiteColor) || 1000;

    // Build the platform accessory
    const accessoryUUID = uuid.generate(config.id);
    this.accessory = new api.platformAccessory(config.name, accessoryUUID);
    this.accessory.category = api.hap.Categories.LIGHTBULB;

    // Info service
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, config.manufacturer || 'Wipro / Tuya')
      .setCharacteristic(Characteristic.Model,        config.model || 'RGB+TW Batten')
      .setCharacteristic(Characteristic.SerialNumber,  config.id);

    // Lightbulb service
    const svc = this.accessory.addService(Service.Lightbulb, config.name);

    // On / Off
    this._charOn = svc.getCharacteristic(Characteristic.On)
      .onGet(() => !!this.state[this.dpPower])
      .onSet((v) => this._send({ [this.dpPower]: !!v }));

    // Brightness (1–100)
    this._charBright = svc.getCharacteristic(Characteristic.Brightness)
      .setProps({ minValue: 1, maxValue: 100, minStep: 1 })
      .onGet(() => this._getBrightness())
      .onSet((v) => this._setBrightness(v));

    // Colour temperature (140–500 mireds)
    this._charTemp = svc.getCharacteristic(Characteristic.ColorTemperature)
      .setProps({ minValue: 140, maxValue: 500 })
      .onGet(() => this._getTemp())
      .onSet((v) => this._setTemp(v));

    // Hue (0–360)
    this._charHue = svc.getCharacteristic(Characteristic.Hue)
      .onGet(() => this._getHue())
      .onSet((v) => this._setHueSat({ h: v }));

    // Saturation (0–100)
    this._charSat = svc.getCharacteristic(Characteristic.Saturation)
      .onGet(() => this._getSat())
      .onSet((v) => this._setHueSat({ s: v }));

    this._setupTuya();
  }

  // ══════════════════════════════════════
  //  TUYA CONNECTION
  // ══════════════════════════════════════

  _setupTuya() {
    if (!this.config.ip) {
      this.log.error(`[${this.config.name}] Manual IP is required for reliable Tuya LAN control.`);
      return;
    }

    // `tuyaId` overrides the local Tuya id used for LAN control while `config.id`
    // continues to drive the HomeKit identity (see HomeMate3Plus1Accessory for the
    // re-pairing scenario this handles).
    const tuyaId = String(this.config.tuyaId || this.config.id).trim();
    if (tuyaId !== String(this.config.id).trim()) {
      this.log.info(
        `[${this.config.name}] Using local Tuya id ${tuyaId} for control ` +
        `(HomeKit identity derived from ${this.config.id}).`,
      );
    }

    const opts = {
      name: this.config.name,
      id: tuyaId,
      key: String(this.config.key),
      version: String(this.config.version || '3.3'),
      ip: String(this.config.ip).trim(),
      port: Number(this.config.port || 6668),
      log: this.log,
      sendEmptyUpdate: !!this.config.sendEmptyUpdate,
    };

    this.device = new TuyaLanDevice(opts);

    this.device.on('connect', () => {
      this.log.info(`[${this.config.name}] connected`);
      this._connected = true;
      clearTimeout(this._reconnectTimer);
    });

    this.device.on('change', (changes, state) => {
      this.log.debug(`[${this.config.name}] data:`, JSON.stringify(changes));
      this._applyState(state);
    });

    this.device.on('disconnect', () => {
      this.log.warn(`[${this.config.name}] disconnected`);
      this._connected = false;
    });

    this.device.on('error', (err) => {
      this._connected = false;
      this.log.warn(`[${this.config.name}] error:`, err && err.message ? err.message : err);
    });

    this._connect();

    this._pollTimer = setInterval(() => {
      if (this._connected) this.device.update();
    }, POLL_INTERVAL);
  }

  _connect() {
    this._connected = false;
    try {
      this.device.connect();
    } catch (err) {
      this.log.error(`[${this.config.name}] connect failed:`, err.message || err);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this._connected = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._connect(), RECONNECT_DELAY);
  }

  // ══════════════════════════════════════
  //  STATE → HOMEKIT
  // ══════════════════════════════════════

  _applyState(dps) {
    const { Characteristic } = this;
    Object.assign(this.state, dps);

    if (dps[this.dpPower] !== undefined)
      this._charOn.updateValue(!!dps[this.dpPower]);

    const mode = this.state[this.dpMode];

    if (mode === 'white') {
      if (dps[this.dpBright] !== undefined)
        this._charBright.updateValue(this._b2hk(dps[this.dpBright]));
      if (dps[this.dpTemp] !== undefined) {
        const hkTemp  = this._t2hk(dps[this.dpTemp]);
        const hkColor = this._tempToColor(hkTemp);
        this._charTemp.updateValue(hkTemp);
        this._charHue.updateValue(hkColor.h);
        this._charSat.updateValue(hkColor.s);
      }
    } else if (mode === 'colour' || dps[this.dpColor] !== undefined) {
      const c = this._parseColor(this.state[this.dpColor]);
      this._charHue.updateValue(c.h);
      this._charSat.updateValue(c.s);
      this._charBright.updateValue(Math.max(1, c.b)); // HomeKit Brightness min is 1
      this._charTemp.updateValue(370); // neutral placeholder
    }
  }

  // ══════════════════════════════════════
  //  GETTERS
  // ══════════════════════════════════════

  _getBrightness() {
    if (this.state[this.dpMode] === 'white')
      return this._b2hk(this.state[this.dpBright] || BRIGHT_MIN);
    return Math.max(1, this._parseColor(this.state[this.dpColor]).b);
  }

  _getTemp() {
    if (this.state[this.dpMode] !== 'white') return 370;
    return this._t2hk(this.state[this.dpTemp] || 0);
  }

  _getHue() {
    if (this.state[this.dpMode] === 'white') return 0;
    return this._parseColor(this.state[this.dpColor]).h;
  }

  _getSat() {
    if (this.state[this.dpMode] === 'white') return 0;
    return this._parseColor(this.state[this.dpColor]).s;
  }

  // ══════════════════════════════════════
  //  SETTERS
  // ══════════════════════════════════════

  async _setBrightness(hkValue) {
    if (this.state[this.dpMode] === 'white') {
      await this._send({ [this.dpBright]: this._hk2b(hkValue) });
    } else {
      const c = this._parseColor(this.state[this.dpColor]);
      await this._send({ [this.dpColor]: this._buildColor(c.h, c.s, hkValue) });
    }
  }

  async _setTemp(hkValue) {
    const hkColor = this._tempToColor(hkValue);
    this._charHue.updateValue(hkColor.h);
    this._charSat.updateValue(hkColor.s);
    await this._send({
      [this.dpMode]: 'white',
      [this.dpTemp]: this._hk2t(hkValue),
    });
  }

  // Debounce hue+sat — HomeKit sends them as two separate calls
  _setHueSat(prop) {
    return new Promise((resolve) => {
      if (!this._pending) this._pending = { props: {}, resolvers: [] };
      if (this._pending.timer) clearTimeout(this._pending.timer);
      Object.assign(this._pending.props, prop);
      this._pending.resolvers.push(resolve);
      this._pending.timer = setTimeout(() => this._flushHueSat(), 500);
    });
  }

  async _flushHueSat() {
    if (!this._pending) return;
    const { props, resolvers } = this._pending;
    this._pending = null;

    const current = this._parseColor(this.state[this.dpColor]);
    const h = props.h !== undefined ? props.h : current.h;
    const s = props.s !== undefined ? props.s : current.s;
    const b = current.b || 100;

    await this._send({
      [this.dpMode]:  'colour',
      [this.dpColor]: this._buildColor(h, s, b),
    });
    resolvers.forEach(r => r());
  }

  // ══════════════════════════════════════
  //  SEND TO DEVICE
  // ══════════════════════════════════════

  async _send(dps) {
    if (!this.device || !this._connected) {
      this.log.warn(`[${this.config.name}] not connected, command skipped`);
      return;
    }

    this._commandQueue = this._commandQueue
      .catch(() => {})
      .then(() => this._writeDps(dps));

    return this._commandQueue;
  }

  async _writeDps(dps) {
    const normalized = {};
    for (const [dp, value] of Object.entries(dps)) {
      normalized[String(dp)] = value;
    }

    const sent = this.device.update(normalized);
    if (!sent) {
      this.log.warn(`[${this.config.name}] DPS write was not sent; device socket is not connected.`);
      this._connected = false;
      this._scheduleReconnect();
    }

    await new Promise((resolve) => setTimeout(resolve, COMMAND_GAP));
  }

  // ══════════════════════════════════════
  //  CONVERSION HELPERS
  // ══════════════════════════════════════

  /**
   * colour_data_v2 → { h:0-360, s:0-100, b:0-100 }.
   *
   * This batten (and most v2 Tuya RGBTW devices) encodes colour as the 12-hex
   * "HSB" string HHHHSSSSVVVV — hue 0-360, saturation 0-1000, value 0-1000, each
   * as a 4-char big-endian hex word (e.g. "00bc03e80000"). Earlier builds of this
   * accessory wrongly sent/parsed JSON, which the device silently misread and is
   * what caused the colour shown to differ from the colour selected. The JSON
   * branch is kept only as a fallback for firmwares that report that format.
   */
  _parseColor(raw) {
    if (!raw) return { h: 0, s: 100, b: 100 };
    if (typeof raw === 'string' && raw.trim()[0] !== '{') {
      const hex = raw.trim();
      if (hex.length >= 12) {
        return {
          h: Math.min(360, parseInt(hex.slice(0, 4), 16) || 0),
          s: Math.round((parseInt(hex.slice(4, 8), 16) || 0) / 10),
          b: Math.round((parseInt(hex.slice(8, 12), 16) || 0) / 10),
        };
      }
    }
    try {
      const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        h: Math.round(o.h || 0),
        s: Math.round((o.s || 0) / 10),
        b: Math.round((o.v || 0) / 10),
      };
    } catch { return { h: 0, s: 100, b: 100 }; }
  }

  /** { h:0-360, s:0-100, b:0-100 } → 12-hex HHHHSSSSVVVV colour_data string */
  _buildColor(h, s, b) {
    const H = Math.max(0, Math.min(360, Math.round(h)));
    const S = Math.max(0, Math.min(1000, Math.round(s * 10)));
    const V = Math.max(0, Math.min(1000, Math.round(b * 10)));
    const hx = (n) => n.toString(16).padStart(4, '0');
    return hx(H) + hx(S) + hx(V);
  }

  /** Tuya bright 10-1000 → HomeKit 1-100 */
  _b2hk(v) {
    const clamped = Math.max(BRIGHT_MIN, Math.min(BRIGHT_MAX, v || BRIGHT_MIN));
    return Math.max(1, Math.round((clamped - BRIGHT_MIN) / (BRIGHT_MAX - BRIGHT_MIN) * 99 + 1));
  }

  /** HomeKit 1-100 → Tuya bright 10-1000 */
  _hk2b(v) {
    return Math.round((Math.max(1, Math.min(100, v)) - 1) / 99 * (BRIGHT_MAX - BRIGHT_MIN) + BRIGHT_MIN);
  }

  /**
   * Tuya temp 0-1000 → HomeKit mireds 140-500
   * Tuya 0 = warm, 1000 = cool  (inverted vs HomeKit)
   * HomeKit 500 = warm, 140 = cool
   */
  _t2hk(v) {
    return Math.round(500 - (Math.max(0, Math.min(1000, v)) / 1000) * 360);
  }

  /** HomeKit mireds 140-500 → Tuya temp, clamped to the device's white range */
  _hk2t(v) {
    const raw = Math.round((500 - Math.max(140, Math.min(500, v))) / 360 * 1000);
    return Math.max(this.minWhite, Math.min(this.maxWhite, raw));
  }

  /** HomeKit mireds → approximate { h, s } for hue/sat display */
  _tempToColor(mireds) {
    const kelvin = 1000000 / mireds;
    // Very rough warm=yellow, cool=white approximation
    const warmth = Math.max(0, Math.min(1, (kelvin - 2700) / (6500 - 2700)));
    return { h: Math.round(40 * (1 - warmth)), s: Math.round(30 * (1 - warmth)) };
  }
}

module.exports = RGBTWLightV2Accessory;

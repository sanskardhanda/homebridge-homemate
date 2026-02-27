'use strict';

/**
 * HomeMate3Plus1Accessory
 *
 * Supports the HomeMate 3+1 wall switch:
 *   - 3 light switches (boolean DPs)
 *   - 1 fan switch (boolean DP)
 *   - 1 fan speed (enum DP: "level_1", "level_2", "level_3", "level_4")
 *
 * Example config.json entry:
 * {
 *   "name": "Living Room Panel",
 *   "id": "YOUR_DEVICE_ID",
 *   "key": "YOUR_LOCAL_KEY",
 *   "ip": "192.168.1.XXX",
 *   "version": "3.3",
 *   "lights": [
 *     { "name": "Light 1", "dp": 1 },
 *     { "name": "Light 2", "dp": 2 },
 *     { "name": "Light 3", "dp": 3 }
 *   ],
 *   "fan": {
 *     "name": "Ceiling Fan",
 *     "dpSwitch": 101,
 *     "dpSpeed": 102,
 *     "speedValues": ["level_1", "level_2", "level_3", "level_4"]
 *   }
 * }
 *
 * speedValues maps to HomeKit fan speed (0-100%) in equal steps.
 * With 4 speeds: level_1=25%, level_2=50%, level_3=75%, level_4=100%
 */

let TuyaDevice;
try {
  TuyaDevice = require('@tuyapi/local');
} catch (e) {
  // Will warn at runtime
}

const RECONNECT_DELAY = 5000; // ms
const POLL_INTERVAL = 10000;  // ms — how often to refresh state

class HomeMate3Plus1Accessory {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    const { Service, Characteristic, uuid } = api.hap;
    this.Service = Service;
    this.Characteristic = Characteristic;

    // Device state cache
    this.state = {};

    // Validate config
    this.lightsConfig = config.lights || [];
    this.fanConfig = config.fan || null;

    // Build a single bridge accessory that contains multiple services
    const accessoryUUID = uuid.generate(config.id);
    this.accessory = new api.platformAccessory(config.name, accessoryUUID);
    this.accessory.category = api.hap.Categories.SWITCH;

    // Information service
    const infoService = this.accessory.getService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, config.manufacturer || 'HomeMate / Tuya')
      .setCharacteristic(Characteristic.Model, config.model || 'HomeMate 3+1 Switch')
      .setCharacteristic(Characteristic.SerialNumber, config.id);

    // --- Light Switch Services ---
    this.lightServices = [];
    for (const lightCfg of this.lightsConfig) {
      const svc = this.accessory.addService(
        Service.Switch,
        lightCfg.name,
        `light-${lightCfg.dp}`
      );

      svc.getCharacteristic(Characteristic.On)
        .onGet(() => this._getLightState(lightCfg.dp))
        .onSet((value) => this._setLightState(lightCfg.dp, value));

      this.lightServices.push({ config: lightCfg, service: svc });
      this.log.info(`Registered light: "${lightCfg.name}" on DP ${lightCfg.dp}`);
    }

    // --- Fan Service ---
    if (this.fanConfig) {
      const fanSvc = this.accessory.addService(
        Service.Fanv2,
        this.fanConfig.name,
        'fan-main'
      );

      // Active (on/off)
      fanSvc.getCharacteristic(Characteristic.Active)
        .onGet(() => this._getFanActive())
        .onSet((value) => this._setFanActive(value));

      // Rotation speed (0-100)
      fanSvc.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(() => this._getFanSpeed())
        .onSet((value) => this._setFanSpeed(value));

      this.fanService = fanSvc;
      this.log.info(
        `Registered fan: "${this.fanConfig.name}" switch DP ${this.fanConfig.dpSwitch}, speed DP ${this.fanConfig.dpSpeed}`
      );
    }

    // --- Connect to device ---
    this._setupTuya();
  }

  // ─── Tuya Connection ──────────────────────────────────────────────────────

  _setupTuya() {
    if (!TuyaDevice) {
      this.log.error('homebridge-tuya-homemate: @tuyapi/local is not installed. Run: npm install @tuyapi/local');
      return;
    }

    const speedValues = (this.fanConfig && this.fanConfig.speedValues) ||
      ['level_1', 'level_2', 'level_3', 'level_4'];

    this.device = new TuyaDevice({
      id: this.config.id,
      key: this.config.key,
      ip: this.config.ip,
      version: this.config.version || '3.3',
    });

    this.device.on('data', (data) => {
      if (!data || !data.dps) return;
      this.log.debug(`[${this.config.name}] Received data:`, JSON.stringify(data.dps));
      this._updateState(data.dps);
    });

    this.device.on('error', (err) => {
      this.log.error(`[${this.config.name}] Device error:`, err.message || err);
      this._scheduleReconnect();
    });

    this.device.on('disconnected', () => {
      this.log.warn(`[${this.config.name}] Device disconnected. Reconnecting...`);
      this._scheduleReconnect();
    });

    this.device.on('connected', () => {
      this.log.info(`[${this.config.name}] Device connected.`);
      clearTimeout(this._reconnectTimer);
      // Ask device for current state
      this.device.get({ schema: true }).catch((e) => {
        this.log.warn(`[${this.config.name}] Initial get failed:`, e.message);
      });
    });

    this._connect();

    // Periodic poll to keep state fresh
    this._pollTimer = setInterval(() => {
      if (this.device && this._connected) {
        this.device.get({ schema: true }).catch(() => {});
      }
    }, POLL_INTERVAL);
  }

  _connect() {
    this._connected = false;
    this.device.connect().then(() => {
      this._connected = true;
    }).catch((err) => {
      this.log.error(`[${this.config.name}] Connection failed:`, err.message || err);
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    this._connected = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.log.info(`[${this.config.name}] Attempting reconnect...`);
      this._connect();
    }, RECONNECT_DELAY);
  }

  // ─── State Management ─────────────────────────────────────────────────────

  _updateState(dps) {
    const { Characteristic } = this;

    for (const [dpStr, value] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);
      this.state[dp] = value;

      // Update light services
      for (const { config: lightCfg, service } of this.lightServices) {
        if (dp === lightCfg.dp) {
          service.updateCharacteristic(Characteristic.On, !!value);
        }
      }

      // Update fan service
      if (this.fanConfig && this.fanService) {
        if (dp === this.fanConfig.dpSwitch) {
          const active = value
            ? Characteristic.Active.ACTIVE
            : Characteristic.Active.INACTIVE;
          this.fanService.updateCharacteristic(Characteristic.Active, active);
        }
        if (dp === this.fanConfig.dpSpeed) {
          const pct = this._speedToPercent(value);
          this.fanService.updateCharacteristic(Characteristic.RotationSpeed, pct);
        }
      }
    }
  }

  // ─── Light Handlers ───────────────────────────────────────────────────────

  _getLightState(dp) {
    return !!this.state[dp];
  }

  async _setLightState(dp, value) {
    this.log.info(`[${this.config.name}] Set light DP ${dp} -> ${value}`);
    this.state[dp] = value;
    await this._sendDps({ [dp]: !!value });
  }

  // ─── Fan Handlers ─────────────────────────────────────────────────────────

  _getFanActive() {
    const { Characteristic } = this;
    const on = !!this.state[this.fanConfig.dpSwitch];
    return on ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
  }

  async _setFanActive(value) {
    const { Characteristic } = this;
    const on = value === Characteristic.Active.ACTIVE;
    this.log.info(`[${this.config.name}] Set fan switch DP ${this.fanConfig.dpSwitch} -> ${on}`);
    this.state[this.fanConfig.dpSwitch] = on;
    await this._sendDps({ [this.fanConfig.dpSwitch]: on });
  }

  _getFanSpeed() {
    const speedVal = this.state[this.fanConfig.dpSpeed];
    return this._speedToPercent(speedVal);
  }

  async _setFanSpeed(percent) {
    const speedVal = this._percentToSpeed(percent);
    this.log.info(
      `[${this.config.name}] Set fan speed DP ${this.fanConfig.dpSpeed} -> ${speedVal} (${percent}%)`
    );
    this.state[this.fanConfig.dpSpeed] = speedVal;

    // If speed is being set and fan is off, turn it on automatically
    if (percent > 0 && !this.state[this.fanConfig.dpSwitch]) {
      this.state[this.fanConfig.dpSwitch] = true;
      await this._sendDps({
        [this.fanConfig.dpSwitch]: true,
        [this.fanConfig.dpSpeed]: speedVal,
      });
      // Update active characteristic
      this.fanService.updateCharacteristic(
        this.Characteristic.Active,
        this.Characteristic.Active.ACTIVE
      );
    } else if (percent === 0) {
      // Setting speed to 0 turns the fan off
      this.state[this.fanConfig.dpSwitch] = false;
      await this._sendDps({
        [this.fanConfig.dpSwitch]: false,
      });
      this.fanService.updateCharacteristic(
        this.Characteristic.Active,
        this.Characteristic.Active.INACTIVE
      );
    } else {
      await this._sendDps({ [this.fanConfig.dpSpeed]: speedVal });
    }
  }

  // ─── Speed Conversion ─────────────────────────────────────────────────────

  /**
   * Convert a Tuya speed enum string -> HomeKit percentage (1-100)
   * "level_1" = 25%, "level_2" = 50%, "level_3" = 75%, "level_4" = 100%
   */
  _speedToPercent(speedValue) {
    if (!speedValue) return 0;
    const speeds = (this.fanConfig && this.fanConfig.speedValues) ||
      ['level_1', 'level_2', 'level_3', 'level_4'];
    const idx = speeds.indexOf(speedValue);
    if (idx === -1) return 25; // default to lowest
    return Math.round(((idx + 1) / speeds.length) * 100);
  }

  /**
   * Convert HomeKit percentage -> nearest Tuya speed enum string
   * 1-25% = level_1, 26-50% = level_2, 51-75% = level_3, 76-100% = level_4
   */
  _percentToSpeed(percent) {
    const speeds = (this.fanConfig && this.fanConfig.speedValues) ||
      ['level_1', 'level_2', 'level_3', 'level_4'];
    if (percent <= 0) return speeds[0];
    const idx = Math.min(
      Math.ceil((percent / 100) * speeds.length) - 1,
      speeds.length - 1
    );
    return speeds[Math.max(0, idx)];
  }

  // ─── Send DPS ─────────────────────────────────────────────────────────────

  async _sendDps(dps) {
    if (!this.device || !this._connected) {
      this.log.warn(`[${this.config.name}] Device not connected, cannot send DPS.`);
      return;
    }
    try {
      await this.device.set({ multiple: true, data: dps });
    } catch (err) {
      this.log.error(`[${this.config.name}] Failed to send DPS:`, err.message || err);
      this._scheduleReconnect();
    }
  }
}

module.exports = HomeMate3Plus1Accessory;

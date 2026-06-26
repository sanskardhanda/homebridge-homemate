'use strict';

let TuyaDevice;
try {
  TuyaDevice = require('tuyapi');
} catch (e) {
  // Will warn at runtime.
}

const RECONNECT_DELAY = 5000;
const POLL_INTERVAL = 10000;
const COMMAND_GAP = 150;
const FAN_SPEED_DEBOUNCE = 250;

class HomeMate3Plus1Accessory {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    const { Service, Characteristic, uuid } = api.hap;
    this.Service = Service;
    this.Characteristic = Characteristic;

    this.state = {};
    this._connected = false;
    this._commandQueue = Promise.resolve();
    this._pollTimer = null;
    this._reconnectTimer = null;
    this._fanSpeedTimer = null;
    this._fanSpeedResolve = null;
    this._pendingFanSpeedDps = null;
    this.lightsConfig = config.lights || [];
    this.fanConfig = config.fan || null;

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
        `light-${lightCfg.dp}`,
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
        'fan-main',
      );
      fanSvc.getCharacteristic(Characteristic.Active)
        .onGet(() => this._getFanActive())
        .onSet((value) => this._setFanActive(value));
      fanSvc.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(() => this._getFanSpeed())
        .onSet((value) => this._setFanSpeed(value));
      this.fanService = fanSvc;
      this.log.info(
        `Registered fan: "${this.fanConfig.name}" switch DP ${this.fanConfig.dpSwitch}, speed DP ${this.fanConfig.dpSpeed}`,
      );
    }

    this._setupTuya();
  }

  // ─── Tuya Connection ──────────────────────────────────────────────────────

  _setupTuya() {
    if (!TuyaDevice) {
      this.log.error('homebridge-homemate: tuyapi is not installed. Run: npm install tuyapi');
      return;
    }

    // The Tuya protocol device id ("gwId") is what the device checks when it
    // receives a control write — a write addressed to the wrong id is accepted at
    // the frame level but silently ignored (state still reads fine). This id can
    // diverge from `config.id` after re-pairing the device in Smart Life, which
    // rotates both the local key AND the device id. Allow an optional `tuyaId`
    // override so HomeKit identity (derived from `config.id`) stays stable while
    // LAN control targets the device's current local id.
    const tuyaId = String(this.config.tuyaId || this.config.id).trim();
    if (tuyaId !== String(this.config.id).trim()) {
      this.log.info(
        `[${this.config.name}] Using local Tuya id ${tuyaId} for control ` +
        `(HomeKit identity derived from ${this.config.id}).`,
      );
    }

    const deviceOptions = {
      id: tuyaId,
      key: String(this.config.key),
      version: String(this.config.version || '3.3'),
    };

    if (this.config.ip) {
      deviceOptions.ip = String(this.config.ip).trim();
    }

    if (this.config.port) {
      deviceOptions.port = Number(this.config.port);
    }

    this.device = new TuyaDevice(deviceOptions);

    this.device.on('connected', () => {
      this.log.info(`[${this.config.name}] Device connected.`);
      this._connected = true;
      clearTimeout(this._reconnectTimer);
      this.device.get({ schema: true }).catch((error) => {
        this.log.warn(`[${this.config.name}] Initial get failed:`, error.message || error);
      });
    });

    this.device.on('data', (data) => {
      if (!data || !data.dps) {
        return;
      }

      this.log.debug(`[${this.config.name}] Received data:`, JSON.stringify(data.dps));
      this._updateState(data.dps);
    });

    this.device.on('disconnected', () => {
      this.log.warn(`[${this.config.name}] Device disconnected. Reconnecting...`);
      this._connected = false;
      this._scheduleReconnect();
    });

    this.device.on('error', (err) => {
      const message = err && err.message ? err.message : String(err);

      if (message.includes('Timeout waiting for status response')) {
        this.log.warn(`[${this.config.name}] Ignoring set response timeout; command was sent.`);
        return;
      }

      this._connected = false;
      this.log.warn(`[${this.config.name}] Device error:`, message);
      this._scheduleReconnect();
    });

    this._connect();

    this._pollTimer = setInterval(() => {
      if (this.device && this._connected) {
        this.device.get({ schema: true }).catch(() => {});
      }
    }, POLL_INTERVAL);
  }

  async _connect() {
    this._connected = false;

    try {
      if (!this.config.ip) {
        this.log.info(`[${this.config.name}] No IP set - discovering device on network...`);
        await this.device.find();
        this.log.info(`[${this.config.name}] Device discovered.`);
      }

      await this.device.connect();
      this._connected = true;
    } catch (err) {
      this.log.error(`[${this.config.name}] Connection failed:`, err.message || err);
      this._scheduleReconnect();
    }
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
      for (const { config: lightCfg, service } of this.lightServices) {
        if (dp === lightCfg.dp) {
          service.updateCharacteristic(Characteristic.On, !!value);
        }
      }
      if (this.fanConfig && this.fanService) {
        if (dp === this.fanConfig.dpSwitch) {
          const active = value ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
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
    const on = !!value;

    this.log.info(`[${this.config.name}] Set light DP ${dp} -> ${on}`);

    if (this.state[dp] === on) {
      this.log.debug(`[${this.config.name}] Light DP ${dp} already ${on}; skipping DPS write.`);
      return;
    }

    await this._sendDps({ [dp]: on });
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

    if (this.state[this.fanConfig.dpSwitch] === on) {
      this.log.debug(
        `[${this.config.name}] Fan switch DP ${this.fanConfig.dpSwitch} already ${on}; skipping DPS write.`,
      );
      return;
    }

    await this._sendDps({ [this.fanConfig.dpSwitch]: on });
  }

  _getFanSpeed() {
    const speedVal = this.state[this.fanConfig.dpSpeed];
    return this._speedToPercent(speedVal);
  }

  async _setFanSpeed(percent) {
    const speedVal = this._percentToSpeed(percent);
    this.log.info(`[${this.config.name}] Set fan speed DP ${this.fanConfig.dpSpeed} -> ${speedVal} (${percent}%)`);

    if (percent <= 0 && this.state[this.fanConfig.dpSwitch] === false) {
      this.log.debug(`[${this.config.name}] Fan already off; skipping DPS write.`);
      return;
    }

    if (percent > 0 && this.state[this.fanConfig.dpSwitch] && this.state[this.fanConfig.dpSpeed] === speedVal) {
      this.log.debug(
        `[${this.config.name}] Fan speed DP ${this.fanConfig.dpSpeed} already ${speedVal}; skipping DPS write.`,
      );
      return;
    }

    if (percent > 0 && !this.state[this.fanConfig.dpSwitch]) {
      await this._sendDps({
        [this.fanConfig.dpSwitch]: true,
        [this.fanConfig.dpSpeed]: speedVal,
      });
      this.fanService.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.ACTIVE);
    } else if (percent === 0) {
      await this._sendDps({ [this.fanConfig.dpSwitch]: false });
      this.fanService.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.INACTIVE);
    } else {
      await this._scheduleFanSpeedDps({ [this.fanConfig.dpSpeed]: speedVal });
    }
  }

  // ─── Speed Conversion ─────────────────────────────────────────────────────

  _speedToPercent(speedValue) {
    if (!speedValue) {
      return 0;
    }
    const speeds = (this.fanConfig && this.fanConfig.speedValues) || ['level_1', 'level_2', 'level_3', 'level_4'];
    const idx = speeds.indexOf(speedValue);
    if (idx === -1) {
      return 25;
    }
    return Math.round(((idx + 1) / speeds.length) * 100);
  }

  _percentToSpeed(percent) {
    const speeds = (this.fanConfig && this.fanConfig.speedValues) || ['level_1', 'level_2', 'level_3', 'level_4'];
    if (percent <= 0) {
      return speeds[0];
    }
    const idx = Math.min(Math.ceil((percent / 100) * speeds.length) - 1, speeds.length - 1);
    return speeds[Math.max(0, idx)];
  }

  // ─── Send DPS ─────────────────────────────────────────────────────────────

  _scheduleFanSpeedDps(dps) {
    this._pendingFanSpeedDps = dps;

    if (this._fanSpeedTimer) {
      clearTimeout(this._fanSpeedTimer);
    }

    if (this._fanSpeedResolve) {
      this._fanSpeedResolve();
    }

    return new Promise((resolve) => {
      this._fanSpeedResolve = resolve;
      this._fanSpeedTimer = setTimeout(async () => {
        const pending = this._pendingFanSpeedDps;
        this._pendingFanSpeedDps = null;
        this._fanSpeedTimer = null;
        this._fanSpeedResolve = null;

        await this._sendDps(pending);
        resolve();
      }, FAN_SPEED_DEBOUNCE);
    });
  }

  async _sendDps(dps) {
    if (!this.device || !this._connected) {
      this.log.warn(`[${this.config.name}] Device not connected, cannot send DPS.`);
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

    this.log.debug(`[${this.config.name}] Sending DPS:`, JSON.stringify(normalized));

    try {
      await this.device.set({
        multiple: true,
        data: normalized,
        shouldWaitForResponse: false,
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);

      if (message.includes('Timeout waiting for status response')) {
        this.log.warn(`[${this.config.name}] DPS write timed out waiting for status response; keeping connection open.`);
      } else {
        this.log.error(`[${this.config.name}] Failed to send DPS:`, message);
        this._connected = false;
        this._scheduleReconnect();
        throw err;
      }
    }

    this._updateState(normalized);

    await new Promise((resolve) => setTimeout(resolve, COMMAND_GAP));
  }
}

module.exports = HomeMate3Plus1Accessory;

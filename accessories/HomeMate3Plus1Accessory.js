'use strict';

const TuyaLanDevice = require('../lib/TuyaLanDevice');

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
    if (!this.config.ip) {
      this.log.error(`[${this.config.name}] Manual IP is required for reliable HomeMate LAN control.`);
      return;
    }

    const deviceOptions = {
      name: this.config.name,
      id: String(this.config.id).trim(),
      key: String(this.config.key),
      version: String(this.config.version || '3.3'),
      ip: String(this.config.ip).trim(),
      port: Number(this.config.port || 6668),
      log: this.log,
      sendEmptyUpdate: !!this.config.sendEmptyUpdate,
    };

    this.device = new TuyaLanDevice(deviceOptions);

    this.device.on('connect', () => {
      this.log.info(`[${this.config.name}] Device connected.`);
      this._connected = true;
      clearTimeout(this._reconnectTimer);
    });

    this.device.on('change', (changes, state) => {
      this.log.debug(`[${this.config.name}] Received data:`, JSON.stringify(changes));
      this._updateState(state);
    });

    this.device.on('disconnect', () => {
      this.log.warn(`[${this.config.name}] Device disconnected. Reconnecting...`);
      this._connected = false;
    });

    this.device.on('error', (err) => {
      this._connected = false;
      this.log.warn(`[${this.config.name}] Device error:`, err && err.message ? err.message : err);
    });

    this._connect();

    this._pollTimer = setInterval(() => {
      if (this.device && this._connected) {
        this.device.update();
      }
    }, POLL_INTERVAL);
  }

  _connect() {
    this._connected = false;

    try {
      this.device.connect();
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

    const sent = this.device.update(normalized);
    if (!sent) {
      this.log.warn(`[${this.config.name}] DPS write was not sent; device socket is not connected.`);
      this._connected = false;
      this._scheduleReconnect();
    }

    await new Promise((resolve) => setTimeout(resolve, COMMAND_GAP));
  }
}

module.exports = HomeMate3Plus1Accessory;

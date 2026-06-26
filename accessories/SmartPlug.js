'use strict';

/**
 * SmartPlugAccessory
 *
 * Tuya single-socket metering plug (e.g. Wipro 16A) on the v3.3 LAN protocol.
 *
 *   DP 1   switch        (bool)   on/off
 *   DP 18  cur_current   (int)    mA
 *   DP 19  cur_power     (int)    W * 10
 *   DP 20  cur_voltage   (int)    V * 10
 *   DP 17  add_ele       (int)    cumulative energy, kWh * 100 (if reported)
 *
 * Exposed in HomeKit as an Outlet. The Apple Home app shows only on/off and
 * "in use"; power/voltage/current are published as Eve-compatible custom
 * characteristics, visible in apps that read them (Eve, Controller for HomeKit).
 *
 * The DP map is fixed in code, so a user only needs to provide id and key.
 */

let TuyaDevice;
try {
  TuyaDevice = require('tuyapi');
} catch (e) {
  // Will warn at runtime.
}

const RECONNECT_DELAY = 5000;
const POLL_INTERVAL = 10000;
const COMMAND_GAP = 150;

// Fixed DP map for this plug type.
const DP_SWITCH = 1;
const DP_CURRENT = 18; // mA
const DP_POWER = 19; // W * 10
const DP_VOLTAGE = 20; // V * 10
const DP_ENERGY = 17; // kWh * 100 (cumulative, optional)

// Eve custom characteristic UUIDs (read by Eve / Controller for HomeKit; the
// stock Apple Home app ignores these but still shows the outlet on/off).
const EVE_VOLTAGE = 'E863F10A-079E-48FF-8F27-9C2605A29F52';
const EVE_CURRENT = 'E863F126-079E-48FF-8F27-9C2605A29F52';
const EVE_CONSUMPTION = 'E863F10D-079E-48FF-8F27-9C2605A29F52'; // Watts
const EVE_TOTAL_CONSUMPTION = 'E863F10C-079E-48FF-8F27-9C2605A29F52'; // kWh

function defineEveCharacteristics(Characteristic, Formats, Perms) {
  class Voltage extends Characteristic {
    constructor() {
      super('Voltage', EVE_VOLTAGE, { format: Formats.FLOAT, unit: 'V', minValue: 0, maxValue: 300, minStep: 0.1, perms: [Perms.READ, Perms.NOTIFY] });
      this.value = this.getDefaultValue();
    }
  }
  class ElectricCurrent extends Characteristic {
    constructor() {
      super('Electric Current', EVE_CURRENT, { format: Formats.FLOAT, unit: 'A', minValue: 0, maxValue: 32, minStep: 0.01, perms: [Perms.READ, Perms.NOTIFY] });
      this.value = this.getDefaultValue();
    }
  }
  class CurrentConsumption extends Characteristic {
    constructor() {
      super('Consumption', EVE_CONSUMPTION, { format: Formats.FLOAT, unit: 'W', minValue: 0, maxValue: 4000, minStep: 0.1, perms: [Perms.READ, Perms.NOTIFY] });
      this.value = this.getDefaultValue();
    }
  }
  class TotalConsumption extends Characteristic {
    constructor() {
      super('Total Consumption', EVE_TOTAL_CONSUMPTION, { format: Formats.FLOAT, unit: 'kWh', minValue: 0, maxValue: 1000000, minStep: 0.01, perms: [Perms.READ, Perms.NOTIFY] });
      this.value = this.getDefaultValue();
    }
  }
  return { Voltage, ElectricCurrent, CurrentConsumption, TotalConsumption };
}

class SmartPlugAccessory {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    const { Service, Characteristic, uuid } = api.hap;
    this.Service = Service;
    this.Characteristic = Characteristic;

    // HAP moved Formats/Perms to top-level exports; fall back to the old static
    // location and finally to the stable string values.
    const Formats = api.hap.Formats || Characteristic.Formats || { FLOAT: 'float' };
    const Perms = api.hap.Perms || Characteristic.Perms || { READ: 'pr', NOTIFY: 'ev' };

    this.state = {};
    this._connected = false;
    this._commandQueue = Promise.resolve();
    this._pollTimer = null;
    this._reconnectTimer = null;

    this.dpSwitch = parseInt(config.dpSwitch, 10) || DP_SWITCH;
    this.dpCurrent = parseInt(config.dpCurrent, 10) || DP_CURRENT;
    this.dpPower = parseInt(config.dpPower, 10) || DP_POWER;
    this.dpVoltage = parseInt(config.dpVoltage, 10) || DP_VOLTAGE;
    this.dpEnergy = parseInt(config.dpEnergy, 10) || DP_ENERGY;

    const Eve = defineEveCharacteristics(Characteristic, Formats, Perms);
    this.Eve = Eve;

    const accessoryUUID = uuid.generate(config.id);
    this.accessory = new api.platformAccessory(config.name, accessoryUUID);
    this.accessory.category = api.hap.Categories.OUTLET;

    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, config.manufacturer || 'Wipro / Tuya')
      .setCharacteristic(Characteristic.Model, config.model || 'Smart Plug')
      .setCharacteristic(Characteristic.SerialNumber, config.id);

    const svc = this.accessory.addService(Service.Outlet, config.name);
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => !!this.state[this.dpSwitch])
      .onSet((value) => this._setOn(value));
    svc.getCharacteristic(Characteristic.OutletInUse)
      .onGet(() => this._inUse());

    // Add Eve energy characteristics to the outlet service.
    for (const C of [Eve.CurrentConsumption, Eve.Voltage, Eve.ElectricCurrent, Eve.TotalConsumption]) {
      if (!svc.testCharacteristic(C)) svc.addCharacteristic(C);
    }
    this.outletService = svc;

    this.log.info(`Registered Wipro Smart Plug: "${config.name}" (switch DP ${this.dpSwitch}, metering DPs ${this.dpPower}/${this.dpVoltage}/${this.dpCurrent})`);

    this._setupTuya();
  }

  _inUse() {
    const p = this.state[this.dpPower];
    if (typeof p === 'number' && p > 0) return true;
    return !!this.state[this.dpSwitch];
  }

  // ─── Tuya Connection (mirrors HomeMate3Plus1Accessory) ──────────────────────

  _setupTuya() {
    if (!TuyaDevice) {
      this.log.error('homebridge-homemate: tuyapi is not installed. Run: npm install tuyapi');
      return;
    }

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
    if (this.config.ip) deviceOptions.ip = String(this.config.ip).trim();
    if (this.config.port) deviceOptions.port = Number(this.config.port);

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
      if (!data || !data.dps) return;
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

  // ─── State → HomeKit ────────────────────────────────────────────────────────

  _updateState(dps) {
    const { Characteristic } = this;
    for (const [dpStr, value] of Object.entries(dps)) {
      this.state[parseInt(dpStr, 10)] = value;
    }

    if (dps[this.dpSwitch] !== undefined) {
      this.outletService.updateCharacteristic(Characteristic.On, !!dps[this.dpSwitch]);
      this.outletService.updateCharacteristic(Characteristic.OutletInUse, this._inUse());
    }
    if (dps[this.dpPower] !== undefined) {
      this.outletService.updateCharacteristic(this.Eve.CurrentConsumption, Math.max(0, Number(dps[this.dpPower]) / 10));
      this.outletService.updateCharacteristic(Characteristic.OutletInUse, this._inUse());
    }
    if (dps[this.dpVoltage] !== undefined) {
      this.outletService.updateCharacteristic(this.Eve.Voltage, Math.max(0, Number(dps[this.dpVoltage]) / 10));
    }
    if (dps[this.dpCurrent] !== undefined) {
      this.outletService.updateCharacteristic(this.Eve.ElectricCurrent, Math.max(0, Number(dps[this.dpCurrent]) / 1000));
    }
    if (dps[this.dpEnergy] !== undefined) {
      this.outletService.updateCharacteristic(this.Eve.TotalConsumption, Math.max(0, Number(dps[this.dpEnergy]) / 100));
    }
  }

  // ─── Control ────────────────────────────────────────────────────────────────

  async _setOn(value) {
    const on = !!value;
    this.log.info(`[${this.config.name}] Set plug DP ${this.dpSwitch} -> ${on}`);
    if (this.state[this.dpSwitch] === on) return;
    await this._sendDps({ [this.dpSwitch]: on });
  }

  async _sendDps(dps) {
    if (!this.device || !this._connected) {
      this.log.warn(`[${this.config.name}] Device not connected, cannot send DPS.`);
      return;
    }
    this._commandQueue = this._commandQueue.catch(() => {}).then(() => this._writeDps(dps));
    return this._commandQueue;
  }

  async _writeDps(dps) {
    const normalized = {};
    for (const [dp, value] of Object.entries(dps)) normalized[String(dp)] = value;

    this.log.debug(`[${this.config.name}] Sending DPS:`, JSON.stringify(normalized));
    try {
      await this.device.set({ multiple: true, data: normalized, shouldWaitForResponse: false });
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

module.exports = SmartPlugAccessory;

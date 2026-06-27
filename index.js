'use strict';

const HomeMate3Plus1Accessory = require('./accessories/HomeMate3Plus1Accessory');
const RGBTWLightV2Accessory   = require('./accessories/RGBTW');
const SmartPlugAccessory      = require('./accessories/SmartPlug');
const TuyaDiscovery           = require('./lib/TuyaDiscovery');

const PLUGIN_NAME   = 'homebridge-homemate';
const PLATFORM_NAME = 'TuyaHomeMate';

const HOMEMATE_LIGHTS = [
  { name: 'Light 1', dp: 1 },
  { name: 'Light 2', dp: 2 },
  { name: 'Light 3', dp: 3 },
];

const HOMEMATE_FAN = {
  name: 'Fan',
  dpSwitch: 101,
  dpSpeed: 102,
  speedValues: ['level_1', 'level_2', 'level_3', 'level_4'],
};

// Fixed device capabilities ("properties") per supported device type, so a user
// only has to enter a name, device id and local key. Any value here can still be
// overridden per device in the advanced JSON config.
const WIPRO_BATTEN_DEFAULTS = {
  dpPower: 20, dpMode: 21, dpBrightness: 22, dpColorTemperature: 23, dpColor: 24,
  colorFunction: 'HSB', scaleBrightness: 10, scaleWhiteColor: 10,
  minWhiteColor: 10, maxWhiteColor: 1000,
};
const WIPRO_PLUG_DEFAULTS = {
  dpSwitch: 1, dpCurrent: 18, dpPower: 19, dpVoltage: 20, dpEnergy: 17,
};

// type → { class, version, fixedVersion, defaults }
const TYPE_PROFILES = {
  homemate:     { class: HomeMate3Plus1Accessory, version: '3.3', fixedVersion: true,  defaults: { lights: HOMEMATE_LIGHTS, fan: HOMEMATE_FAN } },
  smartplug:    { class: SmartPlugAccessory,       version: '3.3', fixedVersion: true,  defaults: WIPRO_PLUG_DEFAULTS },
  batten:       { class: RGBTWLightV2Accessory,    version: '3.4', fixedVersion: true,  defaults: WIPRO_BATTEN_DEFAULTS },
  // Legacy generic RGBTW v2 type: version comes from config/discovery.
  rgbtwlightv2: { class: RGBTWLightV2Accessory,    version: '3.3', fixedVersion: false, defaults: {} },
};
// Friendly aliases.
TYPE_PROFILES.wiprosmartplug = TYPE_PROFILES.smartplug;
TYPE_PROFILES.outlet         = TYPE_PROFILES.smartplug;
TYPE_PROFILES.plug           = TYPE_PROFILES.smartplug;
TYPE_PROFILES.wiprobatten    = TYPE_PROFILES.batten;

module.exports = (homebridge) => {
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TuyaHomematePlatform);
};

class TuyaHomematePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];

    if (!config || !config.devices || !Array.isArray(config.devices)) {
      this.log.warn('No devices configured.');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.log.info('TuyaHomeMate platform launched.');
      this._initDevicesWithDiscovery();
    });
  }

  _initDevicesWithDiscovery() {
    const deviceMap = new Map();
    const deviceIds = [];

    for (const deviceConfig of this.config.devices) {
      if (!deviceConfig.id || !deviceConfig.key) {
        this.log.warn(`Device "${deviceConfig.name || 'Unknown'}" is missing id or key. Skipping.`);
        continue;
      }

      const id = ('' + deviceConfig.id).trim();
      const type = (deviceConfig.type || '').toLowerCase().trim() || 'homemate';
      const profile = TYPE_PROFILES[type] || null;
      const label = deviceConfig.name || `Device ${id.slice(-6)}`;

      // Resolve protocol version. Known types pin it; warn if a stale config
      // value disagrees so it cannot silently break control.
      let version;
      if (profile && profile.fixedVersion) {
        if (deviceConfig.version && ('' + deviceConfig.version).trim() !== profile.version) {
          this.log.warn(
            `[${label}] Ignoring configured protocol version "${deviceConfig.version}" ` +
            `for type "${type}"; using ${profile.version}.`
          );
        }
        version = profile.version;
      } else {
        version = deviceConfig.version ? ('' + deviceConfig.version).trim() : undefined;
      }

      // Fixed type defaults sit under any explicit per-device overrides.
      const defaults = (profile && profile.defaults) || {};

      deviceMap.set(id, {
        ...defaults,
        ...deviceConfig,
        id,
        // Optional override for the local Tuya id used in control writes; the
        // accessory falls back to `id` when this is unset.
        tuyaId: deviceConfig.tuyaId ? ('' + deviceConfig.tuyaId).trim() : undefined,
        key: String(deviceConfig.key),
        ip: deviceConfig.ip ? ('' + deviceConfig.ip).trim() : undefined,
        version,
        type,
        name: label,
        port: deviceConfig.port || 6668,
        sendEmptyUpdate: !!deviceConfig.sendEmptyUpdate,
        _class: profile ? profile.class : HomeMate3Plus1Accessory,
        _known: !!profile,
      });

      deviceIds.push(id);
    }

    if (deviceIds.length === 0) {
      this.log.warn('No valid devices configured.');
      return;
    }

    const configuredDevices = new Set();
    const discoveryDeviceIds = [];
    // Devices are discovered by the id they BROADCAST, which is the real local
    // gwId — i.e. `tuyaId` when set (it can differ from the HomeKit `id`, e.g. the
    // HomeMate panel). Map each broadcast id back to its configured id so a device
    // with no manual IP can still be found.
    const broadcastToConfigId = new Map();

    for (const deviceId of deviceIds) {
      const deviceConfig = deviceMap.get(deviceId);

      if (deviceConfig.ip) {
        if (!deviceConfig.version) deviceConfig.version = '3.3';

        this.log.info(
          `[${deviceConfig.name}] Configuring with manual IP ` +
          `(IP: ${deviceConfig.ip}, Version: ${deviceConfig.version})`
        );

        this._createAndRegisterAccessory(deviceConfig);
        configuredDevices.add(deviceId);
      } else {
        const broadcastId = deviceConfig.tuyaId || deviceConfig.id;
        broadcastToConfigId.set(broadcastId, deviceId);
        discoveryDeviceIds.push(broadcastId);
      }
    }

    if (discoveryDeviceIds.length === 0) {
      this.log.info('Device configuration complete.');
      return;
    }

    this.log.info(`Starting auto-discovery for ${discoveryDeviceIds.length} device(s)...`);

    TuyaDiscovery.start({ ids: discoveryDeviceIds, log: this.log })
      .on('discover', (discoveredDevice) => {
        const configId = broadcastToConfigId.get(discoveredDevice.id);

        if (!configId) {
          this.log.debug(`Discovered device ${discoveredDevice.id} not in config, ignoring.`);
          return;
        }
        if (configuredDevices.has(configId)) return;

        const deviceConfig = deviceMap.get(configId);
        const finalConfig = {
          ...deviceConfig,
          ...(!deviceConfig.ip && discoveredDevice.ip ? { ip: discoveredDevice.ip } : {}),
          ...(!deviceConfig.version && discoveredDevice.version ? { version: discoveredDevice.version } : {}),
        };

        this.log.info(
          `[${finalConfig.name}] Auto-discovered ` +
          `(IP: ${finalConfig.ip || 'unknown'}, Version: ${finalConfig.version || 'unknown'})`
        );

        this._createAndRegisterAccessory(finalConfig);
        configuredDevices.add(configId);
      });

    setTimeout(() => {
      for (const broadcastId of discoveryDeviceIds) {
        const deviceId = broadcastToConfigId.get(broadcastId);
        if (configuredDevices.has(deviceId)) continue;
        const deviceConfig = deviceMap.get(deviceId);

        if (!deviceConfig.ip) {
          this.log.warn(
            `[${deviceConfig.name}] Device not discovered after timeout and no manual IP provided. ` +
            `Please ensure the device is powered on and on the same network.`
          );
          continue;
        }
        if (!deviceConfig.version) deviceConfig.version = '3.3';

        this.log.info(
          `[${deviceConfig.name}] Configuring with manual settings ` +
          `(IP: ${deviceConfig.ip}, Version: ${deviceConfig.version})`
        );
        this._createAndRegisterAccessory(deviceConfig);
        configuredDevices.add(deviceId);
      }
      this.log.info('Device configuration complete.');
    }, this.config.discoverTimeout ?? 60000);
  }

  _createAndRegisterAccessory(deviceConfig) {
    const AccessoryClass = deviceConfig._class || HomeMate3Plus1Accessory;

    if (!deviceConfig._known && deviceConfig.type && deviceConfig.type !== 'homemate') {
      this.log.warn(`[${deviceConfig.name}] Unknown type "${deviceConfig.type}" — using HomeMate 3+1.`);
    }
    this.log.info(`[${deviceConfig.name}] Initialising as type: ${deviceConfig.type}`);

    const acc = new AccessoryClass(this.log, deviceConfig, this.api);
    this.accessories.push(acc);
    this.api.publishExternalAccessories(PLUGIN_NAME, [acc.accessory]);
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

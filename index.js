'use strict';

const HomeMate3Plus1Accessory = require('./accessories/HomeMate3Plus1Accessory');
const RGBTWLightV2Accessory   = require('./accessories/RGBTW');
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

// Add new device types here as you build them
const CLASS_DEF = {
  rgbtwlightv2: RGBTWLightV2Accessory,
};

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
    // Build device map from config for quick lookup
    const deviceMap = new Map();
    const deviceIds = [];
    
    for (const deviceConfig of this.config.devices) {
      if (!deviceConfig.id || !deviceConfig.key) {
        this.log.warn(`Device "${deviceConfig.name || 'Unknown'}" is missing id or key. Skipping.`);
        continue;
      }

      const id = ('' + deviceConfig.id).trim();
      const type = (deviceConfig.type || '').toLowerCase().trim() || 'homemate';
      const isHomeMate = type === 'homemate';

      if (isHomeMate && deviceConfig.version) {
        this.log.warn(
          `[${deviceConfig.name || `Device ${id.slice(-6)}`}] Ignoring configured HomeMate protocol version ` +
          `"${deviceConfig.version}". HomeMate 3+1 uses discovery/default protocol handling.`
        );
      }

      deviceMap.set(id, {
        ...deviceConfig,
        // Normalize values
        id,
        key: String(deviceConfig.key),
        ip: deviceConfig.ip ? ('' + deviceConfig.ip).trim() : undefined,
        version: isHomeMate ? undefined : (deviceConfig.version ? ('' + deviceConfig.version).trim() : undefined),
        type,
        name: deviceConfig.name || `Device ${id.slice(-6)}`,
        port: deviceConfig.port || 6668,
        lights: deviceConfig.lights || HOMEMATE_LIGHTS,
        fan: deviceConfig.fan || HOMEMATE_FAN,
        sendEmptyUpdate: isHomeMate ? false : !!deviceConfig.sendEmptyUpdate,
        dpPower: deviceConfig.dpPower,
        dpBrightness: deviceConfig.dpBrightness,
        dpColorTemperature: deviceConfig.dpColorTemperature,
        dpColor: deviceConfig.dpColor,
      });
      
      deviceIds.push(id);
    }

    if (deviceIds.length === 0) {
      this.log.warn('No valid devices configured.');
      return;
    }

    const configuredDevices = new Set();
    const discoveryResults = new Map();
    const discoveryDeviceIds = [];

    for (const deviceId of deviceIds) {
      const deviceConfig = deviceMap.get(deviceId);

      if (deviceConfig.ip) {
        if (!deviceConfig.version) {
          deviceConfig.version = '3.3';
        }

        this.log.info(
          `[${deviceConfig.name}] Configuring with manual IP ` +
          `(IP: ${deviceConfig.ip}, Version: ${deviceConfig.version})`
        );

        this._createAndRegisterAccessory(deviceConfig);
        configuredDevices.add(deviceId);
      } else {
        discoveryDeviceIds.push(deviceId);
      }
    }

    if (discoveryDeviceIds.length === 0) {
      this.log.info('Device configuration complete.');
      return;
    }

    this.log.info(`Starting auto-discovery for ${discoveryDeviceIds.length} device(s)...`);

    // Start discovery
    TuyaDiscovery.start({ 
      ids: discoveryDeviceIds,
      log: this.log
    })
    .on('discover', (discoveredDevice) => {
      const deviceId = discoveredDevice.id;
      
      if (!deviceMap.has(deviceId)) {
        this.log.debug(`Discovered device ${deviceId} not in config, ignoring.`);
        return;
      }

      if (configuredDevices.has(deviceId)) {
        // Already configured (either manually or via previous discovery)
        return;
      }

      const deviceConfig = deviceMap.get(deviceId);
      
      // Merge discovered data with config (discovered takes precedence for missing fields)
      const finalConfig = {
        ...deviceConfig,
        // Use discovered IP if we don't have manual IP
        ...(!deviceConfig.ip && discoveredDevice.ip ? { ip: discoveredDevice.ip } : {}),
        // Use discovered version if we don't have manual version
        ...(!deviceConfig.version && discoveredDevice.version ? { version: discoveredDevice.version } : {}),
      };

      this.log.info(
        `[${finalConfig.name}] ${deviceConfig.ip ? 'Using manual IP' : 'Auto-discovered IP'} ` +
        `${deviceConfig.version ? 'using manual version' : 'auto-detected version'} ` +
        `(IP: ${finalConfig.ip || 'unknown'}, Version: ${finalConfig.version || 'unknown'})`
      );

      this._createAndRegisterAccessory(finalConfig);
      configuredDevices.add(deviceId);
      discoveryResults.set(deviceId, finalConfig);
    });

    // Handle timeout - configure any remaining devices with manual settings
    setTimeout(() => {
      for (const deviceId of discoveryDeviceIds) {
        if (!configuredDevices.has(deviceId)) {
          const deviceConfig = deviceMap.get(deviceId);
          
          // Check if we have minimum required info
          if (!deviceConfig.ip) {
            this.log.warn(
              `[${deviceConfig.name}] Device not discovered after timeout and no manual IP provided. ` +
              `Please ensure device is powered on and connected to network.`
            );
            continue;
          }
          
          if (!deviceConfig.version) {
            this.log.warn(
              `[${deviceConfig.name}] Device not discovered after timeout and no manual version provided. ` +
              `Defaulting to version 3.3.`
            );
            deviceConfig.version = '3.3';
          }

          this.log.info(
            `[${deviceConfig.name}] Configuring with manual settings ` +
            `(IP: ${deviceConfig.ip}, Version: ${deviceConfig.version || '3.3'})`
          );
          
          this._createAndRegisterAccessory(deviceConfig);
          configuredDevices.add(deviceId);
        }
      }
      
      this.log.info(`Device configuration complete.`);
    }, this.config.discoverTimeout ?? 60000); // Default 60 second timeout
  }

  _createAndRegisterAccessory(deviceConfig) {
    const type = deviceConfig.type || 'homemate';
    
    if (type && CLASS_DEF[type]) {
      // ── Tuya-style accessory (RGBTW bulb etc.) ──
      this.log.info(`[${deviceConfig.name}] Initialising as type: ${type}`);
      const AccessoryClass = CLASS_DEF[type];
      const acc = new AccessoryClass(this.log, deviceConfig, this.api);
      this.accessories.push(acc);
      this.api.publishExternalAccessories(PLUGIN_NAME, [acc.accessory]);
    } else {
      // ── Default: HomeMate 3+1 panel ──
      const typeToLog = type && type !== 'homemate' ? type : 'homemate';
      if (type && type !== 'homemate') {
        this.log.warn(`[${deviceConfig.name}] Unknown type "${type}" — falling back to HomeMate 3+1`);
      }
      
      const fullConfig = {
        ...deviceConfig,
        version: deviceConfig.version || '3.3',
        lights: deviceConfig.lights || HOMEMATE_LIGHTS,
        fan:    deviceConfig.fan    || HOMEMATE_FAN,
      };
      
      const acc = new HomeMate3Plus1Accessory(this.log, fullConfig, this.api);
      this.accessories.push(acc);
      this.api.publishExternalAccessories(PLUGIN_NAME, [acc.accessory]);
    }
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

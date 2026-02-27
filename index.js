'use strict';

const HomeMate3Plus1Accessory = require('./accessories/HomeMate3Plus1Accessory');

const PLUGIN_NAME = 'homebridge-tuya-homemate';
const PLATFORM_NAME = 'TuyaHomeMate';

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
      this._initDevices();
    });
  }

  _initDevices() {
    for (const deviceConfig of this.config.devices) {
      if (!deviceConfig.id || !deviceConfig.key || !deviceConfig.ip) {
        this.log.warn(`Device "${deviceConfig.name}" is missing id, key, or ip. Skipping.`);
        continue;
      }
      const acc = new HomeMate3Plus1Accessory(this.log, deviceConfig, this.api);
      this.accessories.push(acc);
      this.api.publishExternalAccessories(PLUGIN_NAME, [acc.accessory]);
    }
  }

  configureAccessory(accessory) {
    // Called for cached accessories — not heavily used here since we publish external
    this.accessories.push(accessory);
  }
}

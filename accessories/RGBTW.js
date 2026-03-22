'use strict';

/**
 * RGBTWLightV2Accessory
 *
 * For Tuya bulbs using the v2 data point schema:
 *   DP 20  switch_led        (bool)
 *   DP 21  work_mode         (enum: "white" | "colour" | "scene" | "music")
 *   DP 22  bright_value_v2   (integer 10–1000)
 *   DP 23  temp_value_v2     (integer 0–1000)
 *   DP 24  colour_data_v2    (JSON string: {"h":0–360,"s":0–1000,"v":0–1000})
 *
 * The key difference from RGBTWLightAccessory:
 *   OLD format  →  hex string  "000003e803e8"   (hhhh ssss vvvv)
 *   NEW format  →  JSON string '{"h":0,"s":1000,"v":1000}'
 *
 * Homebridge config example:
 * {
 *   "name": "Colour Bulb",
 *   "id": "YOUR_DEVICE_ID",
 *   "key": "YOUR_LOCAL_KEY",
 *   "ip":  "192.168.x.x",
 *   "version": "3.3",
 *   "type": "rgbtwlightv2",
 *   "dpPower": "20",
 *   "dpMode":  "21",
 *   "dpBrightness": "22",
 *   "dpColorTemperature": "23",
 *   "dpColor": "24"
 * }
 */

const BaseAccessory = require('./BaseAccessory');
const async = require('async');

class RGBTWLightV2Accessory extends BaseAccessory {
    static getCategory(Categories) { return Categories.LIGHTBULB; }
    constructor(...props) { super(...props); }

    _registerPlatformAccessory() {
        const { Service } = this.hap;
        this.accessory.addService(Service.Lightbulb, this.device.context.name);
        super._registerPlatformAccessory();
    }

    _registerCharacteristics(dps) {
        const { Service, Characteristic, AdaptiveLightingController } = this.hap;
        const service = this.accessory.getService(Service.Lightbulb);
        this._checkServiceName(service, this.device.context.name);

        // ── DP mapping — defaults match the v2 schema ──
        this.dpPower            = this._getCustomDP(this.device.context.dpPower)            || '20';
        this.dpMode             = this._getCustomDP(this.device.context.dpMode)             || '21';
        this.dpBrightness       = this._getCustomDP(this.device.context.dpBrightness)       || '22';
        this.dpColorTemperature = this._getCustomDP(this.device.context.dpColorTemperature) || '23';
        this.dpColor            = this._getCustomDP(this.device.context.dpColor)            || '24';

        // v2 brightness range: 10–1000  (HomeKit: 1–100)
        this.minBright  = this.device.context.minBrightness  || 10;
        this.maxBright  = this.device.context.maxBrightness  || 1000;

        // v2 colour temperature range: 0–1000  (0=warm, 1000=cool)
        // Note: Tuya v2 temp is INVERTED relative to v1
        this.minTemp = this.device.context.minWhiteColor || 0;
        this.maxTemp = this.device.context.maxWhiteColor || 1000;

        this.cmdWhite = 'white';
        this.cmdColor = 'colour';

        // Parse initial colour state
        const initialColor = this._parseColorV2(dps[this.dpColor]);
        const isWhite = dps[this.dpMode] === this.cmdWhite;

        // ── On/Off ──
        const characteristicOn = service.getCharacteristic(Characteristic.On)
            .updateValue(dps[this.dpPower])
            .on('get', this.getState.bind(this, this.dpPower))
            .on('set', this.setState.bind(this, this.dpPower));

        // ── Brightness ──
        const characteristicBrightness = service.getCharacteristic(Characteristic.Brightness)
            .updateValue(isWhite
                ? this._brightTuyaToHK(dps[this.dpBrightness])
                : initialColor.b)
            .on('get', this.getBrightness.bind(this))
            .on('set', this.setBrightness.bind(this));

        // ── Color Temperature ──
        const characteristicColorTemperature = service.getCharacteristic(Characteristic.ColorTemperature)
            .setProps({ minValue: 140, maxValue: 500 })
            .updateValue(isWhite
                ? this._tempTuyaToHK(dps[this.dpColorTemperature])
                : 370)
            .on('get', this.getColorTemperature.bind(this))
            .on('set', this.setColorTemperature.bind(this));

        // ── Hue ──
        const characteristicHue = service.getCharacteristic(Characteristic.Hue)
            .updateValue(isWhite ? 0 : initialColor.h)
            .on('get', this.getHue.bind(this))
            .on('set', this.setHue.bind(this));

        // ── Saturation ──
        const characteristicSaturation = service.getCharacteristic(Characteristic.Saturation)
            .updateValue(isWhite ? 0 : initialColor.s)
            .on('get', this.getSaturation.bind(this))
            .on('set', this.setSaturation.bind(this));

        // Store refs for cross-characteristic updates
        this.characteristicHue              = characteristicHue;
        this.characteristicSaturation       = characteristicSaturation;
        this.characteristicColorTemperature = characteristicColorTemperature;
        this.characteristicBrightness       = characteristicBrightness;

        // ── Adaptive Lighting ──
        if (this.adaptiveLightingSupport()) {
            this.adaptiveLightingController = new AdaptiveLightingController(service);
            this.accessory.configureController(this.adaptiveLightingController);
            this.accessory.adaptiveLightingController = this.adaptiveLightingController;
        }

        // ── Device state changes → update HomeKit ──
        this.device.on('change', (changes, state) => {
            if (changes.hasOwnProperty(this.dpPower) && characteristicOn.value !== changes[this.dpPower]) {
                characteristicOn.updateValue(changes[this.dpPower]);
            }

            const mode = state[this.dpMode];

            if (mode === this.cmdWhite) {
                // White mode updates
                if (changes.hasOwnProperty(this.dpBrightness)) {
                    const hkBright = this._brightTuyaToHK(changes[this.dpBrightness]);
                    if (characteristicBrightness.value !== hkBright)
                        characteristicBrightness.updateValue(hkBright);
                }
                if (changes.hasOwnProperty(this.dpColorTemperature)) {
                    const hkTemp = this._tempTuyaToHK(changes[this.dpColorTemperature]);
                    const hkColor = this.convertHomeKitColorTemperatureToHomeKitColor(hkTemp);
                    characteristicHue.updateValue(hkColor.h);
                    characteristicSaturation.updateValue(hkColor.s);
                    characteristicColorTemperature.updateValue(hkTemp);
                } else if (changes[this.dpMode]) {
                    // Just switched to white mode — refresh temp
                    const hkTemp = this._tempTuyaToHK(state[this.dpColorTemperature]);
                    const hkColor = this.convertHomeKitColorTemperatureToHomeKitColor(hkTemp);
                    characteristicHue.updateValue(hkColor.h);
                    characteristicSaturation.updateValue(hkColor.s);
                    characteristicColorTemperature.updateValue(hkTemp);
                }
            } else {
                // Colour mode updates
                if (changes.hasOwnProperty(this.dpColor)) {
                    const newColor = this._parseColorV2(changes[this.dpColor]);
                    if (characteristicBrightness.value !== newColor.b)
                        characteristicBrightness.updateValue(newColor.b);
                    if (characteristicHue.value !== newColor.h)
                        characteristicHue.updateValue(newColor.h);
                    if (characteristicSaturation.value !== newColor.s)
                        characteristicSaturation.updateValue(newColor.s);
                    if (characteristicColorTemperature.value !== 370)
                        characteristicColorTemperature.updateValue(370);
                } else if (changes[this.dpMode]) {
                    if (characteristicColorTemperature.value !== 370)
                        characteristicColorTemperature.updateValue(370);
                }
            }
        });
    }

    // ══════════════════════════════════════
    //  CONVERSION HELPERS — v2 specific
    // ══════════════════════════════════════

    /** Parse colour_data_v2 JSON string → {h, s, b} in HomeKit ranges */
    _parseColorV2(raw) {
        if (!raw) return { h: 0, s: 100, b: 100 };
        try {
            const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return {
                h: Math.round(obj.h || 0),                          // 0–360 (same in both)
                s: Math.round((obj.s || 0) / 10),                   // 0–1000 → 0–100
                b: Math.round((obj.v || 0) / 10),                   // 0–1000 → 0–100
            };
        } catch {
            return { h: 0, s: 100, b: 100 };
        }
    }

    /** Build colour_data_v2 JSON string from {h, s, b} HomeKit values */
    _buildColorV2(h, s, b) {
        return JSON.stringify({
            h: Math.round(h),           // 0–360
            s: Math.round(s * 10),      // 0–100 → 0–1000
            v: Math.round(b * 10),      // 0–100 → 0–1000
        });
    }

    /** bright_value_v2 (10–1000) → HomeKit brightness (1–100) */
    _brightTuyaToHK(value) {
        const v = Math.max(this.minBright, Math.min(this.maxBright, value || this.minBright));
        return Math.max(1, Math.round((v - this.minBright) / (this.maxBright - this.minBright) * 99 + 1));
    }

    /** HomeKit brightness (1–100) → bright_value_v2 (10–1000) */
    _brightHKToTuya(value) {
        const v = Math.max(1, Math.min(100, value));
        return Math.round((v - 1) / 99 * (this.maxBright - this.minBright) + this.minBright);
    }

    /**
     * temp_value_v2 (0–1000) → HomeKit color temperature (140–500 mireds)
     * Tuya v2: 0 = warm white, 1000 = cool white
     * HomeKit: 140 mireds = cool (6500K), 500 mireds = warm (2700K)
     * So they are INVERTED — 0 Tuya → 500 HomeKit, 1000 Tuya → 140 HomeKit
     */
    _tempTuyaToHK(value) {
        const v = Math.max(0, Math.min(1000, value || 0));
        // Invert: Tuya 0 (warm) → HomeKit 500 (warm), Tuya 1000 (cool) → HomeKit 140 (cool)
        return Math.round(500 - (v / 1000) * (500 - 140));
    }

    /** HomeKit color temperature (140–500 mireds) → temp_value_v2 (0–1000) */
    _tempHKToTuya(value) {
        const v = Math.max(140, Math.min(500, value));
        // Invert: HomeKit 500 (warm) → Tuya 0, HomeKit 140 (cool) → Tuya 1000
        return Math.round((500 - v) / (500 - 140) * 1000);
    }

    // ══════════════════════════════════════
    //  CHARACTERISTIC HANDLERS
    // ══════════════════════════════════════

    getBrightness(callback) {
        if (this.device.state[this.dpMode] === this.cmdWhite) {
            return callback(null, this._brightTuyaToHK(this.device.state[this.dpBrightness]));
        }
        callback(null, this._parseColorV2(this.device.state[this.dpColor]).b);
    }

    setBrightness(value, callback) {
        if (this.device.state[this.dpMode] === this.cmdWhite) {
            return this.setState(this.dpBrightness, this._brightHKToTuya(value), callback);
        }
        // Colour mode — update v value inside JSON
        const current = this._parseColorV2(this.device.state[this.dpColor]);
        const newColorStr = this._buildColorV2(current.h, current.s, value);
        this.setState(this.dpColor, newColorStr, callback);
    }

    getColorTemperature(callback) {
        if (this.device.state[this.dpMode] !== this.cmdWhite) return callback(null, 370);
        callback(null, this._tempTuyaToHK(this.device.state[this.dpColorTemperature]));
    }

    setColorTemperature(value, callback) {
        const hkColor = this.convertHomeKitColorTemperatureToHomeKitColor(value);
        this.characteristicHue.updateValue(hkColor.h);
        this.characteristicSaturation.updateValue(hkColor.s);
        this.setMultiState({
            [this.dpMode]: this.cmdWhite,
            [this.dpColorTemperature]: this._tempHKToTuya(value),
        }, callback);
    }

    getHue(callback) {
        if (this.device.state[this.dpMode] === this.cmdWhite) return callback(null, 0);
        callback(null, this._parseColorV2(this.device.state[this.dpColor]).h);
    }

    setHue(value, callback) { this._setHueSaturation({ h: value }, callback); }

    getSaturation(callback) {
        if (this.device.state[this.dpMode] === this.cmdWhite) return callback(null, 0);
        callback(null, this._parseColorV2(this.device.state[this.dpColor]).s);
    }

    setSaturation(value, callback) { this._setHueSaturation({ s: value }, callback); }

    /**
     * Batches hue + saturation changes together with a 500ms debounce.
     * HomeKit sends them as two separate calls — we wait for both before
     * writing to the device, otherwise the bulb flickers mid-transition.
     */
    _setHueSaturation(prop, callback) {
        if (!this._pendingHueSaturation) this._pendingHueSaturation = { props: {}, callbacks: [] };

        if (prop) {
            if (this._pendingHueSaturation.timer) clearTimeout(this._pendingHueSaturation.timer);
            this._pendingHueSaturation.props = { ...this._pendingHueSaturation.props, ...prop };
            this._pendingHueSaturation.callbacks.push(callback);
            this._pendingHueSaturation.timer = setTimeout(() => { this._setHueSaturation(); }, 500);
            return;
        }

        const callbacks = this._pendingHueSaturation.callbacks;
        const callEachBack = err => {
            async.eachSeries(callbacks, (cb, next) => {
                try { cb(err); } catch (ex) {}
                next();
            }, () => {
                this.characteristicColorTemperature.updateValue(370);
            });
        };

        const isSham = this._pendingHueSaturation.props.h === 0 && this._pendingHueSaturation.props.s === 0;
        const pending = this._pendingHueSaturation.props;
        this._pendingHueSaturation = null;

        // If in white mode and user didn't really pick a colour, skip
        if (this.device.state[this.dpMode] === this.cmdWhite && isSham) return callEachBack();

        // Merge pending hue/sat with current brightness from device state
        const current = this._parseColorV2(this.device.state[this.dpColor]);
        const h = pending.h !== undefined ? pending.h : current.h;
        const s = pending.s !== undefined ? pending.s : current.s;
        const b = current.b || 100;

        const newColorStr = this._buildColorV2(h, s, b);

        this.setMultiState({
            [this.dpMode]: this.cmdColor,
            [this.dpColor]: newColorStr,
        }, callEachBack);
    }
}

module.exports = RGBTWLightV2Accessory;

# homebridge-homemate

Homebridge plugin for local LAN control of HomeMate 3+1 Tuya switch/fan panels.

The main supported accessory is a HomeMate wall panel with:

| DP | Type | Description |
| --- | --- | --- |
| 1 | boolean | Light switch 1 |
| 2 | boolean | Light switch 2 |
| 3 | boolean | Light switch 3 |
| 101 | boolean | Fan on/off |
| 102 | enum | Fan speed |

The three lights appear as individual HomeKit Switch services. The fan appears as a Fan service with an on/off control and a rotation-speed slider.

## What Changed In 1.1.7

Version 1.1.7 keeps the Homebridge UI simple for the fixed HomeMate 3+1 panel: add the device name, Tuya device ID, and local key. The plugin handles discovery, protocol version, and the known HomeMate DP map internally, ignores stale hidden HomeMate `version` overrides left behind by older configs, and skips discovery entirely when a manual IP is configured.

HomeMate 3+1 DPS writes use TuyAPI, matching the last known-good 1.0.7 command path, but local keys are still treated as raw strings and write calls do not wait for a status acknowledgement from devices that ignore the response.

Local keys are treated as raw strings. Keys containing symbols are supported and must be entered exactly as provided.

## Compatibility

- Homebridge: `^1.8.0` or `^2.0.0`
- Node.js: `^22.12.0` or `^24.0.0`
- Tuya LAN protocol version for HomeMate 3+1: `3.3` by default

## Installation

```bash
npm install -g homebridge-homemate
```

Or install `homebridge-homemate` from the Homebridge UI.

## Getting Device Details

You need:

- Tuya device ID
- Tuya local key

Use the Tuya IoT platform, a supported local key tool, or your existing Homebridge/Tuya workflow to obtain the ID and key.

Important: do not trim, escape, convert, or validate the local key as hex. Tuya local keys can contain symbols such as quotes, angle brackets, ampersands, and backticks.

## Configuration

```json
{
  "platforms": [
    {
      "platform": "TuyaHomeMate",
      "name": "TuyaHomeMate",
      "devices": [
        {
          "name": "Living Room Panel",
          "id": "YOUR_DEVICE_ID",
          "key": "YOUR_LOCAL_KEY"
        }
      ]
    }
  ]
}
```

## Config Options

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Display name in HomeKit. |
| `id` | Yes | Tuya device ID. |
| `key` | Yes | Tuya local key, used exactly as entered. |

Advanced JSON overrides such as `ip`, `port`, `lights`, and `fan` are still accepted by the code for troubleshooting, but they are intentionally not shown in the Homebridge UI. For HomeMate 3+1 panels, old `version` overrides are ignored so stale values such as `3.1` cannot break writes.

## Troubleshooting

### Device reads state but commands do not work

Remove any old HomeMate `version` entry from `config.json` if you edited it manually. The plugin ignores stale HomeMate protocol overrides and will use discovery/default protocol handling instead.

For this HomeMate panel, the expected cloud property mapping is:

| Code | DP | Value type |
| --- | --- | --- |
| `switch_1` | 1 | boolean |
| `switch_2` | 2 | boolean |
| `switch_3` | 3 | boolean |
| `switch_fan` | 101 | boolean |
| `fan_speed_enum` | 102 | enum, usually `level_1` to `level_4` |

If your Tuya Cloud properties show different DPs or speed enum strings, update the plugin config to match.

### Device does not connect

- Confirm the IP address is correct and reachable from the Homebridge host.
- Confirm the device is on the same LAN/VLAN as Homebridge.
- Confirm the local key is current. Re-adding the device to Tuya/HomeMate changes the local key.
- Enter symbol keys exactly as provided. Do not add escaping unless JSON itself requires it.

### Fan speed jumps around

HomeKit often sends multiple speed writes while dragging the slider. The plugin debounces speed-only writes and sends the final requested speed, while fan on/off and light switch commands are sent immediately.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT

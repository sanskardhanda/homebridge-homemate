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

## What Changed In 1.1.2

Version 1.1.2 uses an internal Tuya LAN client for the HomeMate panel instead of relying on `tuyapi.set()` acknowledgements. This matters for HomeMate/Tuya panels that read state correctly but do not reliably return the status response expected by `tuyapi` after a command.

The LAN client sends raw Tuya control frames:

| Protocol | Control command |
| --- | --- |
| 3.1 / 3.2 / 3.3 | DP update command 7 |
| 3.4 / 3.5 | DP update command 13 with protocol wrapper |

Local keys are treated as raw strings. Keys containing symbols are supported and must be entered exactly as provided.

## Compatibility

- Homebridge: `^1.8.0` or `^2.0.0`
- Node.js: `^22.12.0` or `^24.0.0`
- Tuya LAN protocol versions: `3.1`, `3.2`, `3.3`, `3.4`, `3.5`

## Installation

```bash
npm install -g homebridge-homemate
```

Or install `homebridge-homemate` from the Homebridge UI.

## Getting Device Details

You need:

- Tuya device ID
- Tuya local key
- Device LAN IP address, or auto-discovery on the same network
- Tuya protocol version, auto-detected by default unless you set it manually

Use the Tuya IoT platform, a supported local key tool, or your existing Homebridge/Tuya workflow to obtain the ID and key. Reserve the device IP in your router so it does not change.

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
          "type": "homemate",
          "name": "Living Room Panel",
          "id": "YOUR_DEVICE_ID",
          "key": "YOUR_LOCAL_KEY",
          "ip": "192.168.1.123",
          "manufacturer": "HomeMate",
          "model": "3+1 Wall Switch",
          "lights": [
            { "name": "Main Light", "dp": 1 },
            { "name": "Side Light", "dp": 2 },
            { "name": "Accent Light", "dp": 3 }
          ],
          "fan": {
            "name": "Ceiling Fan",
            "dpSwitch": 101,
            "dpSpeed": 102,
            "speedValues": ["level_1", "level_2", "level_3", "level_4"]
          }
        }
      ]
    }
  ]
}
```

## Config Options

| Field | Required | Description |
| --- | --- | --- |
| `type` | No | Use `homemate` for the HomeMate 3+1 panel. Defaults to `homemate`. |
| `name` | Yes | Display name in HomeKit. |
| `id` | Yes | Tuya device ID. |
| `key` | Yes | Tuya local key, used exactly as entered. |
| `ip` | No | Device LAN IP address. If omitted, auto-discovery will try to find it. |
| `port` | No | Tuya LAN port. Defaults to `6668`. |
| `version` | No | Tuya protocol version: `3.1`, `3.2`, `3.3`, `3.4`, or `3.5`. Leave blank for auto-detection. |
| `sendEmptyUpdate` | No | Sends an empty follow-up control frame after DP writes. Leave off unless your device specifically needs it. |
| `lights` | No | Array of `{ "name": "...", "dp": 1 }` switch definitions. Defaults to DP 1, 2, and 3. |
| `fan.dpSwitch` | No | Fan on/off DP. Defaults to `101`. |
| `fan.dpSpeed` | No | Fan speed enum DP. Defaults to `102`. |
| `fan.speedValues` | No | Speed enum values from slow to fast. Defaults to `["level_1","level_2","level_3","level_4"]`. |

## Troubleshooting

### Device reads state but commands do not work

Check the configured `version` first. Reads and writes use different Tuya LAN commands on newer protocol versions, so a device can appear readable while rejecting control frames if the version is wrong.

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

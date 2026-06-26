# homebridge-homemate

Homebridge plugin for local (cloud-free) LAN control of Tuya / Wipro devices. The data-point map and protocol version are built in for each supported type, so a device only needs a name, id and local key.

## Supported device types

Set `type` per device. The default is `homemate`.

| `type` | Device | HomeKit |
| --- | --- | --- |
| `homemate` | HomeMate 3+1 switch/fan panel | 3 Switches + a Fan (on/off + speed) |
| `smartplug` | Wipro / Tuya metering plug | Outlet (on/off, "in use") + Eve power/voltage/current/energy |
| `batten` | Wipro / Tuya RGBTW light (protocol 3.4) | Lightbulb (on/off, brightness, colour temperature, hue/saturation) |

The HomeMate 3+1 panel uses fixed data points: lights on DP 1/2/3, fan on DP 101, fan speed (enum) on DP 102. The lights appear as individual Switch services; the fan as a Fan service with an on/off control and a rotation-speed slider.

### Smart plug energy

The Apple Home app does not display power or energy for outlets — it shows only on/off and "in use". This plugin still publishes consumption (W), voltage (V), current (A) and total energy (kWh) as Eve-compatible custom characteristics, so they appear in apps that read them (Eve, Controller for HomeKit). Metering scaling assumes the common Tuya convention (power and voltage ÷10, current ÷1000); adjust per device if your readings look off.

## What Changed In 1.2.0

Version 1.2.0 adds the `smartplug` and `batten` device types and fixes RGBTW colour: `colour_data` is now the 12-hex `HHHHSSSSVVVV` (HSB) string the devices actually use, instead of JSON — which is what made the colour shown differ from the colour selected.

## What Changed In 1.1.8

Version 1.1.8 adds an optional `tuyaId` override for the case where a device reports state correctly but ignores control after its local Tuya ID changed (e.g. re-pairing in Smart Life). See [Troubleshooting](#device-reads-state-but-commands-do-not-work).

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
        },
        {
          "name": "Wipro Smart Plug",
          "type": "smartplug",
          "id": "PLUG_DEVICE_ID",
          "key": "PLUG_LOCAL_KEY"
        },
        {
          "name": "Wipro Batten",
          "type": "batten",
          "id": "BATTEN_DEVICE_ID",
          "key": "BATTEN_LOCAL_KEY"
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
| `type` | No | `homemate` (default), `smartplug`, or `batten`. Picks the built-in DP map and protocol version. |
| `id` | Yes | Tuya device ID. Drives the HomeKit identity. |
| `key` | Yes | Tuya local key, used exactly as entered. |
| `ip` | No | Device IP. Leave blank to auto-discover; set a reserved IP for the most reliable control. |
| `tuyaId` | No | Current local Tuya ID (`gwId`) for LAN control. Set only if control fails while state still updates (see Troubleshooting). Falls back to `id`. |

Per-device advanced overrides (`port`, the various `dp*` numbers, `lights`, `fan`, and the light's `colorFunction` / `scale*` / `minWhiteColor` / `maxWhiteColor`) are accepted by the code but rarely needed, since each `type` ships a working map. Configured protocol `version` is ignored for known types, which pin their own version.

## Troubleshooting

### Device reads state but commands do not work

If HomeKit shows the correct state (physical on/off is reflected) but commands from the Home app do nothing, the most common cause is a **stale device ID**. Re-pairing the device in Smart Life / Tuya rotates **both** the local key **and** the device ID — if you only updated the key, the configured `id` no longer matches the device. Status reads still work (a status query is answered based on the local key), but control writes carry the old `id`, so the device accepts the packet and silently ignores it.

To fix it, find the device's current local ID (`gwId`) and set it as `tuyaId`:

```bash
python -m tinytuya scan      # shows each device's gwId, ip, and version
```

```json
{
  "name": "Living Room Panel",
  "id": "YOUR_DEVICE_ID",
  "tuyaId": "CURRENT_LOCAL_GWID",
  "key": "YOUR_LOCAL_KEY"
}
```

`tuyaId` is used only for LAN control; `id` still drives the HomeKit identity, so setting `tuyaId` avoids re-adding the accessory in the Home app. (You can instead just update `id` to the current value, but the accessory will be re-published and you will need to re-add it.) The log line `Using local Tuya id ... for control` confirms the override is active.

Also remove any old HomeMate `version` entry from `config.json` if you edited it manually. The plugin ignores stale HomeMate protocol overrides and will use discovery/default protocol handling instead.

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

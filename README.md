# homebridge-homemate

A Homebridge plugin to add local support for **HomeMate 3+1 switches** — 3 light switches + 1 fan with 4-speed control — devices that aren't supported by the main homebridge-tuya plugin.

This solves the problem described in [homebridge-tuya issue #311](https://github.com/iRayanKhan/homebridge-tuya/issues/311).

---

## How it works

Your HomeMate wall switch has these Data Points (DPs):

| DP  | Type    | Description          |
|-----|---------|----------------------|
| 1   | boolean | Light switch 1       |
| 2   | boolean | Light switch 2       |
| 3   | boolean | Light switch 3       |
| 101 | boolean | Fan on/off           |
| 102 | enum    | Fan speed (level_1–4)|

HomeKit doesn't have a native "4-speed fan enum" — so this plugin maps the enum to a **0–100% rotation speed slider** in Home app:

| Tuya value | HomeKit % |
|------------|-----------|
| level_1    | 25%       |
| level_2    | 50%       |
| level_3    | 75%       |
| level_4    | 100%      |

The 3 lights appear as individual **Switch** tiles. The fan appears as a **Fan** tile with an on/off toggle and speed slider.

---

## Installation

```bash
npm install -g homebridge-homemate
```

Or via Homebridge UI, search for `homebridge-homemate`.

---

## Prerequisites: Get Your Device ID and Local Key

You need your device's **ID** and **local key** to use local control. Follow the [instructions from homebridge-tuya](https://github.com/AMoo-Miki/homebridge-tuya-lan/wiki/Setup-Instructions).

The short version:
1. Set up the device in the Tuya Smart or Smart Life app
2. Use [tuyapi/cli](https://github.com/TuyaAPI/cli) or scan with [LocalTuya HACS addon](https://github.com/rospogrigio/localtuya) to get the ID and key
3. Find the device IP in your router's DHCP table (set a static lease so it doesn't change)

---

## Configuration

Add to your `config.json` (or use Homebridge UI):

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
          "key": "YOUR_LOCAL_KEY",
          "ip": "192.168.1.123",
          "version": "3.3",
          "manufacturer": "HomeMate",
          "model": "3+1 Wall Switch",
          "lights": [
            { "name": "Main Light",    "dp": 1 },
            { "name": "Side Light",    "dp": 2 },
            { "name": "Accent Light",  "dp": 3 }
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

### Config options

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✓ | Display name of the device in Home app |
| `id` | ✓ | Tuya device ID |
| `key` | ✓ | Local encryption key |
| `ip` | ✓ | Local IP address of the device |
| `version` | | Protocol version: `"3.1"`, `"3.2"`, `"3.3"` (default), `"3.4"` |
| `lights` | | Array of `{ name, dp }` for each light switch |
| `fan.name` | | Name for the fan accessory |
| `fan.dpSwitch` | | DP number for fan on/off (boolean) |
| `fan.dpSpeed` | | DP number for fan speed (enum) |
| `fan.speedValues` | | Array of enum strings from slow→fast. Default: `["level_1","level_2","level_3","level_4"]` |

---

## Different speed values?

Some devices use different strings. Check your device's actual DP values using:

```bash
npx @tuyapi/cli wizard
```

Or look at your Homebridge logs — when the device connects, all DP values are logged. Then update `speedValues` to match exactly what your device sends. For example some devices use `"1"`, `"2"`, `"3"`, `"4"` as plain numbers.

---

## Troubleshooting

**Device won't connect**
- Make sure the IP is correct and the device is on the same network as Homebridge
- Try setting a static DHCP lease for the device
- Check the protocol version (most new devices use `3.3`, some newer ones `3.4`)

**Fan shows wrong speed**
- Enable debug logging in Homebridge and check the raw DP values
- Update `speedValues` in your config to match exactly what your device reports

**Lights work but fan doesn't**
- Verify your `dpSwitch` and `dpSpeed` DPs using the Tuya app or tuyapi/cli

---

## Testing with your device

Since you have the device to test, here's how to verify DPs quickly:

```bash
# Install tuyapi/cli globally
npm install -g @tuyapi/cli

# Get device status (raw DPs)
npx @tuyapi/cli get --id YOUR_ID --key YOUR_KEY --ip 192.168.1.123

# Set a specific DP (e.g. turn on fan)
npx @tuyapi/cli set --id YOUR_ID --key YOUR_KEY --ip 192.168.1.123 --dps 101 --set true

# Set fan speed
npx @tuyapi/cli set --id YOUR_ID --key YOUR_KEY --ip 192.168.1.123 --dps 102 --set "level_2"
```

---

## License

MIT

# Changelog

All notable changes to this project are documented here.

## 1.2.2 - 2026-06-26

- Auto-discovery now matches a device by the local id it actually broadcasts (`tuyaId` when set), not just the configured `id`. A device whose broadcast gwId differs from its HomeKit `id` — e.g. the HomeMate panel after re-pairing — can now be found with no manual IP. Previously such a device silently failed to register if its IP was removed from the config (for example by editing it down to just id and key in the UI).

## 1.2.1 - 2026-06-26

- Smart plug now exposes a standard, HomeKit- and Matter-compliant Outlet (on/off + "in use") by default. The Eve power/voltage/current/energy characteristics are custom (non-standard) and could make Apple Home reject the accessory with a compatibility error, so they are now opt-in via `"exposeEnergy": true`.
- Documented Homebridge 2.x support and how these (standards-compliant) accessories relate to Matter.

## 1.2.0 - 2026-06-26

- Added a **Wipro Smart Plug** device type (`type: "smartplug"`): the socket appears as a HomeKit Outlet (on/off + "in use"), plus Eve-compatible power, voltage, current and total-energy characteristics. The stock Apple Home app shows only on/off; energy is visible in apps that read Eve characteristics (Eve, Controller for HomeKit).
- Added a **Wipro Batten** / RGBTW light device type (`type: "batten"`) on protocol 3.4.
- Fixed RGBTW colour handling: `colour_data` is now encoded/decoded as the 12-hex `HHHHSSSSVVVV` (HSB) string these devices actually use, instead of JSON. Sending/parsing JSON is what caused the colour shown to differ from the colour selected.
- Each supported device type now carries its data-point map and protocol version in code, so a device only needs a name, id and key (IP optional).

## 1.1.8 - 2026-06-26

- Added an optional `tuyaId` override so LAN control can target the device's current local Tuya ID while the HomeKit identity stays tied to the configured `id`. This fixes the case where status updates correctly but control is silently ignored after the device's ID changed (e.g. re-pairing in Smart Life rotates both the local key and the device ID). Control writes addressed to a stale device ID are accepted at the frame level but never actuate the relay.
- Logged which local Tuya ID is used for control when it differs from the configured ID.

## 1.1.7 - 2026-06-26

- Configured HomeMate devices with a manual IP immediately instead of starting UDP discovery first.

## 1.1.6 - 2026-06-26

- Restored the HomeMate 3+1 command path to TuyAPI, matching the last known-good 1.0.7 write behavior instead of the custom LAN sender.
- Kept symbol local keys as raw strings and sent HomeMate DPS writes without waiting for a status acknowledgement.

## 1.1.5 - 2026-06-26

- Ignored stale hidden `version` overrides for fixed HomeMate 3+1 panels so old configs such as `3.1` cannot break LAN writes after the UI was simplified.
- Disabled the experimental empty follow-up control write for HomeMate 3+1 panels.

## 1.1.4 - 2026-06-26

- Simplified the Homebridge UI schema for HomeMate 3+1 devices to only ask for device name, Tuya device ID, and local key.
- Kept fixed HomeMate DP defaults and advanced JSON overrides in code without exposing them as normal UI fields.

## 1.1.3 - 2026-06-26

- Made Tuya protocol version truly optional in the Homebridge UI schema so leaving it blank uses auto-detection.
- Updated the README example to omit manual `version` by default.

## 1.1.2 - 2026-06-26

- Matched HomeMate 3.3 control payloads to the `homebridge-tuya-plus` LAN sender by removing `gwId` from DP write commands.
- Stopped trimming configured Tuya local keys during platform setup.
- Restored the Tuya protocol version selector in the Homebridge UI schema.
- Fixed the v3.5 UDP discovery probe prefix.

## 1.1.1 - 2026-06-10

- Added UDP auto-discovery for Tuya LAN devices.
- Made IP optional when discovery can find the device.

## 1.1.0 - 2026-06-08

- Replaced the HomeMate command path with a direct Tuya LAN client so DP writes do not depend on `tuyapi.set()` status acknowledgements.
- Added Tuya LAN protocol 3.5 support alongside 3.1, 3.2, 3.3, and 3.4 framing.
- Preserved Tuya local keys as raw strings, including keys with symbols.
- Added queued HomeMate DP writes and a small fan-speed debounce to avoid slider command bursts.
- Moved the RGBTW v2 accessory onto the same LAN client.
- Added Homebridge 2 compatibility metadata.
- Expanded Homebridge UI schema fields for IP, port, protocol version, HomeMate DPs, and raw local-key guidance.

## 1.0.16 - 2026-06-08

- Kept the connection alive when a Tuya status response timed out after a write attempt.

## 1.0.15 - 2026-06-08

- Restored the 1.0.7-style HomeMate `device.set({ multiple: true, data })` send path.

## 1.0.14 and earlier

- Iterated on HomeMate DP send handling and local-key handling.

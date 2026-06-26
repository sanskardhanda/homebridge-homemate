# Changelog

All notable changes to this project are documented here.

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

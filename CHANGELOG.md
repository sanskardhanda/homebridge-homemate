# Changelog

All notable changes to this project are documented here.

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

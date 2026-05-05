MOVA Mower connects your robotic lawn mower to Homey, giving you direct control over mowing, edge mowing, and zone management — all from a single app. Whether you own a MOVA or Dreame robot, the integration works through the official cloud API and supports European, Chinese, and North American server regions.

## Features

- **Action buttons** on the device card: Start Mowing, Mow Full Area, Edge Mowing, Stop, Pause, Return to Dock
- **Per-zone edge mowing** buttons — detected automatically from your map, up to 5 zones
- **Live status**: battery level, charging status, mower status (mowing / paused / docked / error / …)
- **Volume** slider — set the mower's speaker volume (0–100)
- **Child lock** — lock and unlock the physical buttons on the mower directly from Homey
- **Frost protection** and **Rain protection** settings — read from the mower on startup, written back immediately on change (confirmed via packet capture)
- **Rain protection** includes sensitivity (1–3) and wait time in hours
- **Lighting** — configure the LED activation time window and per-scenario light behaviour (standby, mowing, charging, error)
- **Auto-reset action buttons** when the mower reaches a new state (e.g. dock button resets when mower docks)
- Flow cards for full automation
- Built-in **Debug Console** in the app settings for diagnostics and device discovery

## Device Settings

| Setting | Description |
|---------|-------------|
| Child Lock | Locks / unlocks physical buttons on the mower |
| Frost Protection | Prevents mowing when frost is detected |
| Rain Protection — Enabled | Pauses mowing during rain |
| Rain Protection — Sensitivity | Detection sensitivity (1 = low, 3 = high) |
| Rain Protection — Wait time | Hours to wait after rain before resuming |
| Lighting — Custom time window | Only activate the LED during the configured hours |
| Lighting — Start / End | Hour of day for LED on and off (e.g. 8 = 08:00, 20 = 20:00) |
| Lighting — Standby / Mowing / Charging / Error | Per-scenario LED activation |
| Poll interval | How often Homey checks the mower status (seconds, default 30) |

Device info (model, firmware, serial, MAC, email, brand, region) and zone count are read-only labels updated automatically.

> **Note:** Settings that are read from the mower (Frost Protection, Rain Protection, Lighting time window) are refreshed on startup and every ~5 minutes during normal operation. Changes made in the manufacturer app will appear in Homey within that window.

## Pairing

Open the Homey app, add a new device and select MOVA or Dreame as brand and your region. Enter the same email address and password you use in the official MOVA or Dreame smartphone app. The integration will discover all mowers linked to your account.

## Commands

### Device Card Buttons

| Button | Description |
|--------|-------------|
| Start Mowing | Starts mowing using the active mowing mode (full area by default) |
| Mow Full Area | Immediately starts a full-area mow, ignoring the active mode |
| Edge Mowing | Starts edge mowing along the entire perimeter |
| Pause | Pauses the mower; it waits in place until resumed |
| Stop | Stops mowing and keeps the mower where it is |
| Return to Dock | Sends the mower back to the charging station |
| Zone 1–5 | Mows the corresponding zone (buttons appear automatically based on detected map zones) |
| Edge Zone 1–5 | Edge-mows the corresponding zone (buttons appear automatically based on detected map zones) |

### Flow Card Actions

| Action | Description |
|--------|-------------|
| Start mowing | Starts mowing using the configured mowing mode |
| Start edge mowing | Starts edge mowing along the full perimeter |
| Start zone mowing | Mows one or more specific zones (comma-separated zone IDs) |
| Start edge zone mowing | Edge-mows a specific zone by number |
| Start spot mowing | Mows at specific spot locations (comma-separated spot IDs) |
| Pause mowing | Pauses the mower in place |
| Stop mowing | Stops the current mowing session |
| Return to dock | Returns the mower to the charging station |
| Find mower | Plays an audible alert to help locate the mower |
| Clear error | Clears a recoverable fault so mowing can resume |
| Set mowing mode | Sets the default mode used by "Start mowing" (all area / edge / zone / spot / manual) |

## Flow Cards

**When...**
- Mower status changed
- Charging status changed
- Mowing completed
- Mower docked at station
- Mower error occurred
- Battery is low
- Firmware update available

**And...**
- Mower is / is not mowing
- Mower is / is not docked
- Mower is / is not charging
- Mower has / has no error

**Then...**
- Start mowing (full area)
- Start edge mowing
- Start zone mowing
- Start spot mowing
- Pause mowing
- Stop mowing
- Return to dock
- Find mower (audible alert)
- Clear recoverable error

## Supported Brands & Regions

| Brand | Regions |
|-------|---------|
| MOVA | Europe (EU), China (CN), North America (NA) |
| Dreame | Europe (EU), China (CN), North America (NA) |

## Support the Project

If this app saves you time and works well for you, a small donation is always appreciated — it helps cover development time and API research.

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-0070ba?logo=paypal)](https://www.paypal.me/PLACEHOLDER)

## Notes

Zone mowing buttons (Zone 1–5) are shown as TBD — the exact API payload for zone-specific mowing on MOVA devices is not yet confirmed. Edge mowing per zone is fully working. Zone and spot mowing via flow cards require zones to be configured in the official MOVA or Dreame app first.

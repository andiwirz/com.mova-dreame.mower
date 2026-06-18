MOVA & Dreame Mower connects your robotic lawn mower to Homey, giving you direct control over mowing, edge mowing, and zone management — all from a single app. Whether you own a MOVA or Dreame robot, the integration works through the official cloud API and supports European, Chinese, and North American server regions.

## Features

- **Action buttons** on the device card: Start Mowing, Start Spot Mowing, Pause, Stop, Return to Dock, Go to Maintenance Point
- **Zone picker** — select a zone, the full area, or edge mowing from a dynamic list built from your map; press Start Mowing to begin
- **Spot picker** — select a configured spot from your map; press Start Spot Mowing to begin
- **Live status**: battery level, charging status, mower status (mowing / paused / docked / error / …)
- **Cutting height** slider — read and set the blade height directly from the device card (min/max configurable per device in settings)
- **Mow efficiency** picker — switch between Standard and Efficient mode directly from the device card
- **Volume** slider — set the mower's speaker volume (0–100)
- **Child lock** — lock and unlock the physical buttons on the mower directly from Homey
- **Frost protection** and **Rain protection** settings — read from the mower on startup, written back immediately on change (confirmed via packet capture)
- **Rain protection** includes sensitivity (1–3) and wait time in hours
- **Lighting** — configure the LED activation time window and per-scenario light behaviour (standby, mowing, charging, error)
- **Do Not Disturb** — set a quiet window during which the mower will not start automatically and returns to dock if already mowing
- **Low Speed at Night** — set a time window during which the mower slows down automatically to protect animals active at night
- **Lifetime mowing statistics** — total mowed area (m²), total mowing time (h), and total mowing sessions, sourced from the device's built-in mowing history (MIHIS); visible in Homey Insights
- **Session duration** — running minute counter for the current mowing session; persists across app restarts so the timer is never reset mid-session
- **Consumable status** — blade life, cleaning brush life, and robot maintenance remaining (%) read from the device
- **Battery settings** — configure the return-to-dock threshold, task-resume threshold, and auto-resume after charging
- **Voice Announcements** — configure which voice modes the mower uses (notifications, work status, special status, errors)
- **Anti-Theft Alarm** — enable lift alarm: mower locks and triggers an audible alarm when lifted
- **Auto-reset action buttons** when the mower reaches a new state (e.g. dock button resets when mower docks)
- Full flow card support for automation
- Built-in **Debug Console** in the app settings for diagnostics, device discovery and compatibility checks
- **Re-authentication without device removal** — if you change your MOVA or Dreame password, tap *Repair* on the device in Homey to restore the connection; all settings, capabilities, and flows are preserved
- **Live Map widget** — real-time SVG map of the lawn with zone boundaries, forbidden areas, dock position, and live robot position during mowing
- **Mowing History widget** — browse past sessions with a mini-map, time-gradient trajectory, obstacle photo carousel, and session statistics

## Capabilities

| Icon | Capability | Description |
|:----:|-----------|-------------|
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/cmd_start_mowing.svg" width="28" height="28"> | **Start Mowing** | Button — starts mowing using the selection in the Zone picker |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/cmd_start_spot_mowing.svg" width="28" height="28"> | **Start Spot Mowing** | Button — starts mowing at the location selected in the Spot picker |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/cmd_pause.svg" width="28" height="28"> | **Pause** | Button — pauses the mower; it waits in place until resumed |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/cmd_stop.svg" width="28" height="28"> | **Stop** | Button — stops mowing and keeps the mower where it is |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/cmd_dock.svg" width="28" height="28"> | **Return to Dock** | Button — sends the mower back to the charging station |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/cmd_maintenance_point.svg" width="28" height="28"> | **Go to Maintenance Point** | Button — drives the mower to its configured maintenance point |
| | **Battery** | Battery level (0–100 %) |
| | **Error Alarm** | Active when the mower reports an error condition |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/mower_status.svg" width="28" height="28"> | **Mower Status** | Current state: `mowing` · `paused` · `returning` · `docked` · `charging` · `idle` · `standby` · `mapping` · `updating` · `remote_control` · `error` |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/charging_status.svg" width="28" height="28"> | **Charging Status** | `charging` · `not_charging` · `charging_completed` · `returning` · `paused_cold` |
| | **Zone Picker** | Select what to mow: Full Area, individual zones, or edge mowing — populated automatically from the map |
| | **Spot Picker** | Select a named spot to mow — populated automatically from the map |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/cutting_height.svg" width="28" height="28"> | **Cutting Height** | Slider — blade height in mm; read and set directly from the device card |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/mow_efficiency.svg" width="28" height="28"> | **Mow Efficiency** | Picker — Standard or Efficient mowing mode |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/mower_volume.svg" width="28" height="28"> | **Volume** | Slider — speaker volume (0–100) |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/child_lock.svg" width="28" height="28"> | **Child Lock** | Toggle — locks / unlocks physical buttons on the mower |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/collision_avoidance.svg" width="28" height="28"> | **Collision Avoidance** | Toggle — enables or disables LiDAR obstacle avoidance |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/firmware_update.svg" width="28" height="28"> | **Firmware Status** | `up_to_date` · `available` · `installing` · `download_failed` |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/measure_duration.svg" width="28" height="28"> | **Session Duration** | Running duration of the current mowing session (minutes); persists across restarts |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/consumable_blade.svg" width="28" height="28"> | **Blade Life** | Remaining blade life (%) |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/consumable_brush.svg" width="28" height="28"> | **Brush Life** | Remaining cleaning brush life (%) |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/consumable_robot.svg" width="28" height="28"> | **Robot Service** | Remaining robot maintenance life (%) |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/meter_area_total.svg" width="28" height="28"> | **Total Area Mowed** | Lifetime total mowed area (m²) — visible in Homey Insights |
| | **Total Mowing Time** | Lifetime total mowing time (h) — visible in Homey Insights |
| <img src="https://raw.githubusercontent.com/andiwirz/com.mova-dreame.mower/main/assets/capabilities/meter_count_total.svg" width="28" height="28"> | **Total Sessions** | Lifetime total number of completed mowing sessions |

## Device Settings

| Setting | Description |
|---------|-------------|
| Cutting Height — Minimum / Maximum | Lower and upper bound for the cutting height slider (mm) |
| Mow Efficiency | Standard or Efficient mowing mode |
| Edge Mowing — Automatic | Robot automatically mows edges after finishing the main area |
| Edge Mowing — Safe | Keeps a small distance from the lawn boundary to avoid damage |
| Edge Mowing — UltraTrim™ | Shifts the cutter disc outward on the last edge pass |
| Edge Mowing — Obstacle Avoidance at Edges | Actively navigates around obstacles at edges |
| Obstacle Avoidance — LiDAR | Detects and avoids obstacles automatically without contact |
| Obstacle Avoidance — Height | Avoids obstacles taller than this threshold (5 / 10 / 15 / 20 cm) |
| Obstacle Avoidance — Distance | Distance at which the robot starts avoiding an obstacle (10 / 15 / 20 cm) |
| Obstacle Avoidance — AI Detection | Object types the robot detects using AI (Off / People / Animals / Objects / combinations) |
| Child Lock | Locks / unlocks physical buttons on the mower |
| Frost Protection | Prevents mowing when frost is detected |
| Rain Protection — Enabled | Pauses mowing during rain |
| Rain Protection — Sensitivity | Detection sensitivity (1 = low, 3 = high) |
| Rain Protection — Wait time | Hours to wait after rain before resuming |
| Lighting — Custom time window | Only activate the LED during the configured hours |
| Lighting — Start / End | Hour of day for LED on and off (e.g. 8 = 08:00, 20 = 20:00) |
| Lighting — Standby / Mowing / Charging / Error | Per-scenario LED activation |
| Do Not Disturb — Enabled | Mower will not start automatically during the set window; stops and returns to dock if already mowing |
| Do Not Disturb — Start / End | Hour of day for the DND window (e.g. 22 = 22:00, 8 = 08:00 next day) |
| Low Speed at Night — Enabled | Mower slows down automatically during the set window to protect animals active at night |
| Low Speed at Night — Start / End | Hour of day for the low-speed window (e.g. 20 = 20:00, 8 = 08:00 next day) |
| Battery — Return threshold (%) | Mower returns to dock when battery drops to this level |
| Battery — Resume threshold (%) | Mower resumes its task once the battery reaches this level after charging |
| Battery — Resume mowing after charging | When enabled, the mower automatically resumes its unfinished task after charging completes |
| Voice — Regular Notification | The mower announces regular status notifications |
| Voice — Work Status | The mower announces work status changes (mowing started, returning …) |
| Voice — Special Status | The mower announces special status events |
| Voice — Error Status | The mower announces error conditions |
| Anti-Theft — Lift Alarm | When enabled, the mower locks and triggers an alarm immediately when lifted |
| Anti-Theft — Map Alarm | Triggers an alarm when the mower leaves the mapped area (requires Link module) |
| Anti-Theft — Real-time Location | Enables real-time GPS location tracking (requires Link module) |
| Poll interval | How often Homey checks the mower status (seconds, default 30) |

Device info (model, firmware, serial, MAC, email, brand, region) and zone count are read-only labels updated automatically.

> **Note:** Settings that are read from the mower (Frost Protection, Rain Protection, Do Not Disturb, Low Speed at Night, Lighting time window, Edge Mowing, Obstacle Avoidance) are refreshed on startup and every ~5 minutes during normal operation. Changes made in the manufacturer app will appear in Homey within that window.

## Widgets

Both widgets are available as Homey dashboard widgets. Add them via the Homey app dashboard editor and select your mower device in the widget settings.

### Live Map

Displays a real-time SVG map of the lawn, built from the mower's internal map data:

- **Lawn boundary** — outer perimeter of the mapped area
- **Mowing zones** — coloured areas for each configured zone
- **Forbidden areas** — red exclusion zones
- **Dock position** — charging station marker
- **Live robot position** — the mower's current position is updated during active mowing using GPS-to-map coordinate conversion; the marker disappears when docked

### Mowing History

Lets you browse completed mowing sessions fetched from the cloud activity log:

- **Session dropdown** — lists past sessions with date, mowing mode (Alles / Rand / Zone), area, and photo count; photo count and mode label are filled in after the session loads
- **Meta bar** — shows date, mowed area (precise float from the activity file), duration, map name, mowing mode, number of AI-detected humans, and fault count if any
- **Mini-map** — SVG trajectory of the selected session:
  - Mowing path coloured with a time gradient (dark = start → bright = end)
  - Green = area mowing, amber = edge mowing (type 7)
  - White circle = mowing start point
  - White ring = dock position
  - Coloured dot markers for each AI-detected obstacle (grey = obstacle, red = person, orange = animal, blue = vehicle, purple = toy); tapping a marker jumps to the photo in the carousel
- **Obstacle photo carousel** — full-width photos of AI-detected obstacles with previous/next navigation and dot indicators; photos are fetched on demand via the file-bridge API and cached for the session

## Requirements

- **Homey Pro (2023)** or newer — the app requires Homey firmware `≥ 12.0.0`
- An active MOVA or Dreame account with at least one linked mower
- Internet access (the integration communicates via the official cloud API)

## Troubleshooting

### Password changed — device shows "Unavailable"

The app uses an OAuth token to communicate with the MOVA / Dreame cloud. If you change your password in the manufacturer app, the server invalidates the token and the mower device in Homey will show as *Unavailable*.

**Fix — no need to remove and re-add the device:**

1. Open the **Homey** app and go to **Devices**.
2. Long-press the mower and tap **Repair** (wrench icon).
3. Enter your updated email and password.
4. Tap **Sign In & Restore Connection**.

The connection is restored immediately. All settings, capabilities, and flows remain unchanged.

---

## Pairing

Open the Homey app, add a new device and select MOVA or Dreame as brand and your region. Enter the same email address and password you use in the official MOVA or Dreame smartphone app. The integration will discover all mowers linked to your account.

## Commands

### Device Card Buttons

| Button / Picker | Description |
|-----------------|-------------|
| Start Mowing | Starts mowing using the selection in the Zone picker |
| Start Spot Mowing | Starts mowing at the location selected in the Spot picker |
| Pause | Pauses the mower; it waits in place until resumed |
| Stop | Stops mowing and keeps the mower where it is |
| Return to Dock | Sends the mower back to the charging station |
| Go to Maintenance Point | Drives the mower to its configured maintenance point |
| Zone picker | Select what to mow: Full Area, individual zones, edge mowing (full perimeter), or edge mowing for a single zone — options are populated automatically from your map |
| Spot picker | Select a named spot to mow — options are populated automatically from your map |

> **Mowing mode and the Start Mowing flow action:** The "Start mowing" flow action uses the *mowing mode* stored on the device — set it first with "Set mowing mode" (all area / edge / zone / spot / manual). Zone and spot IDs for zone/spot mode can be pre-configured with the dedicated zone/spot flow actions. The device card Start Mowing button always uses the current Zone picker selection instead.

### Flow Card Actions

| Action | Description |
|--------|-------------|
| Start mowing | Starts mowing using the configured mowing mode |
| Start edge mowing | Starts edge mowing along the full perimeter |
| Start zone mowing | Mows one or more specific zones (comma-separated zone IDs) |
| Start edge zone mowing | Edge-mows a specific zone by number |
| Start border patrol for zone | Mower traces the zone boundary without cutting — used to verify or demonstrate the boundary |
| Start spot mowing | Mows at specific spot locations (comma-separated spot IDs) |
| Pause mowing | Pauses the mower in place |
| Stop mowing | Stops the current mowing session |
| Return to dock | Returns the mower to the charging station |
| Find mower with audible alert | Plays an audible alert to help locate the mower |
| Clear error | Clears a recoverable fault so mowing can resume |
| Set mowing mode | Sets the default mode used by "Start mowing" (all area / edge / zone / spot / manual) |
| Set cutting height | Sets the blade height in mm via flow |
| Set mow efficiency mode | Switches between Standard and Efficient mowing mode via flow |
| Go to maintenance point | Drives the mower to its configured maintenance point |
| Set lift alarm | Enables or disables the lift alarm (anti-theft) via flow |
| Set child lock | Enables or disables the child lock via flow |

## Flow Cards

**When...**
- Mowing started
- Mowing completed
- Mower docked at station
- Mower status changed *(token: status)*
- Charging status changed *(token: status)*
- Mower error occurred *(tokens: error code, error description)*
- Battery drops below X% *(arg: threshold %)*
- Consumable drops below X% *(arg: threshold %; tokens: consumable type, remaining %)*
- Firmware update available
- Start Mowing button pressed
- Start Spot Mowing button pressed
- Pause button pressed
- Stop button pressed
- Return to Dock button pressed
- Go to Maintenance Point button pressed

**And...**
- Mower is / is not mowing
- Mower is / is not docked
- Mower is / is not charging
- Mower has / has no error
- Mowing mode is / is not *(dropdown: all area / zone / edge / spot / manual)*
- Mow efficiency is / is not set to efficient
- Battery is above / is below X% *(arg: percentage %)*

**Then...**
- Start mowing (full area)
- Start edge mowing
- Start zone mowing *(comma-separated zone IDs)*
- Start edge zone mowing *(zone number)*
- Start border patrol for zone *(zone number)* — traces boundary without cutting
- Start spot mowing *(comma-separated spot IDs)*
- Pause mowing
- Stop mowing
- Return to dock
- Find mower with audible alert
- Clear recoverable error
- Set mowing mode *(dropdown: all area / zone / edge / spot / manual)*
- Set cutting height *(number: mm)*
- Set mow efficiency mode *(dropdown: Standard / Efficient)*
- Set lift alarm *(dropdown: On / Off)*
- Set child lock *(dropdown: On / Off)*

## Supported Brands & Regions

| Brand | Regions |
|-------|---------|
| MOVA | Europe (EU), China (CN), North America (US), Asia (SG) |
| Dreame | Europe (EU), China (CN), North America (US), Asia (SG) |

## Tested Devices

| Device | Model | Status |
|--------|-------|--------|
| MOVA LiDAX Ultra 1200 | `mova.mower.g2529d` | ✅ Fully implemented |
| MOVA 1000 | `mova.mower.g2405c` | ✅ Works |
| MOVA ViAX 250 | — | ✅ Works |
| MOVA ViAX 300 | `mova.mower.g2420b` | ✅ Works |
| Dreame A1 | — | ✅ Works |
| Dreame A2 | `dreame.mower.g2422` | 🟡 Basic tests ok |
| Dreame A3 AWD Pro 3500 | `dreame.mower.g2541e` | ✅ Works |

Other MOVA and Dreame robotic mowers using the same cloud API are expected to work. If you test a different model, feel free to open an issue or pull request to get it added here.

## Support the Project

If this app saves you time and works well for you, a small donation is always appreciated — it helps cover development time and API research.

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-0070ba?logo=paypal)](https://www.paypal.me/AndiWirz)



## API Reference

This section documents the MiOT protocol used internally to communicate with the MOVA / Dreame cloud. Useful for debugging, extensions, or porting to other platforms.

> **Legend:** ✓ = confirmed via packet capture or live testing · ~ = confirmed via ioBroker / HA integration source · ✗ = unverified / TODO

### HTTP Endpoints

All requests are HTTPS POST to port **13267**. Host: `<region><brand-host>` (e.g. `eu.iot.mova-tech.com`).

| Path | Auth header | Purpose |
|------|-------------|---------|
| `/dreame-auth/oauth/token` | `Authorization: Basic …` | Login (password grant) and token refresh |
| `/dreame-user-iot/iotuserbind/device/listV2` | `Dreame-Auth: <token>` | Discover all linked devices |
| `/dreame-user-iot/iotuserdata/getDeviceData` | `Dreame-Auth: <token>` | Read MiOT properties |
| `/dreame-user-iot/iotuserdata/setDeviceData` | `Dreame-Auth: <token>` | Write MiOT properties |
| `/dreame-iot-com<bindHost>/device/sendCommand` | `Dreame-Auth: <token>` | Execute MiOT actions (`bindHost` = `-<first segment of bindDomain>`, e.g. `-20000`) |
| `/dreame-user-iot/iotstatus/history` | `Dreame-Auth: <token>` | Fetch activity history — body: `{ did, uid (masterUid), region, eiid:'1', key:'4.1', siid:'4', type:3, limit, from:0, time_start:0, time_end:<now> }` → `data.list[]` |
| `/dreame-user-iot/iotfile/getDownloadUrl` | `Dreame-Auth: <token>` | Get signed OSS download URL for an activity JSON file — body: `{ did, uid, model, filename }` → `data` (URL string) |
| `/file-bridge/user/getDeiviceFile` | `Dreame-Auth: <token>` + `Authorization: Basic <brand-credentials>` | Fetch an AI obstacle photo — body: `{ did, fileinfo:<filename.jpg> }` → Brotli-compressed JPEG (~60–70 KB) |

Password is MD5-hashed with salt `RAylYC%fmSKp7%Tq` before sending. Both brands share the same Basic auth credentials and salt.

---

### MiOT Properties

Read via `getDeviceData`, write via `setDeviceData`. Body: `{ did, model:[{siid,piid}] }` / `{ did, model:[{siid,piid,value}] }`.

> **v2 API note:** MOVA and newer Dreame devices (A2, A3, ViAX series) use the v2 cloud API which **ignores the siid/piid list** in `getDeviceData` and returns its own key-value format (`SETTINGS.0`, `MAP.19`, …). On these devices all properties marked ✗ cannot be read or written via this endpoint — use the App-Action Channel (siid:2, piid:50) with CFG keys instead. Only older standard MiOT Dreame devices would respond to direct property reads.

| siid | piid | Name | R | W | Confirmed | Notes |
|------|------|------|---|---|-----------|-------|
| 1 | 2 | Firmware state | ✓ | — | ✓ | Firmware version string |
| 1 | 53 | Bluetooth | ✓ | — | ~ | Source: ioBroker |
| 2 | 1 | Status | ✓ | — | ✓ | Mower status (numeric code) |
| 2 | 2 | Device code | ✓ | — | ✓ | Current error / device code |
| 2 | 4 | Mowing speed | — | ✓ | ✗ | `0`=slow `1`=normal `2`=fast — not accessible on v2 API devices |
| 2 | 6 | Border first | — | ✓ | ✗ | `0`=off `1`=on — not accessible on v2 API devices |
| 2 | 50 | App-action channel | ✓ | ✓ | ✓ | Dual-purpose: mowing commands + CFG read/write (see below) |
| 2 | 51 | Settings CFG blob | ✓ | — | ✓ | Read-only; device pushes full JSON CFG here; do not write directly |
| 2 | 109 | Cutting height | — | ✗ | ✗ | Write rejected (error 10007) on v2 API devices; read ignored — use CFG `PRE[4]` instead |
| 2 | 110 | Auto-resume | — | ✓ | ✗ | `0`=off `1`=on — not accessible on v2 API devices |
| 2 | 111 | Mowing pattern | — | ✓ | ✗ | `0`=zigzag `1`=checkerboard — not accessible on v2 API devices |
| 2 | 112 | Rain protection | ✓ | — | ✗ | Not accessible on v2 API devices — use CFG `WRP` instead |
| 2 | 113 | Night mode | — | ✓ | ✗ | `0`=off `1`=on — not accessible on v2 API devices |
| 2 | 114 | Volume | — | ✓ | ✗ | Not accessible on v2 API devices — use CFG `VOL` instead |
| 3 | 1 | Battery | ✓ | — | ✓ | 0–100 % |
| 3 | 2 | Charging status | ✓ | — | ✓ | `0`=not charging `1`=charging |
| 3 | 10 | Return threshold | — | ✓ | ✗ | Not accessible on v2 API devices — use CFG `BAT[0]` instead |
| 3 | 11 | Resume threshold | — | ✓ | ✗ | Not accessible on v2 API devices — use CFG `BAT[1]` instead |
| 4 | 21 | Obstacle avoidance | — | ✓ | ✗ | `0`=off `1`=low `2`=medium `3`=high — not accessible on v2 API devices |
| 4 | 22 | AI detection | ✓ | — | ✗ | Not accessible on v2 API devices |
| 4 | 50 | AutoSwitch settings | ✓ | ✓ | ✓ | JSON string `{k:'KEY',v:0\|1}` — see AutoSwitch keys below |

---

### MiOT Actions

Sent via `sendCommand`. Body: `{ did, id, data:{ did, id, method:'action', params:{ did, siid, aiid, in:[…] } } }`.

| siid | aiid | Name | `in` params | Confirmed | Notes |
|------|------|------|-------------|-----------|-------|
| 2 | 50 | App-action channel | `[{m, p, o, d}]` or `[{m:'g'\|'s', t, d}]` | ✓ | Multi-purpose (see op-codes and CFG keys) |
| 4 | 3 | Clear error / fault | — | ✗ | Returns `80001` (not supported) on MOVA devices |
| 5 | 1 | Start mowing | — | ✓ | Uses active mowing mode |
| 5 | 2 | Stop mowing | — | ✓ | |
| 5 | 3 | Return to dock | — | ✓ | |
| 5 | 4 | Pause | — | ✓ | |
| 5 | 7 | Start manual mowing | — | ✗ | siid/aiid unverified |

---

### App-Action Channel — Mowing Op-codes

Action: `siid:2, aiid:50`. Payload item: `{ m:'a', p:<mapIndex>, o:<opcode>, d:{…} }`.

| `o` | Name | `d` payload | Confirmed |
|-----|------|-------------|-----------|
| 9 | Find mower with audible alert | `{}` | ✓ |
| 101 | Edge mowing — full perimeter | `{}` (all boundaries) or `{ edge:[[zoneId, mapIdx]] }` (single zone) | ✓ |
| 102 | Zone mowing | `{ region:[zoneId, …] }` — flat array of numeric zone IDs | ✓ |
| 103 | Spot mowing | `{ area:[areaId, …] }` — flat array of numeric area/spot IDs | ✓ |
| 108 | Border patrol | `{ edge:[[zoneId, mapIdx]] }` — mower traces zone boundary without cutting (Randpatrouille) | ✓ |
| 109 | Go to maintenance point | `{ point:[1] }` — `point` array references the maintenance point index | ✓ |

`p` is the active map index (typically `0`). Omitting the `edge` array in op-code 101 lets the device mow all stored boundaries automatically — passing unknown boundary-segment IDs causes a "zone unreachable" error.

---

### App-Action Channel — CFG Keys

Read all: `in:[{ m:'g', t:'CFG' }]` → response `data.result.out[0].d` contains all keys.  
Write one: `in:[{ m:'s', t:'<KEY>', d:{…} }]`.

Mowing history: `in:[{ m:'g', t:'MIHIS' }]` → response `data.result.out[0].d` contains `{ area, count, time, start }` — `area` in m², `time` in minutes, `count` = total sessions, `start` = Unix timestamp of first use. Read-only.

| Key | GET `d` format | SET `d` format | Description | Confirmed |
|-----|----------------|----------------|-------------|-----------|
| `AOP` | `{value:0\|1}` | `{value:0\|1}` | AI obstacle photo capture — when on, the mower photographs detected obstacles | ✓ |
| `VOICE` | `[notification, workStatus, specialStatus, errorStatus]` | `{value:[0\|1, 0\|1, 0\|1, 0\|1]}` | Voice announcement modes — all 4 booleans sent together | ✓ |
| `ATA` | `[liftAlarm, mapAlarm, realtimeLocation]` | `{value:[0\|1, 0\|1, 0\|1]}` | Anti-theft alarm — `[0]`=lift alarm, `[1]`=alarm when leaving map (Link module), `[2]`=real-time location (Link module) | ✓ |
| `CLS` | `{value:0\|1}` | `{value:0\|1}` | Child lock (`0`=off, `1`=on) | ✓ |
| `FDP` | `{value:0\|1}` | `{value:0\|1}` | Frost protection | ✓ |
| `WRP` | `{value, sen, time}` | `{value, sen, time}` | Rain protection — `sen`=sensitivity 1–3, `time`=wait hours | ✓ |
| `VOL` | `{value:0–100}` | `{value:0–100}` | Speaker volume | ✓ |
| `LIT` | `[enabled, startMin, endMin, standby, working, charging, error]` | `{value, time:[startMin, endMin], light:[s, w, c, e]}` | LED settings — time in minutes since midnight; scenario values `0`\|`1`; GET returns all 7 values in one array | ✓ |
| `DND` | `[enabled, startMin, endMin]` | `{value, time:[startMin, endMin]}` | Do-Not-Disturb — time in minutes since midnight (e.g. `1320`=22:00, `480`=08:00) | ✓ |
| `PRE` | `[n0…n18]` | `[n0…n18]` | Mowing preferences — 19-element array, full array required on write (read-modify-write). GET not supported on v2 devices; reconstruct from `SETTINGS.0` fields (see table below). | ✓ |
| `PROT` | `{value:0\|1}` | `{value:0\|1}` | Grass protection | ~ |
| `STUN` | `{value:0\|1}` | `{value:0\|1}` | Anti-theft lock | ~ |
| `LOW` | `[enabled, startMin, endMin]` | `{value, time:[startMin, endMin]}` | Low Speed at Night — time in minutes since midnight (e.g. `1200`=20:00, `480`=08:00) | ✓ |
| `CMS` | `[bladeMin, brushMin, robotMin]` | — | Consumable usage in minutes since last replacement — blade max 6000 min (100h), brush max 30000 min (500h), robot max 3600 min (60h) | ✓ |
| `BAT` | `[returnPct, resumePct, autoResume, ?, startMin, endMin]` | `{value:[returnPct, resumePct, autoResume], type:'power'}` | Battery thresholds + auto-resume flag; `[4]`/`[5]` = charging window times — `type:'schedule'` write not yet confirmed | ✓ |

#### PRE Array Field Mapping

Confirmed via packet-capture correlation against `SETTINGS.0` JSON fields (all 16 non-reserved indices matched):

| Index | `SETTINGS.0` field | Unit / values | Description |
|-------|--------------------|---------------|-------------|
| 0–2 | — | reserved | Always `0` |
| 3 | `efficientMode` | `0`=Standard, `1`=Efficient | Mow efficiency mode |
| 4 | `mowingHeight` | mm (×10 from cm) | Cutting height |
| 5 | `edgeMowingWalkMode` | `0`/`1` | Edge mowing walk mode |
| 6 | `mowingDirection` | degrees | Mowing direction angle |
| 7 | `edgeMowingAuto` | `0`=off, `1`=on | Automatic edge mowing after main area |
| 8 | `edgeMowingSafe` | `0`=off, `1`=on | Safe edge mowing (keeps distance from boundary) |
| 9 | `cutterPosition` | `0`=off, `1`=on | UltraTrim™ — shifts cutter disc outward on last pass |
| 10 | `edgeMowingNum` | integer | Number of edge mowing passes |
| 11 | `edgeMowingObstacleAvoidance` | `0`=off, `1`=on | Obstacle avoidance at edges |
| 12 | `mowingDirectionMode` | `0`/`1` | Mowing direction mode |
| 13 | `obstacleAvoidanceHeight` | cm | Obstacle avoidance height threshold |
| 14 | `obstacleAvoidanceDistance` | cm | Obstacle avoidance distance threshold |
| 15 | `obstacleAvoidanceAi` | bitmask: bit0=people, bit1=animals, bit2=objects | AI obstacle detection categories |
| 16 | `obstacleAvoidanceEnabled` | `0`=off, `1`=on | LiDAR obstacle detection |
| 17 | `ridingMowingmode` | `0`/`1` | Riding mowing mode |
| 18 | `ridingMowingDistance` | cm | Riding mowing distance |

---

### AutoSwitch Keys (`siid:4, piid:50`)

Single JSON-string property. Read via property poll; write via `setDeviceData` with value `JSON.stringify({ k:'KEY', v:0|1 })`.

| `k` | Description | `v` values | Confirmed |
|-----|-------------|------------|-----------|
| `LessColl` | Collision avoidance sensitivity (source: ioBroker.dreame — key unverified on live device) | `0`=off, `1`=on | ~ |
| `SmartCharge` | Smart auto-charging (source: ioBroker.dreame — key unverified on live device) | `0`=off, `1`=on | ~ |

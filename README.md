MOVA & Dreame Mower connects your robotic lawn mower to Homey, giving you direct control over mowing, edge mowing, and zone management — all from a single app. Whether you own a MOVA or Dreame robot, the integration works through the official cloud API and supports European, Chinese, and North American server regions.

## Features

- **Action buttons** on the device card: Start Mowing, Start Spot Mowing, Pause, Stop, Return to Dock
- **Zone picker** — select a zone, the full area, or edge mowing from a dynamic list built from your map; press Start Mowing to begin
- **Spot picker** — select a configured spot from your map; press Start Spot Mowing to begin
- **Live status**: battery level, charging status, mower status (mowing / paused / docked / error / …)
- **Cutting height** sensor — displays the current blade height read from the mower (read-only)
- **Volume** slider — set the mower's speaker volume (0–100)
- **Child lock** — lock and unlock the physical buttons on the mower directly from Homey
- **Frost protection** and **Rain protection** settings — read from the mower on startup, written back immediately on change (confirmed via packet capture)
- **Rain protection** includes sensitivity (1–3) and wait time in hours
- **Lighting** — configure the LED activation time window and per-scenario light behaviour (standby, mowing, charging, error)
- **Do Not Disturb** — set a quiet window during which the mower will not start automatically and returns to dock if already mowing
- **Low Speed at Night** — set a time window during which the mower slows down automatically to protect animals active at night
- **Consumable status** — blade life, cleaning brush life, and robot maintenance remaining (%) read from the device
- **Battery settings** — configure the return-to-dock threshold, task-resume threshold, and custom charging time window
- **Voice Announcements** — configure which voice modes the mower uses (notifications, work status, special status, errors)
- **Anti-Theft Alarm** — enable lift alarm: mower locks and triggers an audible alarm when lifted
- **AI Obstacle Photos** — enable photo capture of AI-detected obstacles; fires an "Obstacle detected" flow trigger with a photo and obstacle type after each mowing session
- **Auto-reset action buttons** when the mower reaches a new state (e.g. dock button resets when mower docks)
- Flow cards for full automation
- Built-in **Debug Console** in the app settings for diagnostics, device discovery and compatibility checks

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
| AI Obstacle Photos | When enabled, the mower photographs AI-detected obstacles so you can view them in the manufacturer app |
| Poll interval | How often Homey checks the mower status (seconds, default 30) |

Device info (model, firmware, serial, MAC, email, brand, region) and zone count are read-only labels updated automatically.

> **Note:** Settings that are read from the mower (Frost Protection, Rain Protection, Do Not Disturb, Low Speed at Night, Lighting time window) are refreshed on startup and every ~5 minutes during normal operation. Changes made in the manufacturer app will appear in Homey within that window.

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
| Zone picker | Select what to mow: Full Area, individual zones, edge mowing (full perimeter), or edge mowing for a single zone — options are populated automatically from your map |
| Spot picker | Select a named spot to mow — options are populated automatically from your map |

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
- Obstacle detected by AI camera *(fires once per obstacle after each mowing session, with a photo and obstacle type token — requires AI obstacle photo capture to be enabled in device settings)*

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
| MOVA | Europe (EU), China (CN), North America (US), Asia (SG) |
| Dreame | Europe (EU), China (CN), North America (US), Asia (SG) |

## Tested Devices

| Device | Model | Status |
|--------|-------|--------|
| MOVA LiDAX Ultra 1200 | `mova.mower.g2529d` | ✅ Fully implemented |
| MOVA ViAX 300 | `mova.mower.g2420b` | 🟡 Basic tests ok |
| Dreame A2 | `dreame.mower.g2422` | 🟡 Basic tests ok |
| Dreame A3 AWD Pro 3500 | `dreame.mower.g2541e` | 🟡 Basic tests ok |

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
| 9 | Find mower (audible alert) | `{}` | ✓ |
| 101 | Edge mowing — full perimeter | `{}` (all boundaries) or `{ edge:[[zoneId, mapIdx]] }` (single zone) | ✓ |
| 102 | Zone mowing | `{ region:[zoneId, …] }` — flat array of numeric zone IDs | ✓ |
| 103 | Spot mowing | `{ area:[areaId, …] }` — flat array of numeric area/spot IDs | ✓ |

`p` is the active map index (typically `0`). Omitting the `edge` array in op-code 101 lets the device mow all stored boundaries automatically — passing unknown boundary-segment IDs causes a "zone unreachable" error.

---

### App-Action Channel — CFG Keys

Read all: `in:[{ m:'g', t:'CFG' }]` → response `data.result.out[0].d` contains all keys.  
Write one: `in:[{ m:'s', t:'<KEY>', d:{…} }]`.

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
| `PRE` | `[n0…n18]` | `[n0…n18]` | Mowing preferences (19-element array — requires full read-modify-write). Partially decoded: `[1]`=efficiency(0/1), `[4]`=height(mm), `[8]`=safeEdge, `[9]`=autoEdge, `[13]`=obstacleHeight(cm), `[14]`=obstacleDistance(cm), `[15]`=AI bitmask(bit0=human,bit1=animal,bit2=object), `[16]`=LiDAR. Not exposed — remaining indices unknown. | ~ |
| `PROT` | `{value:0\|1}` | `{value:0\|1}` | Grass protection | ~ |
| `STUN` | `{value:0\|1}` | `{value:0\|1}` | Anti-theft lock | ~ |
| `LOW` | `[enabled, startMin, endMin]` | `{value, time:[startMin, endMin]}` | Low Speed at Night — time in minutes since midnight (e.g. `1200`=20:00, `480`=08:00) | ✓ |
| `CMS` | `[bladeMin, brushMin, robotMin]` | — | Consumable usage in minutes since last replacement — blade max 6000 min (100h), brush max 30000 min (500h), robot max 3600 min (60h) | ✓ |
| `BAT` | `[returnPct, resumePct, autoResume, ?, startMin, endMin]` | `{value:[returnPct, resumePct, autoResume], type:'power'}` | Battery thresholds + auto-resume flag; `[4]`/`[5]` = charging window times — `type:'schedule'` write not yet confirmed | ✓ |

---

### AutoSwitch Keys (`siid:4, piid:50`)

Single JSON-string property. Read via property poll; write via `setDeviceData` with value `JSON.stringify({ k:'KEY', v:0|1 })`.

| `k` | Description | `v` values | Confirmed |
|-----|-------------|------------|-----------|
| `LessColl` | Collision avoidance sensitivity (source: ioBroker.dreame — key unverified on live device) | `0`=off, `1`=on | ~ |
| `SmartCharge` | Smart auto-charging (source: ioBroker.dreame — key unverified on live device) | `0`=off, `1`=on | ~ |

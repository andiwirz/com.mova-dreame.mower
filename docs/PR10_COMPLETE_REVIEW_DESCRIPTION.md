# PR #10 — ready-to-paste review description (CORE-only, upstream 1.1.43)

> This Markdown file is the replacement for the original duplicated HTML + plain-text pull-request body. Changes to the PR source branch are already applied. The installed GitHub integration cannot edit the upstream PR's description (403), so the PR author can copy this document into the existing PR #10's **Edit description** field. No new PR is needed.

# MOVA / Dreame A2 CORE 1.2.0 — real no-go zones, P1–P5, optional garage safety, maps and Homey Flows

Hi Andi,

Thank you for the substantial review of [the closed PR #9](https://github.com/andiwirz/com.mova-dreame.mower/pull/9). I apologize for not responding before its closure. The earlier CORE+camera contribution was too broad, and our real A2 tests showed that native map writes, STOP/IDLE, waypoint arrival, original-app return and garage safety needed more work. Rather than reviving the older branch, this CORE-only contribution is rebuilt against **your v1.1.43** (base commit `7af9b936`) with your PRE, fault-hint, map widget and UI fixes preserved.

The target tested setup is MOVA A2 g2408 on Homey Pro 2023. Additional models should retain their existing operation, but this does not certify other hardware.

## 1. New bilingual configuration structure (Repair / Manage mower)

**Mower device → Repair / Manage mower** now contains:

- **Map editor:** native mowing map, pylons and real no-go zones, marker/names/radii and lifecycle settings, independent of Garage Mode.
- **Maintenance points:** P1–P5 names and primary point selection, independent of Garage Mode.
- **Garage Mode:** door/sensor, A–B safety line, danger area, fixed/alternating waypoint rotation and garage display options; **shown only when Garage Mode is enabled**.
- **Reconnect:** reauthenticate to the MOVA cloud without deleting and re-pairing the mower.

The new UI and operator messages are **bilingual German/English (DE/EN)**, with a language selection in Repair. Most new configuration moves from overloaded Advanced Settings into these Repair pages; existing settings remain migrated/reused.

## 2. Real native exclusion zones, lifecycle and readable map editor

Choose **Edit** and tap a detected pylon or a native red exclusion zone, then assign a **name/notes**, radius where applicable and lifecycle. Manufacturer-app zones also work where their geometry and map match. Supported rules: **Permanent**, **3 / 7 / 14 days**, **Departure only**, **Departure + mowing**, **Mowing only**, **Mowing + return**, **Return only**. **All** can be configured without Garage Mode. They physically **add/remove native mower polygons**, not only Homey map decorations.

The firmware requires a genuine task-free, stationary edit checkpoint. "Mowing only" and "Mowing + return" may be conservatively **pre-armed before departure**; "Return only" is **not pre-armed**, instead inserted at a confirmed safe return checkpoint if one exists. Otherwise the operation stays visibly **pending/unconfirmed**, especially when the user starts externally in the original manufacturer app.

The real vendor map-edit sequence is **200 select → 204 begin → 215 create or 218 delete → 201 commit**. An API/TASK ACK never alone confirms success: native **MAPD/MAPI geometry readback**, map identity, physical position and cloud/original-app map state are cross-checked. Recycled native zone IDs and stale geometry cannot attach old rules to new areas; explicit user deletion is not mistaken for a temporary lifecycle removal. Visual improvements include blue animated **pending indicators**, a **cancelable 10-second dialog-close countdown**, clear native verification/errors and reload/recheck controls. Return-map readback is bounded (30 seconds), not unending.

A field-identified 3 November error occurred when native 200/204 map editing briefly reported `MOWING` at a verified P1/P2 stop and caused 218 to be wrongly vetoed. The patch narrowly permits that transient *label* only with independently proven no-task native IDLE, fresh matching physical position witnesses, unchanged map/return token, safe door/line and no emergency; it does **not** permit writing while moving. A successful direct MAPD result is retained between return and waypoint code paths. **PR #10 review hardening also rechecks native IDLE or fresh native IN_STATION plus two physical native positions directly before ordinary/manual 215/218 mutations**, not just at the start of the editor sequence.

## 3. Five maintenance points, naming, star and user-guided learning

Support for **P1–P5** extends the previous single-point workflow. Names are editable from **Repair → Maintenance points** or via **Map → Edit → tap the point**. A **★ marks the current primary maintenance point** on the map. Naming a missing P2–P5 makes a labeled Homey device button visible, but a name is not a claimed native coordinate.

For an **unknown point** the workflow is explicit:

1. **First tap its named P2–P5 button on the Homey mower device card**; this selects the intended native point without guessing a route or silently substituting P1.
2. With **Garage Mode ON**, Homey confirms dock state, **opens the gate and verifies the open position**, then asks the user to drive the **same P-number from the original MOVA/Dreame app**.
3. With **Garage Mode OFF**, Homey arms that **same native arrival observer without opening any gate**. The user then starts the correct point from the original app; no garage geometry is necessary.
4. Homey learns coordinates only after a genuine manufacturer opcode **109**, actual stable arrival/firmware status **75** (or carefully bounded fallback evidence), same map and independent position checks. Mere Homey naming, cloud ACK or a solitary 75 is insufficient. An unconfirmed point never becomes an automatic return destination.

Once verified, waypoints can be driven directly **even without Garage Mode**. Names, current-primary marker and buttons update dynamically, while stable P1–P5 capability and Flow identifiers preserve old automations.

**Grass/lawn protection:** In **Garage Mode ON** with **at least two confirmed native points**, select **Fixed** or **Automatic alternating points**. The current primary waypoint advances **once only after genuinely completed mowing and physically verified docking**, distributing repeated stopping and turning to reduce lawn wear. It never advances on duplicate MQTT/poll events.

## 4. Garage safety, original-app starts and return decisions

When enabled, Garage Mode intercepts original manufacturer-app **starts and returns**, stopping unsafe departure until the gate has actually been opened and confirmed. It preserves independent physical sensor, position, A/B safety-line and danger-area checks. Closure follows distinct strategies: **Priority 1** confirmed physical exit; **Priority 2** stable line-side/dwell; **Priority 3** three qualified line-crossing attempts then PAUSE → independently recheck location/status → CLOSE → verify → RESUME. Three raw contacts alone never authorize closing on the mower.

An externally requested return retains both the original position/timestamp and the actual **post-STOP** position. It chooses direct docking versus a verified P1–P5 detour based on live geometry and gate ETA, opening the gate **in parallel** when safe. If a real no-go-zone removal/restoration is needed, it obtains a task-free native STOP/IDLE checkpoint and authoritative map readback, then re-enters guarded native DOCK/waypoint navigation. **If no physical geometry change is required, no extra map-edit STOP is added.** Temporarily removed zones are restored after verified docking; the gate is closed only after verified clearance.

A limited **18-second return-startup scheduling credit** accounts for reorientation following a **confirmed native zone STOP** only; it is not added to every route. The gate sensor, A/B brake and critical position checks remain independent and always override timing estimates. Fail-safe hold/manual supervised recovery exists if proofs cannot be obtained. Operator visual takeover offers explicit mower, waypoint and gate commands, but sight reports are not forged as sensor/native docking evidence.

## 5. Map and Total Overview, stable buttons, one central notices card without broken Flows

The **native mower map image is included in the device view**, in addition to the standalone map widget, embedded editor and **Total Overview dashboard**. Device status, command buttons and map snapshots remain useful outside Garage Mode. Note that Homey registers widgets statically: **Total Overview is still selectable when Garage Mode is OFF**. Its garage summary, automated gate controls and garage-specific settings are hidden or blocked when Garage Mode is OFF; exceptional read-only diagnostics and explicit supervised recovery remain accessible as designed. It is not correct to claim the whole widget disappears from the picker.

The new bilingual **`garage_mower_notice` trigger card** centralizes garage/mower notifications with `kind`, `message`, `reason` tokens, deduplication and optional routine alerts. This is a **single new notification entry point**, **not a deletion of legacy Flow triggers**: existing safety, emergency, gate and maintenance triggers remain registered and continue firing so existing Flows do not regress. New automatic gate notices require Garage Mode.

**Pause/Resume**, garage toggles, stable maintenance-point buttons and their UI feedback are hardened. Native MQTT / bounded polling updates and **serialized/deduplicated `setCapabilityOptions()` calls** prevent repeated Homey device reinitialization, Flow-card recreation and unnecessary UI load.

Backward compatibility requested in #9: retain `slow_motion_enabled`; no add-and-remove `lawn_care_mode` migration; show `turning_method` only for valid PRE[19]; keep `compatibility >=12.3.0`; use LF via `.gitattributes`; clearly disclose phase-zone reachability; include EN/DE errors and **EvotecIT as contributor**. Native PRE updates preserve unknown vendor values using your 1.1.43 read-modify-write behavior.

## 6. Field tests, automated verification and remaining review

- In supervised A2 runs: original-app departure/gate opening; confirmed P1/P2 arrival; native no-go-zone 102 removal and **MAPD verification**; parallel gate opening, automatic safe DOCK, restoration of zone 102 and safe gate closure; Pause/Resume and widgets functioning. The 3 November field regression log distinguishes the initial failure from a later successful test. This does not certify emergency braking on every model.
- The extracted **CORE 1.2.0 source previously passed 270/270 automated tests**. The private versions CORE **1.2.154** and CAMERA **1.2.155** are development/test builds, not this public PR. Nine further focused regression test cases cover edit guards and garage-off point learning. Function-level checks of the current methods passed; **the full updated `npm test` suite, `homey app validate --level publish` and existing-installation/Flow upgrade smoke test remain to be run on the exact latest PR head**. No measured CPU/RAM benchmark is claimed.
- **Camera intentionally excluded:** Tencent XP2P, Bionic/VNDK, Android shims, native libraries and video publishing require separate licensing/provenance/build verification, followed by a **separate optional camera PR only after CORE acceptance**. No redistribution permission is claimed here.

### How to review

- [Detailed English feature, dependencies and safety guide](docs/A2_CORE_1_2_0_REVIEW_GUIDE_EN.md)
- [German full handoff](docs/A2_CORE_1_2_0_UEBERGABE_DE.md)
- [PR #9 feedback and review scope](docs/PR1_CORE_STAGED_REVIEW.md)
- [3 November native MAPD regression, first failure and later successful field run](docs/NOV03_FIELDLOG_MAPD_RETURN_FIX_DE.md)
- [New focused regression tests](tests/pr10-native-edit-and-no-garage-learning.test.js)

Recommended order: `drivers/mower/device.js`, `lib/MovaApi.js`, `lib/garage/GarageSafetyEngine.js`, the Repair screens, widgets, and then migration/Flow tests.

**Kurzfassung:** Karte/Sperrzonen und Wartungspunkte sind auch ohne Garagenmodus nutzbar. Garagentor und Rasenschonungs-Rotation benötigen den Garagenmodus; unbestätigte Punkte werden erst nach echter Original-App-Fahrt angelernt. ★ kennzeichnet den aktuellen Hauptpunkt. Die zentrale neue Meldungskarte ergänzt bestehende Flow-Karten. Native Sperrzonen werden über MAPD/MAPI tatsächlich bestätigt; zusätzliche Sicherheitsregeln sichern Rückkehr und STOP/DOCK. Die Kamera bleibt für einen eigenen, erst nach der CORE-Prüfung und Lizenzklärung zu bewertenden PR außen vor.

Thank you for considering the CORE-first contribution.
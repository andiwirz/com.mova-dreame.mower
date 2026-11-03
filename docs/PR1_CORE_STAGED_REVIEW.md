# CORE 1.2.0 — review history and merge scope (3 November 2026)

## Why this is a new PR

The closed #9 PR combined CORE and camera/video changes against an older upstream revision. After Andi's review we ran additional supervised A2 tests and corrected native-zone timing/readback, manufacturer-app return handling, maintenance-point confirmation, stale position handling, garage interlocks, phase-zone rules and Homey UI load. We therefore propose a **new, CORE-only PR against upstream 1.1.43**, rather than reopen or force-update the old combined contribution.

## Review boundaries

- **Included:** native no-go zones (time and mission phases, also when Garage Mode is OFF), recognized pylon → real native zone, MAPD/MAPI readback and pending status, P1–P5 naming and native confirmation, optional garage interlocks and rotation, supervised recovery, maps, widgets, translated user prompts, migration protection and Flow compatibility.
- **Excluded:** video, camera widget, Tencent XP2P SDK, native Android shims/binaries and their licensing. Those require a later independent review and documented redistribution rights.
- **Upstream baseline:** Andy's `main` at `7af9b936a3f5acdefec08f097a68da2180cb9c5c` (1.1.43). Its native PRE read-modify-write, error-hint token, fixed map widget device-ID protection and history-widget behavior are preserved.
- **Existing users:** `slow_motion_enabled` is retained, `lawn_care_mode` is not added-and-removed through an upgrade migration, `turning_method` is offered only for a supported PRE[19], and dynamic Homey tile option writes are deduplicated and serialized.

## Phase-zone semantics (important)

Native edits require confirmed task-free IDLE and stable mower position. To avoid modifying a moving mower, "Mowing only" and "Mowing + return" may be **pre-armed before departure**; the UI documents this distinction. "Return only" is **not pre-armed on departure**; its insertion is deferred until a verified checkpoint. Such zone rules remain configurable without Garage Mode; if a safe native checkpoint is unavailable, a requested change remains visibly pending rather than pretending that it took effect. No map-edit STOP is added when no native geometry change is needed.

## Supervised field evidence

The 3 November 2026 A2 log first identified and led to a fix for a transient vendor `MOWING` label during native 200/204 map editing at a confirmed P1 checkpoint and for a MAPD success confirmation lost between return branches. A subsequent supervised A2 run confirmed native zone removal, concurrent gate opening, guarded return, docking, zone restoration and gate closure without manual recovery. Priority 3 and the danger stop had been field-tested previously by the contributor; no new deliberate collision tests were performed. These results do not establish certification for other models.

## Tests and handoff

- Public CORE PR archive: **270 / 270** tests passed after extraction on 3 November 2026 (Node.js 22).
- Private test builds CORE 1.2.154 / CAMERA 1.2.155 were independently tested; video is excluded from this PR.
- The contributor reports successful Homey publish validation; verify `homey app validate --level publish` on the exact branch before submission.
- Run a small upgrade smoke test to confirm preserved existing settings and Flow actions.

## Read next

- Detailed functional overview: `docs/A2_CORE_1_2_0_REVIEW_GUIDE_EN.md`
- German handoff: `docs/A2_CORE_1_2_0_UEBERGABE_DE.md`
- Latest return regression: `docs/NOV03_FIELDLOG_MAPD_RETURN_FIX_DE.md`
- Garage-specific behavior: `docs/GARAGE_MODE.md`


## 3 November maintainer clarification: feature dependencies and user workflow

- **Homey device → Repair / Manage mower** is the consolidated configuration entry: Map editor, Maintenance points P1–P5, Garage Mode (only if enabled), and Reconnect. The screens support German and English, including their dialogs and operator errors. Ordinary map settings and waypoint naming do not require Garage Mode.
- **Map editor:** choose Edit, tap a named real native zone or detected pylon, manage radius/name/notes, time limits (3/7/14 days), and departure/mowing/return policies; this is not an icon-only overlay. Native 200 → 204 → 215/218 → 201 is accepted as *pending* until manufacturer MAPD/MAPI geometry readback agrees with the original-app/cloud map. Editor counts down for 10 seconds while blue pending indicators remain, with recovery controls for unresolved writes.
- **Maintenance:** label P1–P5 in Repair or tap a map point while editing; star ★ denotes the selected current primary waypoint. After naming an unconfirmed point, press that device-card button to arm learning. With Garage Mode ON, this verifies station and opens/verifies the gate before instructing the user to issue the corresponding waypoint in the original MOVA/Dreame app. With Garage Mode OFF, no gate command is made: Homey arms the same observer and asks for the real vendor-app waypoint trip. Only a genuine 109 plus independent stationary/arrival evidence can learn the coordinate; never manufacture or substitute P1. Confirmed waypoints can then receive their native commands directly in either mode.
- **Rotation to protect grass:** optional fixed or automatic alternating primary waypoint, Garage Mode ON only, at least two native-confirmed waypoints; rotates once per genuinely completed mowing cycle *after verified docking*, not on duplicate MQTT reports. Labels, star and Flow identifiers follow the active native point without remapping an old point index.
- **Garage-specific:** gate sensor/line/danger guarding, three-priority safe-close rules, external-app start/return interception, waypoint detours, conservative ETA including bounded 18-second native STOP restart credit only with qualifying evidence, and supervised emergency recovery. None of these gate actions are silently enabled when Garage Mode is OFF.
- **Total Overview widget:** the Homey widget is always installable as a mower dashboard (Homey widget registration is static); its normal mower/map controls work without a garage. Garage summary, garage automation and door actions are dynamically governed by the Garage Mode setting; safe read-only diagnostics and explicit supervised recovery are intentionally still reachable when automation is disabled. Do **not** claim the entire widget is absent from the picker with Garage Mode OFF.
- **Unified Flow notice:** new `garage_mower_notice` trigger with `kind`, `message`, `reason` tokens and deduplication/optional routine notices. Existing legacy safety/emergency/door Flow trigger IDs are retained and continue to fire so old automations do not break. The unified notice is in addition to those compatibility triggers, not a destructive replacement.
- **Built-in mower map and toggle stability:** the native mowing map is also exposed in the device view; dynamic pause/resume and garage toggles remain, with deduplicated serialized capability option changes and minimal polling to avoid Flow recreation and Homey load.
- **Camera intentionally excluded:** no video, XP2P, Android shims/binaries or unapproved redistribution. Discuss a separate camera contribution only after CORE acceptance and provenance/licensing review.

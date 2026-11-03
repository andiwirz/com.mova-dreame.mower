# MOVA / Dreame A2 CORE 1.2.0 — Native MQTT Integration, Original-App Command Interception, Garage Safety, Native No-Go Zones and Maintenance Points P1–P5

**CORE-only contribution based on upstream v1.1.43 — no camera/video components included**

Hi Andi,

First of all, thank you for your extensive review of [PR #9](https://github.com/andiwirz/com.mova-dreame.mower/pull/9) and for taking the time to test and validate the changes. Your comments about compatibility, translations, manufacturer-specific capabilities, safety and the video dependencies were important and have influenced this revision.

I also want to apologize for not replying before PR #9 was closed on November 1.

The silence was not intended to disregard your review. After your feedback, I continued extensive testing on my actual MOVA A2 and encountered additional issues involving native MQTT events, original-app starts and returns, task transitions, no-go-zone updates, maintenance-point identification and garage-door safety.

Several of these problems only became visible during actual mower movements. Some required multiple revisions and repeated tests because a seemingly successful API response did not always correspond to the mower's real physical state.

I did not want to declare the original combined contribution ready while these problems remained unresolved. Nevertheless, I should have acknowledged your review and provided progress updates. I am sorry I failed to do that.

The outcome is a substantially revised **CORE-only contribution**, based on your current upstream **v1.1.43**, with the camera implementation completely separated.

---

## 1. Contribution scope and upstream baseline

This PR is **MOVA / Dreame A2 CORE 1.2.0**, rebased onto Andi's upstream **v1.1.43** (base commit `7af9b936a3f5acdefec08f097a68da2180cb9c5c`).

It proposes the integrated **native MQTT telemetry and original-app command handling, real native map and no-go-zone management, P1–P5 maintenance points, optional garage safety, Homey device/map widgets, Repair configuration and Flow integration**.

The contributor's earlier CORE implementation was tested in real operation on a MOVA A2 and successfully validated with Homey. The complete merged contribution still benefits from the maintainer's independent review and test run.

**Video/camera is explicitly out of scope.** No Tencent XP2P SDK, camera stream/widget, video server, Android shim or camera binary is required for this CORE contribution. Any camera implementation would require a separate PR and its own licensing/technical approval.

The 1.1.43 baseline incorporates Andi's PRE read-modify-write, map-widget device identity and fault-hint fixes; this contribution preserves them rather than replacing them.

---

## 2. The most significant architectural change: deeper native MQTT integration

One of the biggest improvements compared with the earlier implementation is the much deeper integration of the manufacturer's native MQTT event stream.

Previously, important decisions could depend on periodic status polling or delayed cloud state updates.

That is not sufficient for certain physical scenarios, especially when a mower is positioned behind an automated garage door.

The updated integration uses native MQTT events as a primary source of timely mower information and feeds them directly into the control and safety state machines.

### 2.1 Direct processing of native events

The code now evaluates multiple manufacturer-reported signals, including:

- **Native docking and undocking state (`SIID 1 / PIID 1`)** — whether the mower is in the station, has started undocking, has lost station contact or is charging.
- **Live physical position (`SIID 1 / PIID 4`)** — current coordinates used for mower position and garage safety checks.
- **Native mower status (`SIID 2 / PIID 1`)** — mowing, paused, returning and other manufacturer task states.
- **Task information (`SIID 2 / PIID 50`)** — correlation with manufacturer task types, including mowing and maintenance-point commands.
- **Control status (`SIID 2 / PIID 56`)** — additional indications of active or resumed mower operation.
- **Native error and arrival information (`SIID 2 / PIID 2`)** — including maintenance-point completion evidence.
- **Mission-completion events** and additional diagnostic state.

The implementation accepts the manufacturer MQTT message-envelope formats observed during development and processes supported events without waiting for the next normal HTTP status poll.

### 2.2 Native MQTT is not just used to update the dashboard

The important difference is that MQTT messages now influence actual behavior.

They are used to:

1. Recognize the beginning of a manufacturer-initiated task.
2. Detect early undocking from the charging station.
3. Distinguish starts from resumes and other task changes.
4. Trigger the appropriate Garage Mode safety handling.
5. Observe original-app maintenance-point journeys.
6. Identify return requests and relevant status transitions.
7. Maintain fresher position evidence for safety decisions.
8. Confirm physical state changes without depending exclusively on delayed cloud polling.

This turns MQTT into an integral part of the mower's operational state management rather than only a source of display updates.

### 2.3 MQTT versus polling

Fresh native MQTT position information is preferred over older location data.

When fresh MQTT coordinates are available, stale fallback sources must not overwrite them and make the mower appear to jump to an incorrect position.

If MQTT becomes unavailable or sufficiently stale, controlled fallback reads remain possible.

The system also limits repeated polling and avoids unnecessary overlapping status requests.

This is particularly important for Garage Mode: an old coordinate must never be treated as a fresh indication that the mower has cleared the doorway.

### 2.4 MQTT connection and token handling

The manufacturer's MQTT connection uses an authenticated subscription associated with the mower's device identity and cloud session.

Since credentials can rotate, reconnecting with an expired token can otherwise leave the live feed disconnected indefinitely.

The implementation handles token rotation and connection replacement, invalidates callbacks from obsolete client instances and uses controlled reconnection behavior.

This is intended to preserve native real-time telemetry over longer-running Homey sessions.

### 2.5 What “intercepting an original-app command” actually means

To avoid any misunderstanding, Homey is **not modifying the original app or intercepting its network traffic before the command reaches the manufacturer**.

Instead, Homey observes native device events generated by manufacturer-initiated actions and can react through the mower's supported native control interface.

This allows the integration to **safety-intercept the resulting mower operation** — for example, by pausing an unsafe departure before permitting passage through a garage door.

The distinction is important: detection is based on observed manufacturer telemetry, and the safety reaction depends on the timeliness and validity of that telemetry.

---

## 3. Original MOVA/Dreame app commands can trigger Homey safety workflows

This is one of the most useful practical consequences of the deeper MQTT implementation.

**The user no longer has to start the mower exclusively through Homey to benefit from the garage safety logic.**

For example, the user may open the original MOVA/Dreame app and press Start.

When Garage Mode is enabled, the Homey integration can recognize the externally initiated operation and take responsibility for the configured gate safety sequence.

### 3.1 Example: Starting from the original app while the mower is in the garage

The intended sequence is:

1. The user starts mowing in the original MOVA/Dreame app.
2. The mower begins its native start/undocking sequence.
3. Homey detects the early native event through MQTT.
4. Garage Mode identifies that the mower is departing from a protected station.
5. The integration pauses or otherwise safely holds the native operation when required.
6. Homey requests the garage gate to open.
7. The system verifies the real open state using the configured gate feedback and safety conditions.
8. Only after the relevant physical checks succeed is the mower's departure released.
9. Live MQTT position and station telemetry continue to monitor the departure.
10. Once the mower has genuinely cleared the entrance, the appropriate gate-closing strategy can run.

**The user can continue using the official MOVA/Dreame app as usual. Homey adds the configured garage safety layer around the resulting operation.**

### 3.2 Early detection matters

During field testing, waiting for the normal mowing status was sometimes too late for a narrow garage.

The updated implementation therefore uses the early native undocking transition — including the observed change from docked, not-undocking to docked, undocking — as an important early interception signal.

Native mowing status and control-status events provide additional guarded detection paths.

Generic task notifications alone are deliberately not treated as sufficient proof of an unsafe departure, because the manufacturer also uses them for other activities such as maintenance and settings changes.

This avoids reacting to every task event as though it were a mowing start.

### 3.3 Distinguishing Start from Resume

A mower that is already outside on the lawn may resume an existing mission.

That must not be treated as a fresh departure from the garage.

The revised state machine correlates native status, task context and physical position to distinguish these situations.

When an outside resume is confirmed, Homey updates the mower controls without unnecessarily opening the garage door or triggering the station-start interception process.

### 3.4 Safety limitation

This is a reactive integration using the telemetry and controls made available by the manufacturer.

It does not guarantee interception before the first physical motor movement under every connection failure or firmware variant.

Consequently, the implementation is conservative about missing position, station and gate evidence, and physical safety checks remain mandatory.

---

## 4. Original-app return commands are also handled

The same architectural principle applies when the user presses **Return to station** in the original manufacturer app.

The Homey integration can observe the return state and coordinate a safe return through the configured garage.

This includes:

- Recognizing the externally initiated return.
- Capturing the original position and request context.
- Checking the mower's actual position after any controlled STOP.
- Determining whether the gate should start opening immediately.
- Deciding between direct docking and a verified maintenance-point detour.
- Safely removing a temporary native no-go zone when necessary.
- Waiting for authoritative native map confirmation.
- Releasing guarded return navigation.
- Confirming actual station arrival.
- Restoring temporary map protection.
- Closing the garage only after the mower is physically clear.

The distinction between **the position when Return was requested** and **the position after a STOP** is intentional.

A mower may travel some distance while braking or reorienting. Reusing the earlier coordinate could lead to an incorrect ETA or return-route decision.

### Parallel gate opening

When live position and route evidence indicate enough remaining distance, gate opening can begin **in parallel** with the mower's approach.

This reduces unnecessary waiting while keeping physical gate and safety-line protections independent.

If the remaining time is insufficient, or the gate-open state cannot be verified, the mower must be held rather than allowed to continue toward an unsafe entrance.

### Conditional 18-second adjustment

A confirmed native STOP for a required no-go-zone map edit can introduce additional restart or orientation time.

The return scheduler can account for this with a bounded **18-second adjustment** in qualifying cases.

It is not automatically added to every return journey, and it never overrides the independent safety-line or gate sensor checks.

---

## 5. Native no-go-zone management: real mower map changes

The CORE contribution can create, remove and manage real native no-go zones.

These are actual map polygons enforced by the mower, **not Homey-only visual decorations**.

### Two different hide/show functions — please distinguish them

There are **two separate kinds of no-go-zone visibility**:

1. **Map display controls (visual only):** The Map widget lets users show or hide forbidden areas and other map layers. Disabling `show_forbidden` hides the red exclusion polygons on the **Homey display only**; it does **not** remove any native boundary and does **not** change what the mower is allowed to drive through.
2. **Native activation/deactivation (physical map change):** The time- and mission-phase lifecycle manager can actually remove a native no-go-zone polygon from the **mower's own map** and later restore it. This changes mower-enforced navigation restrictions and is only considered complete after safe native editing and matching MAPD/MAPI readback.

A native zone can therefore be physically active even while its Homey overlay is hidden. Conversely, a pending request to restore a native zone is not represented as confirmed protection until the mower's map actually contains that geometry.

### Creating a zone from a detected pylon

A pylon or detected obstacle location can be selected in the map editor.

The user can then assign a protection radius, label and lifecycle rule.

Homey constructs compatible native polygon geometry and submits the map modification through the manufacturer's editing interface.

### Existing zones from the original app

Compatible native no-go zones originally created in the MOVA/Dreame app can also be assigned Homey lifecycle rules.

This avoids requiring users to rebuild every existing zone solely to use timed or phase-based protection.

### Zone identity

Native zone IDs may be reused or renumbered.

Therefore, lifecycle association also considers map identity, geometry, physical location and ownership rather than trusting the numeric ID alone.

This distinction prevents an old Homey rule from being attached to an unrelated polygon after a manufacturer map update.

An explicit deletion by the user must also be distinguished from a temporary removal performed by Homey's lifecycle manager.

---

## 6. Time-based and mission-dependent zone lifecycle

Supported policies include:

| Policy | Purpose |
|---|---|
| Permanent | Keep the zone active |
| 3 days | Temporary protection for three days |
| 7 days | Temporary protection for seven days |
| 14 days | Temporary protection for fourteen days |
| Departure only | Protection associated with departure |
| Departure + mowing | Protection during departure and mowing |
| Mowing only | Protection associated with mowing |
| Mowing + return | Protection during mowing and return |
| Return only | Protection associated with return |

**All these policies can be configured without Garage Mode.**

Garage Mode is not required for native map editing or lifecycle evaluation.

### Actual native activation and deactivation

When a lifecycle transition is permitted, Homey adds or deletes the real polygon on the manufacturer's map.

A change is not considered complete merely because the API accepted the command.

### Why phase rules require safe checkpoints

The manufacturer may not allow map modifications during an active task.

A safe, task-free and physically stationary checkpoint is therefore required before applying a native geometry change.

For this reason, **Mowing only** and **Mowing + return** may be conservatively pre-armed before departure, so the necessary protection is already physically present when movement starts.

**Return only** is not automatically inserted during departure. It is activated at a verified safe return checkpoint when one becomes available.

If the required checkpoint cannot be obtained, the operation remains visibly pending or unconfirmed.

This is particularly relevant to externally started missions from the original app.

**The phase labels express the intended protection policy, not permission to modify the manufacturer's map while the mower is moving.**

### Avoid unnecessary STOP operations

If the required native zone state is already correct, the return flow does not create an extra map-edit STOP.

A controlled STOP is performed only when an actual geometry change is necessary.

---

## 7. Native map transaction and verification safeguards

The manufacturer's native map-editing sequence uses:

`200 Select → 204 Begin → 215 Create / 218 Delete → 201 Commit`

An acknowledged command is not sufficient proof of success.

The implementation checks:

- Native task-free IDLE or verified stationary dock state
- Current map index and transaction context
- Actual stationary position
- Fresh native position readings
- No conflicting mower movement
- No emergency or unsafe garage transition
- Native MAPD/MAPI geometry readback
- Correspondence between the requested and confirmed polygon

The latest corrections add renewed physical authorization immediately before ordinary create/delete operations, rather than relying on an earlier safe state that may have become stale.

### November 3 regression

A real A2 test exposed a case where the manufacturer's task status briefly returned to a mowing-related label after successful map-edit preparation.

The previous guard could reject the final mutation even when the actual task-free checkpoint and position evidence remained valid.

A separate issue caused an already-verified map deletion to be forgotten when the return process entered another branch.

Both behaviors were corrected with narrowly scoped checks and preservation of the verified map result.

The fix does **not** authorize native map editing while the mower is actually moving.

A later supervised return test confirmed successful native zone removal, MAPD verification, docking and restoration.

### User feedback

The map editor uses a visible blue **Pending** indicator until native confirmation arrives.

Accepted requests can close after a cancelable ten-second countdown without treating the underlying operation as complete.

Failed or unverified edits remain distinguishable and can be rechecked.

Return-related native map verification has a bounded wait rather than retrying indefinitely.

---

## 8. Maintenance points P1–P5

The CORE implementation supports up to five maintenance points.

Each point has an independent identity and an optional user-defined name.

The map displays the currently selected primary maintenance point using a **★** marker.

Names can be edited through:

**Mower → Repair → Maintenance points**

or:

**Map → Edit → select maintenance point**

### Names are not coordinates

A user may name an unknown point, for example:

**P2 – Rear lawn**

This does not mean Homey knows its actual native position.

Coordinates are learned only from verified manufacturer behavior.

### Learning an unknown point

1. Name the missing P2–P5.
2. Press its corresponding button on the **Homey mower device** to arm the intended point association.
3. Homey prepares the observation process.
4. Start the **same maintenance-point command** in the original MOVA/Dreame app.
5. Homey observes the native command, relevant task context and actual arrival.
6. Only after the appropriate native status, stable position and map evidence are confirmed does Homey store the coordinate.

The manufacturer task opcode `109` and arrival evidence such as code `75` are correlated with independent physical checks.

Neither an isolated arrival code nor a successful command acknowledgement is sufficient.

### With Garage Mode enabled

Before the user initiates the native journey, Homey verifies the required station conditions and opens and confirms the garage gate where necessary.

### With Garage Mode disabled

The same point-learning observation is available, but **no gate command is issued**.

Maintenance points therefore remain usable without a garage.

### Controlled fallback

Missing or delayed native task/arrival evidence may justify a narrowly restricted fallback, but never blind repeated movement.

The garage-disabled learning path remains passive and does not autonomously issue a replacement navigation command.

An unconfirmed point cannot become an automatic return destination.

---

## 9. Optional automatic maintenance-point rotation

Repeatedly stopping and turning at the same lawn location may cause localized wear.

With **Garage Mode enabled** and at least two confirmed native maintenance points, the user can select:

- A fixed primary maintenance point
- Automatic alternation between confirmed points

Rotation happens only after a genuinely completed mowing mission and independently verified docking.

Duplicate MQTT or polling events must not advance the selected point more than once for the same mission.

The current primary is reflected by the ★ marker.

Direct P1–P5 control and naming remain independent of Garage Mode.

---

## 10. Garage Mode safety: three-stage gate closure

Garage Mode combines native mower telemetry with physical garage geometry, sensor feedback and movement control.

The system uses distinct closure strategies.

### Priority 1 — Confirmed clearance

Close after actual physical position evidence proves the mower has passed the relevant exit area.

### Priority 2 — Stable line and dwell evidence

Use qualified side-of-line, position stability and dwell observations when a higher-priority clearance condition is unavailable.

### Priority 3 — Controlled fallback

After three qualified safety-line crossing attempts, use a guarded sequence:

**PAUSE → refresh physical evidence → CLOSE → verify → RESUME**

Three raw line contacts alone do not authorize closing the gate.

The gate sensor, A/B safety lines, danger area, mower movement state and emergency conditions remain independent checks.

If the required evidence cannot be obtained, the system must avoid assuming that the entrance is clear.

These protections also apply to original-app commands intercepted through the native MQTT state machine.

---

## 11. Manual recovery and supervised takeover

The system supports recovery when automatic safety assumptions cannot be confirmed.

Possible reasons include:

- Missing or contradictory position evidence
- Unavailable gate status
- An interrupted native task
- Unverified map geometry
- An uncertain maintenance-point arrival
- A blocked return transition

The user can explicitly inspect the situation and operate supported mower, waypoint and gate controls.

The **Total Overview recovery interface** supports guided inspection, explicit visual declarations, native station double-checks, manual gate operations when allowed, return or known maintenance-point commands, and a deliberate switch to original-app/manual control. It is designed to let the operator recover a stranded mower without silently restarting garage automation.

However, manual visual observation is not converted into a fabricated manufacturer sensor value or false station confirmation.

Automatic safety checks retain their independent evidence requirements.

---

## 12. Homey interfaces, widgets and Flows

### Consolidated Repair / Manage mower interface

The main configuration has been **reorganized away from a collection of scattered advanced settings and widget-specific dialogs** into:

**Homey → Mower device → Repair → Manage mower**

- **Edit mowing map:** choose Edit, tap a pylon, native no-go zone or waypoint marker; manage native exclusion geometry, labels/notes/radii, timed and phase-based rules, pending verification and map refresh. Available **without** Garage Mode and without installing a widget.
- **Maintenance points:** name/remove Homey labels for **P1–P5**, select the primary point (★), see which native destinations have truly verified coordinates, and prepare named unknown points for official-app learning. This page also works **without** Garage Mode.
- **Garage Mode settings:** shown in this menu only when Garage Mode is enabled. Garage-only options are grouped into door/sensor configuration, opening/closing times, physical sensor verification and battery threshold, movement speed/ETA settings, danger and safety-line geometry/tolerances, garage map overlay visibility, logging and notification preferences, and **fixed versus alternating maintenance-point choice**. Actual safety-line/danger coordinates are edited on the map. Automatic rotation is offered only when at least two native points are confirmed.
- **Reconnect:** renew authentication without deleting the paired device, its references or user Flows.

The new Repair pages support **German and English**, including a language selector. Existing values are reused or migrated rather than discarded. Safety-critical garage changes are guarded while a garage mission is active; relevant legacy migration settings require confirmation instead of silently resetting safety assumptions.

**Map functions and manual P1–P5 management are independent of Garage Mode.** Only gate interlocks and garage-specific automatic point rotation depend on it.

### Native mower map in the device view

The native mower map is available in the Homey device interface.

This is a static/updated map media feature, **not camera streaming**.

The map can show position, route, mowing pattern, maintenance points, pylons, native no-go zones and relevant optional garage geometry.

### Map widget improvements and independent layer visibility

The standalone **Mower Map** widget has been revised for map editing, clear pending/error states and a more controllable display. Its settings include independent toggles for:

- Mowing zones (`show_zones`)
- Forbidden/no-go areas (`show_forbidden`)
- Spot areas (`show_spots`)
- Mower position (`show_robot`)
- Detected obstacles/pylons (`show_obstacles`)
- Driven route (`show_path`)
- Alternating light/dark mowing pattern (`show_direction`)
- Maintenance-point markers (`show_maintenance_point`)
- Garage/safety overlays (`show_garage_overlay`), effective only when Garage Mode is enabled

These **presentation switches never deactivate a native safety zone**. The alternating mowing pattern is drawn from recorded movement directions and remains distinguishable from turns; it is not just a transient directional arrow.

The map also shows native-zone pending/readback status, named maintenance points and the current ★ primary point. Native map editing is shared with the Repair map editor and the Total Overview's embedded map controls.

### Rebuilt Total Overview widget

The **Total Overview** combines the mower's native map and status with **Start, Pause/Resume, STOP, Return, maintenance-point selection and map editing**. The embedded map can be expanded, refreshed and switched into its editor, with no need to leave the dashboard.

With **Garage Mode enabled**, the overview additionally provides gate state, sensor/safety indicators, physical clearance and recovery information, and conditional door actions. A contextual original-app maintenance-point selection is shown when a manufacturer task cannot reliably identify its destination.

In emergencies or uncertain states, the widget offers **supervised manual takeover**, including a guided recovery wizard, native docking rechecks, visual gate/position reports, explicit mower/waypoint/door commands, and the option to hand control back to the original app. Human reports are **not** disguised as native telemetry or sensor confirmation.

Homey widgets are registered statically, so Total Overview **remains selectable when Garage Mode is OFF**. Ordinary mower/map functions continue to work; garage automation is hidden or gated as appropriate, while explicit diagnostics/recovery may remain available in exceptional states.

### New consolidated notification Flow

A new Flow trigger:

`garage_mower_notice`

provides structured tokens such as:

- `kind`
- `message`
- `reason`

It is intended to simplify notifications and reduce duplicate routine alerts.

**Existing emergency, safety, gate and maintenance triggers remain registered and functional.**

The new card is an additional unified interface, not a breaking replacement for existing Flows.

### Stable controls and lower update overhead

Pause/Resume controls, maintenance-point buttons and garage-related tile feedback have been revised.

Capability-option writes are serialized and deduplicated to avoid unnecessary device reinitialization or Flow-card recreation.

MQTT event processing and polling are kept bounded, with stale information treated conservatively.

No unmeasured CPU or memory benchmark is claimed.

---

## 13. Compatibility with existing users and your PR #9 feedback

The revision also addresses the specific concerns you raised previously.

| Your earlier concern | CORE approach |
|---|---|
| Missing English translations | New UI and operator messages use English/German localization |
| `slow_motion_enabled` removed without migration | Setting retained |
| `lawn_care_mode` added and immediately removed | Unnecessary upgrade migration removed |
| `turning_method` visible on unsupported LiDAX hardware | Capability conditional on supported native PRE data |
| Homey compatibility raised to 12.7 | CORE retains `>=12.3.0` |
| Windows CRLF-related test failures | LF normalization through `.gitattributes` |
| Phase zones may be absent when Homey is unavailable | UI and documentation explain dependency and pending behavior |
| Vendor PRE fields could be overwritten | Your upstream read-modify-write approach preserved |
| Video SDK and native binary licensing | Camera dependencies completely excluded |
| EvotecIT contributor attribution | Attribution requirements retained |
| FLV server lifecycle | Not part of CORE; reserved for future camera review |

Existing settings and stable Flow/capability identifiers are intended to remain compatible.

The new MQTT processing and UI changes should not require an existing user to delete and re-pair the mower.

An upgrade smoke test with an existing paired device is still recommended before merging.

---

## 14. Camera functionality is a completely separate project

I want to emphasize this distinction because the previous combined PR made the review unnecessarily difficult.

### CORE and camera are independent review scopes

Only the CORE mower integration is being submitted in PR #10. The experimental video functionality was removed from the contribution rather than being treated as an optional mode in the same package. There is **no second version or video variant to review or merge in this PR**.

### Why the camera is excluded

The camera implementation introduces additional questions that are unrelated to the mower's native controls:

- Tencent XP2P SDK usage rights
- AOSP/Bionic/VNDK license and NOTICE obligations
- Native Android compatibility libraries
- Provenance of custom libraries and shims
- Reproducible build instructions and binary hashes
- Security and local streaming server behavior
- Optional installation and activation
- Third-party contributor attribution
- Manufacturer authorization and redistribution rights

You rightly raised these concerns in your earlier review.

I contacted Dreame on October 8, 2026, about an authenticated, opt-in Homey-local camera integration.

The responses received on October 12 and 14 did not provide written authorization or official SDK/API permission for the unofficial integration.

A technical prototype functioning locally does not resolve that legal uncertainty.

Similarly, the availability of Tencent XP2P artifacts through Maven Central does not automatically grant redistribution or third-party integration rights.

### Proposed camera process

I would therefore only consider a future **camera-only draft PR** after:

1. CORE has been independently reviewed and accepted.
2. Camera dependencies have been documented separately.
3. The origin and licensing of native binaries have been verified.
4. Required NOTICE and attribution requirements have been satisfied.
5. Reproducible build information is available.
6. Any necessary permissions have been obtained.
7. You agree that a separate camera review is appropriate.

Until then, **nothing camera-related is requested for inclusion in the Homey app**.

The deeper native MQTT integration described in this PR is part of CORE. It does not depend on Tencent XP2P or any video component.

---

## 15. Field tests and automated verification

The primary physical test setup is:

**MOVA A2, model g2408, with Homey Pro 2023**

The development process included supervised real-world testing of:

- Original-app mowing starts
- Early native undocking detection
- Garage opening and open-state confirmation
- Controlled departure and gate closure
- Native P1/P2 maintenance-point arrival
- Original-app return interception
- Direct versus waypoint-assisted return decisions
- Temporary native no-go-zone deletion
- MAPD confirmation
- Parallel gate opening during return
- Verified docking and charging
- Native zone restoration
- Final safe gate closure
- Pause/Resume and Homey widgets

### November 3 regression and successful retest

One supervised field run revealed a transient native status conflict during map editing and a lost verified MAPD result between return branches.

These issues were corrected.

A later supervised A2 return confirmed native zone removal, authoritative MAPD readback, parallel gate opening, automatic guarded docking, zone restoration and gate closure without manual recovery.

The initial failed run remains documented alongside the successful retest.

### CORE testing and validation

The **CORE implementation has been tested on the real MOVA A2**, including manufacturer-app departures/returns, safe gate operation, physical maintenance-point arrival, native zone deletion and restoration with MAPD confirmation, docking, Pause/Resume, and Homey maps/widgets.

A CORE-only source test run passed **270/270 automated tests**. **Homey application validation was also completed successfully for the tested CORE build**, as confirmed by the contributor.

The final PR branch includes subsequent focused safety hardening and **nine additional regression test cases** for map-mutation authorization and maintenance-point learning without Garage Mode. Targeted functional checks of those revised methods passed. For independent maintainer verification, please rerun the full `npm test` and `homey app validate --level publish` checks on the PR head, and check an upgrade with existing settings/Flows. These are review recommendations, **not claims that the already-tested CORE functionality is unvalidated**.

Testing was performed on a MOVA A2 (g2408) and Homey Pro 2023; it is not a formal safety certification for every other mower model.

---

## 16. Suggested review order

Given the size of this contribution, I suggest reviewing it in the following sequence.

**1. Native MQTT and command detection**

Start with the MQTT event handler in `drivers/mower/device.js`, particularly native docking/undocking state, live position, task status, control-status correlation and original-app command detection.

This explains why the revised garage and maintenance workflows are possible.

**2. Garage safety state machine**

Review `lib/garage/GarageSafetyEngine.js`, including early original-app start interception, return interception, gate verification, safety lines, supervised recovery and the three-stage closure logic.

**3. Native map changes**

Review `lib/MovaApi.js` and the corresponding `device.js` transaction handling, especially safe stationary checkpoints, native mutation authorization, MAPD/MAPI verification and lifecycle ownership.

**4. Maintenance points**

Review P1–P5 identity, naming, manufacturer-app learning, physical arrival verification, fallback restrictions and optional rotation.

**5. Homey compatibility**

Review the Repair interfaces, device-view map, Total Overview, localization, capabilities, migration and Flow integration.

### Additional documentation

- [Detailed English CORE review guide](https://github.com/daCream87/com.mova-dreame.mower/blob/09d5ea19c5d3ba722eb2a247909dbdc675953f8d/docs/A2_CORE_1_2_0_REVIEW_GUIDE_EN.md)
- [German feature and safety handoff](https://github.com/daCream87/com.mova-dreame.mower/blob/09d5ea19c5d3ba722eb2a247909dbdc675953f8d/docs/A2_CORE_1_2_0_UEBERGABE_DE.md)
- [Original PR #9 feedback and review scope](https://github.com/daCream87/com.mova-dreame.mower/blob/09d5ea19c5d3ba722eb2a247909dbdc675953f8d/docs/PR1_CORE_STAGED_REVIEW.md)
- [November 3 native MAPD and return regression](https://github.com/daCream87/com.mova-dreame.mower/blob/09d5ea19c5d3ba722eb2a247909dbdc675953f8d/docs/NOV03_FIELDLOG_MAPD_RETURN_FIX_DE.md)
- [Focused native map-edit and garage-off learning tests](https://github.com/daCream87/com.mova-dreame.mower/blob/09d5ea19c5d3ba722eb2a247909dbdc675953f8d/tests/pr10-native-edit-and-no-garage-learning.test.js)

---

## 17. Final remarks

I realize this is a substantial contribution, but the larger feature set is connected by a common architectural goal:

**Allow Homey to understand and safely coordinate the mower's real native behavior, including actions initiated outside Homey through the original MOVA/Dreame app.**

The deeper MQTT integration is the foundation for that.

It provides the timely native events needed to observe departures, returns, maintenance tasks, physical position changes and state transitions.

The garage layer then builds on that information, adding safety-controlled gate operation when enabled.

The native map layer maintains real manufacturer no-go-zone geometry, including conditional lifecycle changes.

Maintenance points are identified and verified from actual native tasks rather than guessed coordinates.

These functions remain useful independently wherever possible, especially for users without a garage.

And, importantly, the experimental camera implementation remains outside this contribution.

I hope the revised scope and documentation make it easier to assess the CORE functionality on its own merits.

Thank you again for your previous review and for maintaining the project. I am sorry that I did not respond to your feedback in time, and I appreciate your consideration of this new, more clearly separated PR.

Best regards,

**daCream87**

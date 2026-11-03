# A2 CORE: native map and no-go-zone lifecycle, garage safety, maintenance points and Homey UI (based on upstream 1.1.43)

## Why a new PR after #9?

Hi Andi,

Thank you for taking the time to review [#9](https://github.com/andiwirz/com.mova-dreame.mower/pull/9), and sorry I did not reply before it was closed. I continued real-world testing and the previous scope turned out to be too large to responsibly review or merge as a combined CORE/video contribution. In particular, the native no-go-zone lifecycle, pending/readback handling, manufacturer-app returns, position snapshots, maintenance-point recovery and garage interlocks required multiple rounds of fixes. Rather than claiming the original PR was ready, I have rebuilt the proposal as **CORE first, without live video**. I would be grateful if you could review this as a fresh contribution against your latest **1.1.43**, which already includes your native PRE read-modify-write and your fixes from #9. The camera would be offered separately **only after CORE is merged and the outstanding licensing/permission review is resolved**.

The main target is the MOVA/Dreame A2 (g2408) in a real Homey Pro 2023 setup. Garage-specific automations are optional; unrelated models should retain their existing normal behavior. A full regression suite and a successful supervised A2 field session support this change, but some exceptional safety branches are software-tested only, not physically certified.


### 3 November supervised return regression: P1 map-edit status glitch

A field log from a private A2 camera build showed native manufacturer editor TASK `200` and `204` accepted, followed by a transient `MOWING` label that incorrectly vetoed the actual `218` deletion. The mower was at a confirmed P1 waypoint with STOP/IDLE. We now permit this *specific* map-editor telemetry exception **only after** task-free native IDLE and two fresh matching native position witnesses from the same token/map during the edit. It does not relax actual motion, gate, danger or DOCK interlocks. A later MAPD confirmation was also lost when return control re-entered the waypoint branch; the verified result is now passed between return paths to avoid a false manual recovery. Eight dedicated regression cases cover permissions and re-entry. See `docs/NOV03_FIELDLOG_MAPD_RETURN_FIX_DE.md`. A subsequent supervised 3 November A2 return confirmed native zone deletion, concurrent gate opening, docking and zone restoration without manual recovery. This does not establish safety certification for other devices.

## What this CORE PR adds

### 1. Repair-oriented configuration, without deleting user settings

- **Mower → Repair → Map editor:** edit map markers, native zones, pylons and their lifecycle rules; see live native confirmation / pending state.
- **Mower → Repair → Maintenance points:** name and select **P1–P5**, choose the primary point, inspect which vendor coordinates have actually been confirmed. Point names are Homey metadata, not guessed mower coordinates.
- **Mower → Repair → Garage Mode:** configure gate sensor, garage markers/geometry, A/B safety line, caution/danger area and **fixed or alternating maintenance-point routing**. The garage panel appears only when garage mode is relevant.
- **Mower → Repair → Reconnect:** re-authenticate without deleting/re-pairing the device.
- Older settings, native identifiers, saved mission/route state and Homey flow capabilities are **migrated or reused**, not casually replaced. The original `slow_motion_enabled` option is retained. `lawn_care_mode` is not added and then removed again during migration. The `turning_method` picker is added only where native PRE[19] is supported; PRE writes use your upstream 1.1.43 read-modify-write behavior to preserve unknown vendor fields.
- Existing flows are not deliberately removed. Some new functions have dedicated actions/triggers; a capability/Flow Card is not recreated just to refresh map data. Dynamic Pause/Resume and Garage Mode tiles remain, with cached and serialized `setCapabilityOptions()` updates to avoid concurrent duplicate writes/device reinitialisation (related to the Homey Flow editor issue reported in August).

### 2. Native no-go zones, not merely a visual overlay

- Convert a detected **pylon / obstacle / problem spot** into a **real, mower-enforced square native no-go zone** with selectable protection radius (minimum vendor geometry respected), name and lifecycle. A pylon stays a detected location; the red zone becomes active **only after native map confirmation**.
- Also manage **compatible zones originally created in the official MOVA/Dreame app**. Local labels, native polygon geometry, map index and lifecycle ownership are tracked separately; a native zone ID alone is never treated as permanent identity, because firmware can renumber/reuse IDs.
- Lifecycle policies: **permanent**, **3/7/14 days**, **departure only**, **departure + mowing**, **mowing only**, **mowing + return**, **return only**. These policies actually add/remove the native mower polygon when the required phase changes, not just hide its Homey icon.
- **Safety-driven pre-arming, clarified in UI:** because native edits need `IDLE` and confirmed stillness, both **Mowing only** and **Mowing + return** are physically armed at the station *before departure* and stay active during departure. The phase name describes when protection is required; it is **not** a promise of exact phase-only hardware enforcement. **Return only is no longer pre-armed on departure**: it is added at an independently verified task-free return checkpoint, or is left pending/unconfirmed. This remains independent of Garage Mode. If a phase does not require a native geometry change, there is **no additional map-edit STOP**. Live gate/line safety pauses can still occur independently.
- Example: protect soft ground at the garage while leaving and mowing, then **remove the real native polygon before the final return**, and **restore it after verified docking**. This allows a return corridor to remain protected at other times without trapping the mower on the way home.
- User-created manual deletion is different from Homey's **temporary** lifecycle removal: explicitly deleted zones and stale labels are not secretly resurrected; temporary lifecycle-owned geometry is restored when required. Geometry+map-aware matching prevents old zone #103 labels/policies being applied to a new zone #102.
- Map mutation requires a **native task-free, confirmed stationary checkpoint**: STOP must actually finish, the mower must not still be running/PAUSED in a vendor task, and authoritative **MAPD/MAPI readback** must confirm create/remove. An accepted API write alone is **not** success. Editing while moving is deferred to the next safe checkpoint.
- The bounded native readback wait is **30 seconds** for return checkpoints. Both add/remove editors show a **10-second, cancelable close countdown** after an accepted request, then close while a **blue animated Pending marker** continues on the map until authoritative confirmation. Failed commands keep the dialog open and show the error; stale Pending operations are recoverable/recheckable.
- The native map editor and **all nine native no-go-zone policies, including mission-phase-only rules, remain configurable without Garage Mode**. The mower still requires confirmed task-free `IDLE`, a verified stationary checkpoint and native MAPD readback before any real map change. With an original-app mission and no safe checkpoint, a phase transition remains pending instead of silently rewriting the map while the mower is moving; Homey must be reachable to observe the mission. Garage Mode controls only gate, danger/line interlocks and garage-specific automatic waypoint rotation.

**Why stop and start again?** The A2 firmware may acknowledge a no-go-zone write during a task without applying it. Therefore, **only if a return-phase zone transition is actually required**, the garage return flow preserves the return request/route and pre-edit position, securely stops the native task, changes and verifies the polygon, refreshes the physical position, and dispatches a new guarded native return or a verified waypoint detour. **No extra STOP/MAPD cycle is injected into ordinary returns with no required zone mutation.** Completed mowing traces/patterns are retained for visualization. This is *not* a claim that every arbitrary manufacturer mowing task can be losslessly reconstructed after a STOP; route/task context is re-established only through supported native commands and safety checks.

### 3. P1–P5 maintenance points, naming, recovery and rotation

- Independent **named P1–P5 buttons** appear dynamically on the device and overview surfaces, including a point whose name exists but whose coordinates have not yet been confirmed. Unknown coordinates are clearly shown as **unverified**, not silently replaced with another point.
- To learn such a point: name e.g. **P2 – Lawn end** in Repair; select it; Homey safely prepares/opens the gate if necessary, then asks the operator to request that exact native point **from the manufacturer app**. This is needed because the original vendor command may not communicate a reliable target index back to Homey. Homey watches the native request and stable physical arrival, then stores the actual coordinates. A native arrival code `75` **alone is not enough**; task context, a fresh position and matching geometry are required.
- The explicit point-selection context remains available for **15 minutes**. When the original manufacturer point command was observed but the arrival acknowledgement is missing after **30 seconds**, Homey first re-reads location and status. At most **one** native `109` backup request for that **same identified point** is permitted *only* when independent stable/outside/safety evidence supports it. No blind retry while moving, at the door, on a different map or after an already-confirmed arrival.
- Normal point commands work with Garage Mode OFF; **automatic rotation** requires enabled Garage Mode and **at least two confirmed points**. The selected primary advances once after a genuinely completed mowing session **and physical dock confirmation**. Duplicate MQTT/poll completion reports cannot rotate twice; an unconfirmed point never becomes the automatic fallback destination.
- Waypoint arrival can close the gate according to the same interlocks, without treating a naming/UI change as physical confirmation.

### 4. Garage Mode, original-app interception and fail-safe return

- Capture external manufacturer-app start/undocking **before unsafe departure**. Pause the active native movement as needed, open and verify the gate and only then resume the intended job; display adjustment/positioning and departure states without prematurely closing.
- Closing priorities are distinct: **Priority 1** confirmed physical exit/clearance; **Priority 2** stable line/side and dwell evidence; **Priority 3** after **three qualified A/B line-crossing attempts**, controlled PAUSE → independently recheck distance/status → CLOSE → verify gate closed → RESUME. Three raw line contacts are **not** by themselves permission to close on a mower in the doorway.
- A separate closed-gate approach / danger-zone guard protects active returns. The safety line is a **hard checkpoint**: if current position or confirmed door OPEN status is missing, the mower is paused/stopped instead of crossing toward a closed gate. Sensor evidence is used when configured, with guarded fallback handling for unavailable sensors.
- Manufacturer-app **return**: preserve the *original* location and timestamp, independently measure the *actual stopped* position after any braking distance, recalculate side/ETA when needed, and pre-open the gate in parallel when there is enough lead time. With short ETA the mower waits before gate opening; physical line/danger guards remain active. If a required map edit cannot safely occur directly, prefer a **confirmed P1–P5 waypoint** detour over immediate manual intervention. Native STOP/IDLE and MAPD confirmation remain mandatory before map mutation.
- Return concludes only after verified station/docking evidence. Restore any temporary no-go-zone geometry when required and close the gate only after physical clearance; a late stale `returning` update cannot restart an emergency after verified docking.
- **Recovery / supervised visual takeover:** the separate Recovery interface allows the owner to explicitly confirm physical mower/gate conditions, manage gate and mower steps, choose confirmed waypoints and guide the mower home if automatic paths cannot be verified. A visual confirmation is **not** faked as a sensor state, and manual takeover does not disable independent collision protections. Automatic modes are the preference; manual mode is the last resort.

### 5. Views and Flow features

- Mower device view: native live mowing map, route, final lane/pattern rendering, current point/position and dynamic mower commands.
- Map widget, **Total Overview**, embedded and Repair map editors share mower/map state and distinguish pending edits, native confirmation, historical route and active mowing. Homey-native map image is preserved across hard refresh rather than going black.
- Native MQTT telemetry is preferred while fresh, with serialized polling and a fallback for stale telemetry. Update frequency and capability option writes are bounded/deduplicated; no repeated capability migrations on normal task updates.
- The existing core Flow actions/triggers stay addressable; new targeted garage notices, STOP and maintenance controls use separate event IDs. A change of a Flow Card's UI layout does **not** intentionally discard previously configured Flow actions or migrate their parameter values to unrelated IDs.
- English/German messages and labels use localized resources or UI language helpers, with English fallback. Windows checkout uses `.gitattributes` LF convention.

## Verified scope and explicit limits

- Regression suite: source release contains the upstream tests and focused A2 zone/garage/maintenance/i18n tests. The final reviewed private CORE 1.2.154 snapshot ran **1,450/1,450 tests** and private CAMERA 1.2.155 ran **1,517/1,517**. The CORE-only upstream-based public PR source independently passed **270/270 tests** after extraction. Automated tests are *not* proof of collision safety on other hardware or a measured low CPU usage figure.
- **Supervised MOVA A2 field run, 2 November 2026:** original-app departure, A/B exit and gate close; P2 native `109`/arrival `75` with position confirmation; original-app return with current position preserved; native zone removal; overlapping early gate opening and verified return; physical docking/charging, zone restoration and gate closed by actual contact. These happened on the contributor's A2, not on other mower models.
- Critical abnormal situations (three repeated crossings, closed-gate emergency, sensor loss, race conditions) have code/regression coverage; not all were deliberately reproduced physically.
- For historical users with `slow_motion_enabled`, the option stays accessible; no automatic change to LOW schedule is forced. Turning picker is conditional on native PRE support.
- CPU and network traffic have **not** been benchmarked on the maintainer's or contributor's hardware for this final package. Polling serialization and duplicate write suppression are preventive measures, not quantified performance claims.
- Independent garage controls depend on actual mapped safety geometry, a correctly functioning sensor/flow if configured, and physical observation during initial deployment.

## Why video is deliberately excluded

This PR contains **no** Tencent SDK use, video worker, local video server, camera widget, video settings or Android compatibility/shim runtime. My earlier combined PR made legal and technical review unnecessarily difficult.

I contacted Dreame on **8 October 2026** to ask about the use of a strictly opt-in, authenticated, Homey-local camera. Dreame replied on **12 and 14 October** that unofficial integrations are not supported and **no written authorization or SDK/API approval** is provided. The correspondence and the separate Tencent/AOSP/shim provenance/build audit are preserved for a future **separate DRAFT camera PR**. The technical approach uses Tencent XP2P 2.4.50 fetched from Maven Central, but a public artifact and version pin do **not** themselves confer usage or redistribution rights. The exact binary-license scope, AOSP NOTICE obligations and custom shim origin/build reproducibility must be reviewed and, where necessary, permission obtained **before** any Camera Store release.

## Requested review order

1. Please review **CORE independently** against your 1.1.43 HEAD, especially capabilities/setting migration, the native zone transaction and return/mower-stop interlocks.
2. Check that the new Repair views and Flow integrations do not replace existing stable identifiers; consider testing with a previously installed device.
3. Check the i18n fallback and Homey publish validator in your own environment.
4. Once CORE is accepted, I can rebase a **camera-only draft** on your merged branch with complete correspondence and third-party notices for a separate discussion. I will not describe it as licensed or authorized without that review.

Thanks again for the careful feedback on #9, especially the `slow_motion_enabled`, PRE, turning-mode, English localization and capability migration observations. Your 1.1.43 changes are treated as upstream functionality and retained rather than replaced.


## Consolidated feature/dependency walkthrough for maintainers (PR #10 review update)

### Repair / Manage mower is the central bilingual configuration entry

The **device → Repair → Manage mower** screen organizes **Map editor**, **Maintenance points**, **Garage Mode** (only when enabled), and **Reconnect**. Screens, buttons, confirmations and safety messages are provided in **English and German**; the user may choose DE/EN. Map editing and point naming must NOT depend on an enabled garage. Garage-specific door/contact/line controls remain behind the enabled Garage Mode setting.

The map itself is also exposed as a Homey **device-view mowing-map image**; this static map-media feature is **not video/camera streaming**. The standalone map widget and **Total Overview** dashboard complement the device controls.

### Exact native map user experience

Select **Edit**, tap a detected pylon or an existing red no-go zone, enter a **name/description** and a **protection radius** where applicable, and choose its native lifecycle. The policies are **permanent**, **3/7/14 days**, **departure only**, **departure + mowing**, **mowing only**, **mowing + return**, and **return only**. These policies are independent of Garage Mode. To avoid a gap in protection, "mowing only" and "mowing + return" may be pre-armed **before departure**, while "return only" must wait for a verified safe return checkpoint: the labels are user intents, not permission to edit a map during a task. Real mower polygons, not merely displayed icons, are added and removed when safe. The interface includes visible **blue pending states**, a **10-second cancelable close countdown** after accepted writes, and reload/recheck for unconfirmed edits.

An A2 native edit uses the vendor editor's **200 → 204 → 215 (create/update) or 218 (delete) → 201** sequence. A successful API or MQTT TASK acknowledgment alone does **not** certify the changed map. The system checks **actual MAPD/MAPI geometry**, associated map/index and stable identity, including compatible zones created in the original MOVA/Dreame app and cross-checking cloud readings. Mower-assigned zone IDs can be recycled; matching uses **geometry plus map identity**, not just an ID. Actual moving/PAUSED tasks cannot be rewritten as if stationary; unknown or anomalous map contents stay pending or blocked. Ordinary/manual edits now also have a **post-200/204 native IDLE or independently verified IN_STATION plus two native position reads** check immediately before the physical mutation; return edits retain their stricter, separate return-token/position/door checks.

### P1–P5 creation, editing, starred current point and grass protection

Users can configure **up to five named maintenance points** (P1–P5), **rename** their labels in Repair or by choosing **Edit → tap point on map**, and select the primary point. A **★ star marks the currently selected primary point** on the native map. A name is Homey metadata and does not conjure native coordinates. A named, as-yet-unconfirmed P2–P5 is shown on the device card but never dispatched as a blind motor command or substituted with P1.

To **learn an unknown point**, first press its **named point button on the Homey mower device card**. With **Garage Mode ON**, Homey requires native station evidence, commands/validates a safe **gate opening**, and only then prompts for the **same P-number in the original manufacturer app**. With **Garage Mode OFF**, the button arms **the same manufacturer-app arrival observer without operating any gate**; then command that exact waypoint in the original app. A native opcode **109** by itself is not coordinate proof: Homey checks the genuine original-app task, map, stable physical arrival/firmware **75** and geometric identity before storing the coordinates. An unconfirmed point is not used for automatic return; a narrowly controlled single native fallback is confined to validated garage-mode evidence, never automatic when garage mode is OFF.

To avoid wear and lawn damage at one repeated stopping spot, optional **automatic waypoint rotation** is available **only when Garage Mode ON and at least two native-confirmed points exist**. Fixed and alternating modes are available. The point advances **once after completed mowing and independently confirmed docking**, not upon duplicate telemetry or a simple rename. All point buttons and Flow IDs preserve their underlying P-index to avoid existing Flow breakage.

### Garage start/return and timing

With Garage Mode ON only: intercept original-app departure, stop/pause an unsafe initial task until the gate is physically opened and confirmed, check safety line and danger area, and close only when independently cleared. **Priority 1** confirms safe exit; **Priority 2** uses stable line/side/dwell data; **Priority 3** requires three qualified crossing attempts and rechecks position after PAUSE before CLOSE/RESUME. None permits closing on a mower in the opening.

An original-app return preserves the **first location** and the **actual post-stop location** separately. Decide direct return versus a verified waypoint route from geometry and ETA, not a stale map tile; when possible begin opening the gate in parallel. A return needing a **physical native zone edit** stops at a proven safe checkpoint, performs native task-free STOP/IDLE and bounded map confirmation, then resumes guarded DOCK/waypoint navigation. **Without a required geometry change, the extra map-edit STOP is skipped.** The restart schedule allows a conditional **18-second initial credit** only after a physically proven native zone STOP with live sensor and line protection, not as a blanket allowance. The gate safety-line brake remains independent. The native return-map readback budget is **30 seconds**, not an unlimited retry loop.

Recovery/visual takeover separates operator observations from physical native/gate-contact proofs; it does not silently overrule collision safeguards. The **Total Overview widget itself remains addable without Garage Mode** because widget registration is static. The garage summary and automatic gate controls are dynamically gated; normal mowing map/dashboard remains useful without Garage Mode, and explicit supervised rescue can still be shown in exceptional/off modes. Please do not describe this as the entire widget disappearing from Homey's picker.

### Flow compatibility, UI load and camera boundary

Use the single new **`garage_mower_notice` Flow trigger** (`kind`, `message`, `reason`) for consolidated, bilingual, deduplicated informational and safety notices. Optional routine notifications obey Garage Mode settings; mandatory safety signals still fire. **Legacy emergency/safety/door triggers are deliberately kept** and can also fire so existing user Flows do not disappear: "one central new notification card" means a consolidated *new interface*, not deletion of the historical triggers.

Dynamic Pause/Resume, garage toggles and waypoint buttons retain their identities. Serialized/deduplicated `setCapabilityOptions` writes avoid repeatedly recreating Homey Flow cards. MQTT position updates, conservative polling and map snapshot refresh remain load-controlled.

**No live video** or Tencent XP2P, Android runtime/shims or redistributed binaries are included. Camera requires a separate optional PR **after** CORE acceptance and separate third-party licensing, provenance and build review.

**Verification boundary:** supervised A2 field runs and the prior 270/270 extracted-CORE tests predate this final review-hardening commit; nine focused new regression cases have been added, but the exact updated branch still requires executing `npm test`, Homey publish validation and upgrade smoke testing. Do not infer physical certification for other models.

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

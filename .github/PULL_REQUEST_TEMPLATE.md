## Scope / Ziel

- CORE-only feature contribution against upstream **1.1.43** (no camera, XP2P, native video or redistributed binaries).
- Explain real native no-go-zone lifecycle, P1–P5, optional garage safety, maps/widgets and backward-compatible settings.
- The camera proposal is separate and not yet cleared for public redistribution.

## Safety / Sicherheit

- [ ] A2 native map edits require confirmed task-free, stationary state and MAPD readback.
- [ ] Actual gate contacts, native position and operator observations are not conflated.
- [ ] No unnecessary map-edit STOP when the return requires no zone mutation.
- [ ] Automatic safety paths and manual recovery are clearly distinguished.

## Verification / Prüfung

- [ ] `npm test` on the PR branch.
- [ ] `homey app validate --level publish` on the actual submitted branch.
- [ ] Check migration and existing flow cards on an upgrade installation.
- [ ] Note supervised A2 field evidence and remaining untested emergency cases.

Reviewer overview: `docs/A2_CORE_1_2_0_REVIEW_GUIDE_EN.md`.
Detailed latest return evidence: `docs/NOV03_FIELDLOG_MAPD_RETURN_FIX_DE.md`.
Review-history summary: `docs/PR1_CORE_STAGED_REVIEW.md`.

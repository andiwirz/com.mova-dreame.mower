# Optional Garage Mode

Garage Mode safely integrates a MOVA/Dreame mower stored behind an automated garage door. It is disabled by default and leaves the original mower behaviour unchanged until configured.

## Main functions

- Automatic door opening before departure and before final return.
- Contact-sensor verification with time-based fallback.
- Configurable A-B safety line with direction-aware crossing detection.
- Danger and caution areas around the garage.
- Optional maintenance waypoint routing.
- Safe pause at the safety line while the door is not confirmed open.
- Automatic continuation after the door opens.
- Door closing only after a safe departure or confirmed docking.
- Recovery after interrupted starts and delayed cloud/sensor events.
- Stable Pause/Resume behaviour, including contextual Resume through Start Mowing.
- External return detection for returns initiated in the MOVA/Dreame app.
- Live map overlays and editable garage safety markers.

## Safety principle

A safety-line crossing alone never starts a return while the mower is mowing or paused. A return requires an explicit or confirmed return context. If a returning mower reaches the safety line before the door is safely open, it is paused there and resumed only after opening is confirmed.

## Compatibility

Existing devices and users remain unaffected while Garage Mode is disabled. The implementation retains the upstream Resume Mowing capability, action and trigger introduced before this feature release.

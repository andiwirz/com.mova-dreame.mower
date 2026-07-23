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


## Deterministic return routing

At return detection the route is selected once from fresh map geometry:

- Mower on the lawn side: ETA to the A-B safety line decides between direct return and the maintenance route.
- Mower on the garage side, inside the danger area, or detected late in front of a closed gate: always route through the maintenance point.
- The maintenance coordinate is resolved once and locked for the complete return cycle; live telemetry and map refreshes cannot move it.
- On a direct return the A-B line is a hard interlock. If the door is not proven open by the healthy sensor, or by the configured time when the sensor is disabled/unavailable, the mower pauses at the line.
- In the maintenance route the door stays unchanged until arrival at the locked point has been confirmed by fresh positions and stable stopped-state samples.

## Emergency recovery

Emergency Mode has priority over all normal return states. If a mower is detected in the gate area while the gate is moving, the gate direction is reversed (opening to closing, closing to opening), the mower is evacuated to the locked maintenance point, and only after confirmed arrival is the gate opened and the mower released for safe docking. Maintenance timeouts never release the gate or docking command.

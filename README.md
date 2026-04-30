MOVA & Dreame Mower connects your robotic lawn mower to Homey, giving you full control over mowing schedules, zones, and device health — all from a single app. Whether you own a MOVA or Dreame robot, the integration works through the official cloud API and supports European and Chinese server regions.

The app exposes the complete feature set of your mower: live battery and charging status, mowing progress, error detection including tilt and obstacle alerts, consumable health tracking for blade, brush and robot body, as well as Do Not Disturb and child lock controls. Flow cards let you automate every aspect of your mower — start a zone mowing session when the weather clears, get notified when the blade needs replacement, or automatically return to dock at sunset.

## Pairing

Open the Homey app, add a new device and select your brand (MOVA or Dreame) and region. Enter the same email address and password you use in the official MOVA or Dreame smartphone app. The integration will discover all mowers linked to your account.

## Flow Cards

**When...**
- Mower status changed
- Charging status changed
- Mowing completed
- Mower docked at station
- Mower error occurred
- Obstacle detected
- Mower tilted
- Battery is low (configurable threshold)
- Consumable health is low (blade / brush / robot body, configurable threshold)

**And...**
- Mower is / is not mowing
- Mower is / is not docked
- Mower is / is not charging
- Mower has / has no error
- Child lock is / is not enabled
- Mowing mode is / is not (All Area / Edge / Zone / Spot)

**Then...**
- Start mowing
- Start zone mowing
- Start edge mowing
- Start spot mowing
- Pause mowing
- Stop mowing
- Return to dock
- Set mowing mode
- Find mower (audible alert)
- Clear recoverable error
- Set child lock on / off
- Set Do Not Disturb on / off
- Reset consumable counter (blade / brush / robot body)

## Supported Brands & Regions

| Brand | Regions |
|-------|---------|
| Dreame | Europe (EU), China (CN), North America (NA) |
| MOVA | Europe (EU), China (CN), North America (NA) |

## Notes

Zone and spot mowing require zones or spots to be configured in the official MOVA or Dreame app first. The zone and spot IDs used in flow cards correspond to the IDs assigned by the official app. Some advanced commands (find mower, fault suppression, consumable reset) are subject to real-device verification and may require a firmware update on older models.

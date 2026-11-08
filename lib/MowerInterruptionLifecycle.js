'use strict';

/** Andy upstream 1.1.44 — don't erase a rain/frost/low battery interruption
 * when MQTT briefly reports 'mowing' during the return to the dock.
 * Clears only after a real home/stopped observation or 2min continuous mowing.
 * No garage safety states are modified here.
 */
function updateInterruptionOnStatus(device, status, isMowing) {
  if (!isMowing) {
    device._mowingSince = null;
    if (device._interruption && HOME_STATUS_PREDICATE(device, status)) device._interruptionStopped = true;
    return;
  }
  if (device._mowingSince == null) device._mowingSince = Date.now();
  if (!device._interruption) return;
  const mowingFor = Date.now() - device._mowingSince;
  if (!device._interruptionStopped && mowingFor < 120000) return;
  device.log(`[interruption] cleared (${device._interruption.type}, code ${device._interruption.code}) — new run: `
    + (device._interruptionStopped ? 'started after the mower was home/stopped' : `mowing for ${Math.round(mowingFor / 1000)}s`));
  device._interruption = null;
  device._interruptionStopped = false;
}

function HOME_STATUS_PREDICATE(device, status) {
  return ['idle', 'standby', 'charging', 'docked'].includes(status);
}

module.exports = { updateInterruptionOnStatus };

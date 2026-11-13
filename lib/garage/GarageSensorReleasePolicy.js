'use strict';
/**
 * Explicit physical-contact policy. A configured contact sensor can be
 * unavailable, delayed or stale; a time estimate never proves it is OPEN.
 * Used only when sensor_enabled is set. Disabled-sensor installations retain
 * the original timer-only mode, and must be assessed separately.
 */
function allowTimedOpenRelease(sensorEnabled, verifiedRealOpen) {
  return !sensorEnabled || verifiedRealOpen === true;
}
function shouldWaitForPhysicalContact(sensorEnabled, verifiedRealOpen) {
  return sensorEnabled === true && verifiedRealOpen !== true;
}
module.exports={allowTimedOpenRelease,shouldWaitForPhysicalContact};

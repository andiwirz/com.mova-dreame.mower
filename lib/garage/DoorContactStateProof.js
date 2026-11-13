'use strict';
/**
 * A two-state magnetic contact is event-driven: OPEN persists until CLOSED.
 * Lack of a repeated OPEN event is NOT an indication that the door closed.
 * This is only a live-session contact proof, not a post-restart guarantee and
 * not a replacement for the gate-motion interlock or physical sensor wiring.
 */
function hasLatchedOpenContact({ sensorEnabled, liveOpenAt, contactState, stableOpen, sensorOnline, lastClosedAt, movementTimeoutAt }) {
  return sensorEnabled === true
    && contactState === 'open'
    && stableOpen === true
    && sensorOnline === true
    && Number(liveOpenAt) > 0
    && Number(lastClosedAt || 0) < Number(liveOpenAt)
    && Number(movementTimeoutAt || 0) < Number(liveOpenAt);
}
module.exports = { hasLatchedOpenContact };

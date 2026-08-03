'use strict';

/**
 * Native MOVA/Dreame maintenance-point commands use point index 1.
 * Confirmed on the A2 and identical to the original developer API command.
 */
function resolveMaintenancePointIndex() {
  return 1;
}

module.exports = { resolveMaintenancePointIndex };

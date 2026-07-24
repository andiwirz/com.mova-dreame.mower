'use strict';

/**
 * Resolve the native maintenance-point index without changing upstream behavior
 * for unknown models. Field tests show that Dreame/MOVA A2-family devices need
 * point index 2; index 1 aborts or targets the wrong point.
 */
function resolveMaintenancePointIndex(device) {
  const values = [
    device?._devModel,
    device?.getSetting?.('device_model_id'),
    device?.getSetting?.('device_model'),
  ].filter(Boolean).map((v) => String(v).toLowerCase());
  const model = values.join(' ');

  // Confirmed A2-family identifiers/names. Keep this deliberately narrow so
  // all other models retain the upstream default (index 1).
  if (/\ba2(?:\s*pro)?\b/.test(model) || model.includes('dreame.mower.g2422')) return 2;

  return 1;
}

module.exports = { resolveMaintenancePointIndex };

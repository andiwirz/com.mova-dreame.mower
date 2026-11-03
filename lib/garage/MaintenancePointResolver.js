'use strict';
// One authoritative garage waypoint decision, shared by return, evacuation,
// normal maintenance and the map. Explicit P2..P5 buttons remain independent.
// A name does NOT prove that the original MOVA waypoint has known geometry.
function availableGarageMaintenancePointIndexes(device) {
  const map = String(device?._activeMapIndex ?? 0);
  const native = device?._cachedMapData?.nativeMaintenancePoints || device?._cachedMapData?.maintenancePoints || [];
  const persisted = device?._storedAdditionalMaintenancePoints?.[map] || {};
  // A remembered arrival coordinate is not timeless native proof. It is scoped
  // to this map and expires unless the manufacturer map reports the point again.
  // Do not silently use years-old geometry after deletion/reconfiguration.
  const MAX_ARRIVAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const valid = p => !!p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
  const known = index => {
    const current = native.find(p => Number(p?.index) === index);
    if (valid(current)) return true;
    const point = persisted[String(index)];
    const age = Date.now() - Number(point?.updatedAt || 0);
    return valid(point) && age >= 0 && age <= MAX_ARRIVAL_AGE_MS;
  };
  const indexes = [1]; // P1 is the backwards-compatible garage baseline.
  for (let i=2; i<=5; i++) {
    const getter = typeof device?._getGarageManagedSetting === 'function'
      ? device._getGarageManagedSetting.bind(device)
      : (typeof device?.getSetting === 'function' ? device.getSetting.bind(device) : () => '');
    if (String(getter(`maintenance_point_${i}_name`) || '').trim() && known(i)) indexes.push(i);
  }
  return indexes;
}
function resolveMaintenancePointIndex(device) {
  // Primary selection is a Homey preference, independent of Garage Mode.
  const available = availableGarageMaintenancePointIndexes(device);
  const configured = Number(device._garageMaintenanceConfig?.primary || 1);
  // Preserve explicit fixed selection even if the map has not loaded yet:
  // automatic dispatch will HOLD on missing geometry, never switch silently to P1.
  const primary = Number.isInteger(configured) && configured >= 1 && configured <= 5 ? configured : 1;
  const cycle = Number(device._garageMaintenanceCyclePointIndex || 0);
  if (!device?.getSetting?.('garage_mode_enabled') || device._garageMaintenanceConfig?.rotation !== 'alternate' || available.length < 2) return primary;
  // A pinned native target stays fixed throughout its active garage cycle.
  // The persistent `primary` is the *next selected waypoint*. The previous
  // completed point is historical evidence, never a second selection source.
  if (available.includes(cycle)) return cycle;
  return primary;
}
module.exports = { availableGarageMaintenancePointIndexes, resolveMaintenancePointIndex };

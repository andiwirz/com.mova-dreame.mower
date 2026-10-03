'use strict';
const capabilities = { mow: 'cmd_start_mowing', spot: 'cmd_start_spot_mowing', pause: 'cmd_pause', stop: 'cmd_stop', return: 'cmd_dock', maintenance: 'cmd_maintenance_point' };
function find(homey, id) {
  if (!id) throw new Error('Mäher im Widget auswählen');
  const devices = homey.drivers.getDriver('mower').getDevices();
  const d = devices.find(x => [x.getId?.(), x.getData()?.id].filter(Boolean).map(String).includes(String(id)));
  if (!d) throw new Error('Ausgewählter Mäher nicht gefunden');
  return d;
}
function overview(d) {
  const e = d._garageSafety;
  const garageEnabled = !!e?.enabled?.();
  return { name: d.getName(), status: d.getCapabilityValue('mower_status'), battery: d.getCapabilityValue('measure_battery'),
    garageEnabled, door: e?.doorState?.() || 'unknown', doorStopped: !!e?._manualGateStopped, doorEstimated: !!e?._doorStateDerived,
    sensor: d.getCapabilityValue('garage_sensor_available_status') || 'unknown',
    safety: d.getCapabilityValue('garage_safety_status') || 'unknown',
    spotSelected: !!d.getCapabilityValue('mow_spot'),
    mission: e?._manualMaintenanceTransit ? 'maintenance' : e?.isReturnCycleActive?.() ? 'return' : e?._outbound?.requiresMowingStable ? 'mowing' : d._nativeMowerStatus,
  };
}
module.exports = {
  find, overview,
  async getOverview({ homey, query }) { return overview(find(homey, query.deviceId)); },
  async camera({ homey, query, body }) {
    const d = find(homey, query.deviceId);
    if (!d._standaloneVideo?.local) throw new Error('Kamera noch nicht bereit');
    const action = body?.action;
    if (action === 'diagnostic') {
      const stage = String(body?.stage || 'widget').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48) || 'widget';
      const message = String(body?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 240);
      d.log(`[video-widget] stage=${stage}${message ? ` message=${message}` : ''}`);
      return { logged: true };
    }
    if (action === 'flv_url') {
      // Explicit local video diagnostic only. The ephemeral token is returned to
      // the authenticated widget and is deliberately never written to logs.
      return d._standaloneVideo.local.diagnosticUrl(120000);
    }
    if (!['start','stop','snapshot','health'].includes(action)) throw new Error('Ungültiger Kamerabefehl');
    return d._standaloneVideo.local.control(action, body.client, { cursor: body.cursor });
  },
  async command({ homey, query, body }) {
    const d = find(homey, query.deviceId), action = body?.action;
    if (['gate_open','gate_close'].includes(action)) {
      const accepted = await d._garageSafety.manualGateRequest(action.slice(5));
      if (accepted === false) throw new Error('Toraktion durch Sicherheitsprüfung gesperrt');
      return { accepted: true };
    }
    const capability = capabilities[action];
    if (!capability) throw new Error('Ungültiger Mäherbefehl');
    // Use precisely the existing capability listeners, including momentary
    // command locks, beginUserCommand and all GarageSafetyEngine guards.
    await d.triggerCapabilityListener(capability, true, {});
    return { requested: true }; // request accepted, not a fabricated hardware ack
  },
};

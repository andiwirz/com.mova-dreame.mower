'use strict';
const msg = (homey, en, de) => String(homey?.i18n?.getLanguage?.() || 'en').toLowerCase().startsWith('de') ? de : en;
const capabilities = { mow: 'cmd_start_mowing', spot: 'cmd_start_spot_mowing', pause: 'cmd_pause', stop: 'cmd_stop', return: 'cmd_dock', maintenance: 'cmd_maintenance_point' };
const {availableGarageMaintenancePointIndexes} = require('../garage/MaintenancePointResolver');
function find(homey, id) {
  if (!id) throw new Error(msg(homey,'Select a mower in the widget settings.','Mäher in den Widget-Einstellungen auswählen.'));
  const devices = homey.drivers.getDriver('mower').getDevices();
  const d = devices.find(x => [x.getId?.(), x.getData()?.id].filter(Boolean).map(String).includes(String(id)));
  if (!d) throw new Error(msg(homey,'Selected mower not found.','Ausgewählter Mäher nicht gefunden.'));
  return d;
}
// Explicit dispatch keeps the emergency commands reviewable and makes it
// impossible to confuse a read-only dock check with an automatic release.
async function runRecoveryAction(rescue, action, supervised) {
  if (!rescue) return false;
  switch (action) {
    case 'recovery_confirm_open': return rescue.manualRecoveryConfirmGateOpen(supervised);
    case 'recovery_maintenance': return rescue.manualRecoveryToMaintenance();
    case 'recovery_return': return rescue.manualRecoveryReturnToDock();
    case 'recovery_takeover': return rescue.manualRecoveryOperatorTakeover(supervised);
    case 'recovery_rearm':
    case 'recovery_rearm_quick': return rescue.manualRecoveryRestoreNormal(false); // requires CLOSED visual attestation + native 2/2 dock
    default: return false;
  }
}
// Supervised contextual buttons do NOT override any normal garage command guard.
// A fresh independent 1:4 position pair is required before queuing an ordinary
// return/maintenance command. The underlying capability listener remains the
// only owner of the actual motor command and all its physical interlocks.
async function checkSupervisedPosition(d, rescue, supervised) {
  if (supervised !== true || !rescue?.enabled?.() || rescue.paused === true
      || rescue._manualGateStopped || rescue._emergencyGateContext
      || rescue._emergencyHoldActive?.()
      || ['opening', 'closing'].includes(rescue.doorState?.())) return null;
  if (rescue._confirmedStationLockActive?.()) return null;
  // Never schedule an outdoor journey against a fresh native IN_STATION bit.
  const dockAge=Date.now()-Number(d._mowerBinaryDiagAt||0);
  if (dockAge>=0 && dockAge<=15000 && d._mowerBinaryDiag?.dockingState==='IN_STATION'
      && Number(d._mowerBinaryDiag?.undocking||0)===0) return null;
  if (rescue._confirmedMaintenanceTransitActive?.() || rescue._maintenanceJourneyOwnsNavigation?.()
      || rescue._normalMaintenanceDockWatch) return null;
  const api = d._api, did=d.getData?.()?.id;
  if (!did || typeof api?.getMowerPosition !== 'function'
      || typeof rescue._readNativeStationaryPositionForGarage !== 'function') return null;
  const token = rescue._commandToken;
  const first = await api.getMowerPosition(did).catch(() => null);
  if (!Number.isFinite(Number(first?.x)) || !Number.isFinite(Number(first?.y))) return null;
  const anchor = {x:Number(first.x),y:Number(first.y),source:'siid:1:4',ts:Date.now()};
  const verified = await rescue._readNativeStationaryPositionForGarage(token, anchor, 150);
  if (!verified || token!==rescue._commandToken || rescue.paused === true
      || rescue._manualGateStopped || rescue._emergencyGateContext
      || rescue._emergencyHoldActive?.()
      || ['opening', 'closing'].includes(rescue.doorState?.())) return null;
  const outside = await rescue.markers?.rawDangerState?.(verified).catch(() => null);
  if (!outside?.known || outside.inside === true
      || !Number.isFinite(Number(outside.distance)) || !Number.isFinite(Number(outside.radius))
      || Number(outside.distance) <= Number(outside.radius) + 150) return null;
  return verified;
}
// The two quick actions MUST share one safely verified AUTO rearm.
// Existing native return/maintenance owners control motor, gate and close.
async function releaseVerifiedOutdoorRecovery(d,rescue,homey,supervised) {
      if (!rescue?._manualRecoveryActive || supervised !== true
          || rescue._manualRecoveryMowerCommandBusy || rescue._manualRecoveryGateCommandBusy
          || ['returning','maintenance_enroute'].includes(rescue._manualRecoveryPhase)
          || typeof d.getSetting !== 'function' || d.getSetting('garage_mode_enabled') !== true)
        throw new Error(msg(homey,'Guarded return cannot be initiated in this state.',
          'Gesicherte Rückkehr hier nicht möglich. Laufenden Auftrag und Garagenmodus prüfen.'));
      // OUTSIDE must also be fresh native OUT_OF_STATION. A visual click or
      // stale station telemetry must not turn DOCK into a departure command.
      const nativeDock = d._mowerBinaryDiag;
      const nativeAge = Date.now() - Number(d._mowerBinaryDiagAt || 0);
      if (!nativeDock || nativeAge < 0 || nativeAge > 15000
          || nativeDock.dockingState !== 'OUT_OF_STATION' || Number(nativeDock.undocking) !== 0)
        throw new Error(msg(homey,'Fresh native OUT_OF_STATION evidence missing.',
          'Frischer nativer Nachweis Mäher AUSSERHALB DER STATION fehlt.'));
      const hasOutdoorLocation = rescue._manualOperatorPosition === 'outside'
          || rescue._manualMaintenanceReached === true;
      if (!hasOutdoorLocation) throw new Error(msg(homey,
        'First confirm that the mower is safely OUTSIDE or has reached a real waypoint.',
        'Zuerst Mäher sicher DRAUSSEN bestätigen oder echte Wartungspunkt-Ankunft abwarten.'));
      const door = rescue.doorState?.();
      let restored = false;
      if (door === 'closed') {
        if (!rescue._manualRecoveryGateClosedProof?.()) throw new Error(msg(homey,
          'Confirm the CLOSED gate before this journey.','Bitte das GESCHLOSSENE Tor vor der Rückkehr bestätigen.'));
        restored = await rescue.manualRecoveryRestoreNormal(false);
      } else if (door === 'open') {
        if (!rescue._manualRecoveryGateOpenProof?.() || rescue._emergencyGateContext) throw new Error(msg(homey,
          'Confirm the OPEN passage and check the gate motor before returning.',
          'Tor vollständig OFFEN bestätigen und Torstopp prüfen.'));
        // The open-passage statement alone is never native evidence. The
        // existing emergency rearm reads fresh OUT_OF_STATION plus two native
        // positions, verifies stationary lawn-side geometry and persists release.
        const gateStillOpen = () => rescue._manualRecoveryGateOpenProof?.() === true
          && rescue.doorState?.() === 'open'
          && !rescue._emergencyGateContext && !rescue._emergencyTransitionPromise;
        if (!gateStillOpen()) throw new Error(msg(homey,'Open gate not verified.', 'Tor OFFEN nicht sicher bestätigt.'));
        const proof = await rescue._manualRecoveryOutdoorRearmProof?.();
        if (proof === true && gateStillOpen()) restored = await rescue.manualRecoveryRearmAutomation({
          closedPassageCheck: () => gateStillOpen()
            ? {ok:true,evidence:'native_open_plus_operator_open'}
            : {ok:false,reason:'open_gate_changed'},
        });
      } else throw new Error(msg(homey,'Gate state unknown or moving; no movement sent.',
        'Torstellung unklar oder Tor bewegt sich. Kein Fahrbefehl gesendet.'));
      if (!restored) throw new Error(msg(homey,
        'Native outdoor position / passage check failed. No movement dispatched.',
        'Native Positions- oder Durchfahrtprüfung fehlgeschlagen. Keine Fahrt ausgelöst.'));
      return {door};
}
function overview(d) {
  const e = d._garageSafety;
  const garageEnabled = typeof d.getSetting === 'function' ? d.getSetting('garage_mode_enabled') === true : !!e?.enabled?.();
  const storedStatus = d.getCapabilityValue('mower_status');
  const nativeStatus = d._nativeMowerStatus || storedStatus || 'idle';
  const displayStatus = e?.getTileStatus?.(nativeStatus);
  const validStatuses = new Set([
    'idle', 'mowing', 'standby', 'paused', 'error', 'returning', 'charging', 'mapping',
    'docked', 'updating', 'remote_control', 'garage_home', 'garage_start_pending',
    'garage_exiting', 'garage_adjusting', 'garage_opening', 'garage_closing',
    'garage_maintenance_transit', 'garage_maintenance_reached', 'garage_free_drive',
    'garage_positioning', 'garage_app_control',
  ]);
  const status = validStatuses.has(displayStatus) ? displayStatus
    : (validStatuses.has(storedStatus) ? storedStatus
      : (validStatuses.has(nativeStatus) ? nativeStatus : 'idle'));
  const verifiedMaintenancePoints = availableGarageMaintenancePointIndexes(d);
  const configuredMaintenancePoints = [1,2,3,4,5].filter(index => index === 1
    || String(d._getGarageManagedSetting?.(`maintenance_point_${index}_name`) || '').trim());
  const learning = d._pendingExternalMaintenancePointAssociation;
  const externalMaintenanceLearningIndex = learning
    && Date.now() - Number(learning.at || 0) < 180000
    && Number(learning.map) === Number(d._activeMapIndex ?? 0)
    && e?._externalStartRecoveryPhase === 'AWAIT_NATIVE_MAINTENANCE_REISSUE'
    ? Number(learning.index) : 0;
  return { name: d.getName(), status, nativeMowerStatus: nativeStatus, battery: d.getCapabilityValue('measure_battery'),
    garageEnabled, garagePaused: !!e?.paused, availableMaintenancePoints: verifiedMaintenancePoints, configuredMaintenancePoints, externalMaintenanceLearningIndex, door: e?.doorState?.() || 'unknown', doorStopped: !!e?._manualGateStopped, doorEstimated: !!e?._doorStateDerived,
    availableMaintenancePointNames: Object.fromEntries(configuredMaintenancePoints
      .map(index => [index, String(d._maintenancePointName?.(index) || `P${index}`)])),
    externalMaintenanceSelectionPending: Number(e?._externalMaintenanceSelectionRequiredAt||0)>0
      && Date.now()-Number(e._externalMaintenanceSelectionRequiredAt)<15*60*1000
      && e?._externalStartRecoveryPhase === 'MANUAL_REISSUE_REQUIRED'
      || externalMaintenanceLearningIndex > 0,
    // Display-only moving-state hint. Not a clearance or stop proof.
    recoveryStationaryObserved: !!e?._manualRecoveryStationary?.(),
    recoveryObservedMoving: ['mowing','returning','mapping','leaving','remote_control'].includes(
      String(d._observedMowerStatus||'').toLowerCase())
      && Date.now()-Number(d._observedMowerStatusAt||0)>=0
      && Date.now()-Number(d._observedMowerStatusAt||0)<=15000,
    manualOperatorPosition: e?._manualOperatorPosition || 'unknown',
    manualRecovery: !!e?._manualRecoveryActive, manualOperatorFree: !!e?._manualRecoveryOperatorFree, recoveryPhase: e?._manualRecoveryPhase || null, recoveryReturnFailure: e?._manualReturnFailureReason || '', recoveryReturnAttempts: Number(e?._manualReturnAttempt || 0), recoveryReturnRetryAt: Number(e?._manualReturnDispatchUncertainUntil || 0), recoveryCanRevalidate: !!(e?._manualRecoveryStoredArrival && e?._validManualArrivalRecord?.(e._manualRecoveryStoredArrival) && Number(e._manualReturnAttempt || 0) < 2), recoveryGateConfirmed: !!e?._manualRecoveryGateOpenProof?.(),
    recoveryDockConfirmed: !!(e?._freshStationHoldProof?.(15000)),
    recoveryOperatorDockAt: Number(e?._manualDockOperatorAt || 0),
    recoveryOperatorGateClosedAt: e?._manualRecoveryGateClosedProof?.() ? Number(e._manualRecoveryGateClosedAt || 0) : 0,
    recoveryNativeDock: e?.device?._mowerBinaryDiag?.dockingState || 'unknown',
    recoveryNativeUndock: Number.isFinite(Number(e?.device?._mowerBinaryDiag?.undocking)) && e?.device?._mowerBinaryDiag ? Number(e.device._mowerBinaryDiag.undocking) : null,
    recoveryNativeCharging: e?.device?._mowerBinaryDiag?.chargingLive === true,
    recoveryNativeAgeMs: Number(e?.device?._mowerBinaryDiagAt || 0) > 0 ? Math.max(0, Date.now()-Number(e.device._mowerBinaryDiagAt)) : null,
    recoveryDockReadback: e?._manualRecoveryDockRearmLast || null,
    recoveryOutsideReadback: e?._manualRecoveryOutsideRearmLast || null,
    recoveryWaypointSeen: !!(e?._manualMaintenanceReached && e?._manualMaintenancePhase === 'reached' &&
      Date.now() - Number(Math.max(e?._lastMaintenanceReachedAt||0, e?._lastAdditionalMaintenanceReached?.at||0)) < 10*60*1000),
    recoveryNormalRestoreLast: e?._manualRecoveryNormalRestoreLast || null,
    returnHoldActive: !!e?._returnRecoveryHold,
    returnHoldTerminal: !!e?._returnRecoveryHold?.terminal,
    returnHoldStopped: !!e?._returnRecoveryHold?.stopped,
    returnHoldReason: String(e?._returnRecoveryHold?.reason || ''),
    recoveryGateLastRealContact: e?._lastSensorContactState || 'unknown',
    recoveryGateLastRealContactAt: Number(e?._lastSensorContactAt || 0),
    sensorContactAgeMs: Number(e?._lastSensorContactAt || 0)>0 ? Math.max(0,Date.now()-Number(e._lastSensorContactAt)) : null,
    visualGate: e?.manualGateVisualObservation?.() || null,
    visualDock: e?.manualDockVisualObservation?.() || null,
    sensor: d.getCapabilityValue('garage_sensor_available_status') || 'unknown',
    sensorContact: d.getCapabilityValue('garage_sensor_contact_status') || 'unknown',
    safety: d.getCapabilityValue('garage_safety_status') || 'unknown',
    spotSelected: !!d.getCapabilityValue('mow_spot'),
    mission: e?._manualMaintenanceTransit ? 'maintenance' : e?.isReturnCycleActive?.() ? 'return' : e?._outbound?.requiresMowingStable ? 'mowing' : d._nativeMowerStatus,
  };
}
module.exports = {
  find, overview,
  async getOverview({ homey, query }) { return overview(find(homey, query.deviceId)); },
  async command({ homey, query, body }) {
    const d = find(homey, query.deviceId), action = body?.action;
    if (['gate_open','gate_close','gate_stop'].includes(action)) {
      const accepted = await d._garageSafety.manualGateRequest(action.slice(5), { supervised: body?.supervised === true });
      if (accepted === false) throw new Error(msg(homey, 'Gate action blocked by safety checks', 'Toraktion durch Sicherheitsprüfung gesperrt'));
      return { accepted: true };
    }
    const rescue = d._garageSafety;
    if (action === 'gate_visual_open' || action === 'gate_visual_closed' || action === 'gate_visual_revoke') {
      if (!rescue) throw new Error(msg(homey,'Garage state unavailable.','Garagenstatus nicht erreichbar.'));
      // Display-only observations are permitted for missing/inconsistent status
      // even when automation is active; none of these commands moves hardware.
      // Automatic motion always uses native and physical interlocks instead.
      const old=rescue.manualGateVisualObservation?.();
      const state=action === 'gate_visual_open' ? 'open' : 'closed';
      const revoke=action === 'gate_visual_revoke' || body?.revoke === true || old?.state === state;
      const ok=revoke ? rescue.manualGateRevokeVisual?.()
        : rescue.manualGateReportVisual?.(state,body?.supervised === true);
      if (!ok) throw new Error(msg(homey,'Visual gate statement conflicts with current sensor or gate movement. No status altered.',
        'Sichtprüfung nicht übernommen: aktueller Torsensor oder Torbewegung widerspricht. Kein Status verändert.'));
      return {accepted:true,visualGate:rescue.manualGateVisualObservation?.()||null,sensorUnchanged:true};
    }
    if (action === 'dock_visual_docked' || action === 'dock_visual_revoke') {
      if (!rescue) throw new Error(msg(homey,'Garage state unavailable.','Garagenstatus nicht erreichbar.'));
      const accepted = action === 'dock_visual_revoke' || body?.revoke === true
        ? rescue.manualDockRevokeVisual?.()
        : rescue.manualDockReportVisual?.(body?.supervised === true);
      if (!accepted) throw new Error(msg(homey,'Visual station report was not accepted.','Sichtprüfung der Station nicht übernommen.'));
      return {accepted:true,visualDock:rescue.manualDockVisualObservation?.()||null,nativeVerified:false};
    }
    if (action === 'recovery_operator_dock') {
      const accepted = body?.revoke === true
        ? rescue?.manualRecoveryRevokeDocked?.()
        : rescue?.manualRecoveryDeclareDocked?.(body?.supervised === true);
      if (!accepted) throw new Error(msg(homey,'Visual dock statement not accepted.','Sichtprüfung Andocken nicht übernommen.'));
      return {accepted:true,operatorDockAt:Number(rescue._manualDockOperatorAt||0),nativeVerified:false};
    }
    if (action === 'recovery_confirm_closed') {
      const accepted = body?.revoke === true
        ? rescue?.manualRecoveryRevokeGateClosed?.()
        : rescue?.manualRecoveryDeclareGateClosed?.(body?.supervised === true);
      if (!accepted) {
        const reason = rescue?._manualRecoveryNormalRestoreLast?.result;
        const problems = {
          gate_open_contact_conflict:'Torsensor meldet OFFEN. Bitte Kontakt und tatsächliche Torstellung prüfen.',
          sensor_offline:'Torsensor offline. Automatische Freigabe nicht möglich; manuelle Übernahme bleibt verfügbar.',
          gate_moving:'Tor bewegt sich noch. Bitte warten.',
          emergency_gate_active:'Notfall-Torbewegung noch aktiv. Zuerst Motor sicher stoppen.',
          recent_gate_pulse:'Letzter Torimpuls noch zu frisch. Bitte warten.',
        };
        throw new Error(msg(homey,'Cannot confirm physically CLOSED gate.',problems[reason] || 'Tor sicher geschlossen konnte nicht bestätigt werden.'));
      }
      return {accepted:true,operatorGateClosedAt:Number(rescue._manualRecoveryGateClosedAt||0),sensorUnchanged:true};
    }
    if (action === 'recovery_pause_safely') {
      // A pure PAUSE command (never a PAUSE/RESUME toggle). The sticky
      // emergency interlock remains active until a separate native release.
      if (body?.supervised !== true || !rescue?._manualRecoveryActive)
        throw new Error(msg(homey,'Emergency PAUSE unavailable.','PAUSE nur bei aktiver Notfallsperre verfügbar.'));
      const native=String(d._observedMowerStatus||'').toLowerCase();
      const age=Date.now()-Number(d._observedMowerStatusAt||0);
      if (age<0 || age>15000)throw new Error(msg(homey,
        'Native mower status too old to send PAUSE safely.',
        'Nativer Mäherstatus für PAUSE zu alt. Bitte vor Ort prüfen.'));
      if(['paused','idle','standby'].includes(native))
        return {accepted:true,alreadyStationary:true,requested:false};
      // Native 1:1 locked station + fresh reading is already at rest. Do not
      // send a PAUSE that could be interpreted as a toggle or a START.
      const dockAge=Date.now()-Number(d._mowerBinaryDiagAt||0);
      if (['docked','charging','garage_home'].includes(native)
          && dockAge>=0 && dockAge<=15000
          && d._mowerBinaryDiag?.dockingState==='IN_STATION'
          && Number(d._mowerBinaryDiag?.undocking)===0)
        return {accepted:true,alreadyStationary:true,requested:false};
      if(!['mowing','returning','mapping','leaving','remote_control'].includes(native)
          || rescue._manualRecoveryMowerCommandBusy || rescue._emergencyTransitionPromise)
        throw new Error(msg(homey, 'Conflicting motion or emergency transition; PAUSE not sent.',
          'Unklare Bewegung oder laufender Notfall; PAUSE nicht gesendet.'));
      const did=d.getData?.()?.id;
      if(!did||typeof d._api?.pause!=='function')throw new Error(msg(homey,
        'Native PAUSE unavailable.', 'Nativer PAUSE-Befehl nicht verfügbar.'));
      const sent=typeof d._safeWrite==='function'
        ?await d._safeWrite('recovery_operator_pause_only',()=>d._api.pause(did))
        :await d._api.pause(did);
      if(sent===false)throw new Error(msg(homey,'Mower did not accept PAUSE.','PAUSE wurde nicht angenommen.'));
      rescue.log?.('MANUAL RECOVERY operator PAUSE requested (native standstill not yet confirmed)');
      return {accepted:true,requested:true,nativeStationaryVerified:false};
    }
    if (action === 'recovery_restore_normal') {
      const checkedClosed = rescue?._manualRecoveryGateClosedProof?.() === true;
      const checkedOpen = rescue?._manualRecoveryGateOpenProof?.() === true;
      const checkedDock = Number(rescue?._manualDockOperatorAt || 0) > 0
        || (['confirmed', 'confirmed_not_charging'].includes(String(rescue?._manualRecoveryDockRearmLast?.result || ''))
          && Number(rescue?._manualRecoveryDockRearmLast?.reads || 0) === 2
          && Date.now() - Number(rescue?._manualRecoveryDockRearmLast?.at || 0) >= 0
          && Date.now() - Number(rescue?._manualRecoveryDockRearmLast?.at || 0) < 10 * 60 * 1000
          && rescue?.device?._mowerBinaryDiag?.dockingState === 'IN_STATION'
          && Number(rescue?.device?._mowerBinaryDiag?.undocking) === 0); // explicit rearm ALWAYS rereads 2 fresh frames
      const outdoorCandidate = rescue?._manualOperatorPosition === 'outside'
        || rescue?._manualMaintenanceReached === true;
      // The restore button is NOT a substitute for the two individual visual
      // confirmations. They must be independently accepted and represented in
      // the overview; the native position/contact proofs follow separately.
      if (!(checkedClosed || checkedOpen)) throw new Error(msg(homey,
          'Confirm that gate is physically OPEN or CLOSED first.',
          'Bitte zuerst Tor physisch OFFEN oder GESCHLOSSEN bestätigen.'));
      if (!(checkedDock || outdoorCandidate)) throw new Error(msg(homey,
          'Confirm mower OUTSIDE, docked, or a fresh native waypoint arrival first.',
          'Bitte Mäher sicher DRAUSSEN oder angedockt bestätigen (alternativ frische Wartungspunkt-Ankunft).'));
      if (!rescue) throw new Error(msg(homey, 'Garage controller unavailable.', 'Garagensteuerung nicht erreichbar.'));
      if (typeof d.getSetting === 'function' && d.getSetting('garage_mode_enabled') !== true)
        throw new Error(msg(homey, 'Garage Mode is disabled in device settings.', 'Garagenmodus ist in den Geräteeinstellungen ausgeschaltet.'));
      if (!rescue._manualRecoveryActive && rescue._manualGateStopped)
        throw new Error(msg(homey, 'A gate motor stop is still active; verify gate and manually clear it first.', 'Torstoppsperre ist noch aktiv. Tor prüfen und den Stoppzustand zuerst manuell klären.'));
      if (rescue._manualRecoveryActive) {
        const restored = await rescue.manualRecoveryRestoreNormal(false);
        if (!restored) {
          const reason = rescue._manualRecoveryNormalRestoreLast?.result || rescue._manualRecoveryDockRearmLast?.result || 'unknown';
          const errors = {
            visual_closed_required: 'Tor vollständig geschlossen bestätigen.',
            visual_open_required: 'Tor vollständig geöffnet bestätigen.',
            gate_closed_contact_conflict: 'Torsensor meldet GESCHLOSSEN. OFFEN-Sichtprüfung widerspricht dem Sensor.',
            gate_moving: 'Tor bewegt sich noch. Bitte Endlage abwarten.',
            emergency_gate_active: 'Aktive Tor-Notfallbewegung. Bitte Tor und Motor erst sicher stoppen.',
            recent_gate_pulse: 'Torbewegung noch nicht abgeschlossen. Bitte kurz warten.',
            gate_open_contact_conflict: 'Torsensor meldet aktuell OFFEN. Sichtprüfung widerspricht dem Sensor.',
            sensor_offline: 'Torsensor nicht betriebsbereit. Automatik bleibt gesperrt; manuelle Übernahme möglich.',
            dock_not_locked: 'Andockkontakt fehlt: Mäher steht möglicherweise minimal außerhalb der Station.',
            outdoor_stationary_or_api_missing: 'Frischer Stillstand oder native Positionsabfrage fehlt.',
            outdoor_native_dock_not_verified: 'Mäher außerhalb der Station nicht frisch bestätigt.',
            outside_observation_or_waypoint_required: 'Standort DRAUSSEN bestätigen oder frischen Wartungspunkt nachweisen.',
            outdoor_native_position_pair_missing_or_moving: 'Zwei stabile native Positionsmessungen fehlen.',
            outdoor_danger_area_not_clear: 'Gefahrenbereich nicht eindeutig frei.',
            outdoor_safety_line_not_clear: 'Linienabstand oder Rasenseite nicht bestätigt.',
            read_unavailable: 'Mäher antwortet nicht auf die native Stationsabfrage.',
            no_native_frame: 'Keine frischen nativen Stationsdaten.',
            dock_changed_during_check: 'Andockstatus hat sich während der Prüfung geändert.',
            persist_failed: 'Freigabe konnte nicht dauerhaft gespeichert werden.',
          };
          throw new Error(msg(homey, `Restore not confirmed (${reason}). Automatic movement remains locked.`,
            (errors[reason] || `Freigabe nicht bestätigt (${reason}).`) + ' Keine automatische Bewegung freigegeben.'));
        }
        return {accepted:true, restored:true,gateEvidence:rescue._manualRecoveryNormalRestoreLast?.gateEvidence||'supervised_visual_gate'};
      }
      if (rescue.paused) {
        const switched = await rescue.setOperatorGaragePause(false, 'overview_quick_normal_restore');
        if (!switched) throw new Error(msg(homey, 'Could not enable garage automation.', 'Garagenautomatik konnte nicht aktiviert werden.'));
      }
      return {accepted:true,restored:true};
    }
    if (action === 'recovery_quick_return') {
      const {door}=await releaseVerifiedOutdoorRecovery(d,rescue,homey,body?.supervised===true);
      // Existing return planner handles P1/P2, ETA, STOP and verified dock close.
      await d.triggerCapabilityListener('cmd_dock', true, {});
      return {accepted:true,requested:true,mode:'normal_guarded_return',gateWasOpen:door==='open',
        dockArrivalVerified:false};
    }
    if (action === 'recovery_quick_waypoint') {
      const index=Number(body?.pointIndex);
      if (!Number.isInteger(index) || index<1 || index>5
          || !availableGarageMaintenancePointIndexes(d).includes(index)
          || typeof d.cmdGoToConfiguredMaintenancePoint !== 'function')
        throw new Error(msg(homey,'Select an available native waypoint P1–P5.',
          'Bitte einen verfügbaren nativen Wartungspunkt P1–P5 auswählen.'));
      const {door}=await releaseVerifiedOutdoorRecovery(d,rescue,homey,body?.supervised===true);
      // Indexed native command owns opcode 109 + arrival proof and normal
      // guarded gate-close after arrival; no substitute mowing command.
      await d.cmdGoToConfiguredMaintenancePoint(index);
      return {accepted:true,requested:true,pointIndex:index,mode:'normal_guarded_waypoint',
        gateWasOpen:door==='open',nativeArrivalVerified:false};
    }
    if (action === 'external_maintenance_cancel') {
      const cancelled = rescue?.cancelUnknownExternalMaintenanceSelection?.('operator_cancel_widget');
      if (!cancelled) throw new Error(msg(homey,'No pending original-app waypoint selection.', 'Keine offene Original-App-Wartungspunktauswahl.'));
      return {accepted:true,cancelled:true,motorCommandSent:false};
    }
    if (/^external_maintenance_point_[1-5]$/.test(String(action))) {
      if (body?.supervised!==true) throw new Error(msg(homey,'Explicit operator confirmation required.','Zielpunkt persönlich bestätigen.'));
      const selected=Number(String(action).slice(-1));
      if (!availableGarageMaintenancePointIndexes(d).includes(selected))
        throw new Error(msg(homey,`Waypoint P${selected} is not configured.`,
          `Wartungspunkt P${selected} ist nicht eingerichtet.`));
      d.log?.('[overview] original-app waypoint button', `P${selected}`, 'supervised=true');
      const accepted=await rescue?.resumeUnknownExternalMaintenance(selected,true);
      if (!accepted) {
        const reason=String(rescue?._externalMaintenanceSelectionLastFailure||'unknown');
        throw new Error(msg(homey,`Vendor waypoint P${selected} not released: ${reason}`,
          `Wartungspunkt P${selected} nicht freigegeben: ${reason}`));
      }
      return {accepted:true,requested:true,nativeArrivalVerified:false};
    }
    if (/^recovery_position_(inside|outside|unknown)$/.test(String(action))) {
      const selected=String(action).replace('recovery_position_','');
      const location=body?.revoke===true ? 'unknown' : selected;
      if (!rescue?.manualRecoveryDeclarePosition(location,body?.supervised===true))
        throw new Error(msg(homey,'Manual location statement unavailable.','Manuelle Standortangabe nicht übernommen. Notfallsperre/Status prüfen.'));
      return {accepted:true,operatorLocation:location,nativePositionUnchanged:true};
    }
    if (action === 'recovery_begin_manual') {
      if (body?.supervised !== true || !rescue) throw new Error(msg(homey,
        'Explicit supervised manual takeover is required.',
        'Beaufsichtigte manuelle Übernahme ausdrücklich bestätigen.'));
      // A mode switch NEVER dispatches a mower or gate motor command. It may
      // enter MANUAL from normal operation or recover a previously aborted
      // emergency even without a working gate contact.
      if (!(await rescue.beginOperatorManualControl(true))) throw new Error(msg(homey,
        'Manual takeover unavailable.', 'Manuelle Übernahme nicht verfügbar.'));
      return {accepted:true,manualRecovery:true,manualOperatorFree:true};
    }
    if (action === 'recovery_direct_dock' || /^recovery_direct_point_[1-5]$/.test(String(action))) {
      if (body?.supervised !== true) throw new Error(msg(homey,
        'Explicit on-site supervision required.', 'Ausdrückliche Aufsicht vor Ort erforderlich.'));
      const accepted = action === 'recovery_direct_dock'
        ? await rescue?.manualRecoveryDirectDock(true)
        : await rescue?.manualRecoveryDirectMaintenance(Number(action.slice(-1)), true);
      if (accepted !== true) throw new Error(msg(homey,
        'Manual request withheld: confirm OPEN passage, select manual takeover and check active movements.',
        'Manueller Befehl nicht freigegeben: Tor OFFEN bestätigen, manuelle Übernahme wählen und laufende Bewegungen prüfen.'));
      return {accepted:true,requested:true,nativeArrivalVerified:false};
    }
    if (action === 'recovery_dock_check') {
      if (!rescue || typeof rescue._manualRecoveryFreshDockRearmProof !== 'function')
        throw new Error(msg(homey,'Station diagnostic unavailable.','Stationsdiagnose nicht verfügbar.'));
      const verified = await rescue._manualRecoveryFreshDockRearmProof();
      return {
        accepted: true,
        verified,
        result: rescue._manualRecoveryDockRearmLast?.result || 'unknown',
        reads: rescue._manualRecoveryDockRearmLast?.reads || 0,
        at: rescue._manualRecoveryDockRearmLast?.at || 0,
      };
    }
    if (action === 'recovery_sensor_check') {
      const snapshot=overview(d);
      return {accepted:true,status:snapshot.sensor,contact:snapshot.sensorContact,ageMs:snapshot.sensorContactAgeMs};
    }
    if (action === 'recovery_gate_revoke') {
      if (!rescue) throw new Error(msg(homey,'Garage controller unavailable.','Garagensteuerung nicht erreichbar.'));
      rescue._manualRecoveryOpenConfirmedAt=0;
      rescue.log?.('MANUAL RECOVERY operator revoked visual gate OPEN declaration');
      return {accepted:true};
    }
    if (action === 'context_return_checked' || action === 'context_maintenance_checked') {
      if (!rescue) throw new Error(msg(homey,'Garage controller unavailable.','Garagensteuerung nicht erreichbar.'));
      if (body?.supervised !== true) throw new Error(msg(homey,
        'Check the mower position and the route on site before confirming.',
        'Bitte Mäherposition und Fahrweg vor Ort prüfen und bestätigen.'));
      // Emergency uses the established separate rescue state machine, with
      // gate-open proof and stationary checks. Never allow a normal action to
      // bypass a sticky emergency latch.
      if (rescue._manualRecoveryActive) {
        const accepted = action === 'context_return_checked'
          ? await rescue.manualRecoveryReturnToDock()
          : await rescue.manualRecoveryToMaintenance();
        if (accepted !== true) throw new Error(msg(homey,
          'Recovery held: verify the open gate, stationary mower and waypoint first.',
          'Bergung gesperrt: zuerst offenes Tor, Mäherstillstand und Wartungspunkt prüfen.'));
        return {accepted:true,requested:true,mode:'supervised_emergency',positionVerified:true};
      }
      // Outside emergency, only an actually held/uncertain return or an
      // explicitly paused mower may be consciously re-requested. We do NOT
      // turn a running, healthy mission into a competing command.
      const status=String(rescue.status?.() || '').toLowerCase();
      const hold=rescue._returnRecoveryHold;
      const attention=!!(hold?.terminal || hold?.stopped)
        || (['paused','idle','standby'].includes(status)
          && (rescue.isMissionOutside?.() || rescue.isReturnCycleActive?.()));
      if (!attention) throw new Error(msg(homey,
        'No stationary return problem to recover; ordinary mower controls remain available.',
        'Keine angehaltene Rückkehr erkennbar. Die normalen Mäherbefehle bleiben verfügbar.'));
      // Terminal hold with no acknowledged PAUSE and a still-'mowing' raw
      // status is not a stationary proof. A verified physical waypoint may
      // also qualify, but only through the engine's geometry check.
      const nativeStill=['idle','standby','paused'].includes(status);
      const stopped=hold?.stopped===true || nativeStill;
      const verifiedWaypoint=!stopped && rescue._manualMaintenanceReached===true
        && await rescue._verifiedMaintenanceReturnClearance?.().catch(()=>false)===true;
      if (!stopped && !verifiedWaypoint) throw new Error(msg(homey,
        'Mower standstill not confirmed; inspect and pause safely before retrying.',
        'Mäherstillstand nicht bestätigt. Vor erneuter Anforderung prüfen und sicher anhalten.'));
      const verified=await checkSupervisedPosition(d,rescue,body.supervised);
      if (!verified) throw new Error(msg(homey,
        'Position check failed: require two matching native reads, safe clearance and active garage automation. No movement sent.',
        'Positionsprüfung fehlgeschlagen: zwei übereinstimmende native Messungen, sichere Durchfahrt und aktive Garagenautomatik erforderlich. Kein Fahrbefehl gesendet.'));
      // The existing capability listener owns beginUserCommand, action tokens,
      // duplicate suppression, return route selection and motor/gate safety.
      await d.triggerCapabilityListener(action==='context_return_checked'?'cmd_dock':'cmd_maintenance_point', true, {});
      return {accepted:true,requested:true,mode:'guarded_capability',positionVerified:true,
        checkAt:Date.now()};
    }
    if (action === 'garage_pause') {
      if (!rescue) throw new Error(msg(homey, 'Garage controller unavailable', 'Garagensteuerung nicht erreichbar'));
      // The ON/OFF preference always works, even in emergency. Re-enabling the
      // preference cannot itself bypass the independent sticky motion latch.
      const pauseRequested = !rescue.paused;
      const success = await rescue.setOperatorGaragePause(pauseRequested, 'overview_widget');
      if (!success) throw new Error(msg(homey, 'Garage automation switch failed',
        'Garagenautomatik konnte nicht umgeschaltet werden.'));
      return {accepted:true,garagePaused:!!rescue.paused,
        emergencyMotionLocked:!!rescue._manualRecoveryActive};
    }
    if (['recovery_confirm_open','recovery_maintenance','recovery_return','recovery_rearm','recovery_rearm_quick','recovery_takeover'].includes(action)) {
      const accepted = await runRecoveryAction(rescue, action, body?.supervised === true);
      if (accepted !== true) {
        if (action === 'recovery_confirm_open') {
          const age = Date.now() - Number(rescue?._lastSensorContactAt || 0);
          const contradictory = rescue?._lastSensorContactState === 'closed' && rescue?._lastSensorContactAt
            && age >= 0 && age <= 12000;
          throw new Error(contradictory
            ? msg(homey, 'A fresh CLOSED sensor contact contradicts the manual OPEN statement. Check sensor and passage first.', 'Der Torsensor hat erst kürzlich GESCHLOSSEN gemeldet. Bitte Sensor und Durchfahrt prüfen.')
            : msg(homey, 'Gate opening confirmation not accepted: wait for any current movement to finish, then check and confirm OPEN again.', 'Torbestätigung noch nicht möglich: aktuelle Torbewegung abwarten, Durchfahrt prüfen und OFFEN erneut bestätigen.'));
        }
        if (action === 'recovery_takeover') throw new Error(msg(homey,
          'Confirm the fully open physical gate passage first. A current contradictory CLOSED contact cannot be ignored.',
          'Zuerst vollständig offene Durchfahrt bestätigen. Ein aktueller widersprechender GESCHLOSSEN-Kontakt muss vorher geklärt werden.'));
        if (action === 'recovery_rearm' || action === 'recovery_rearm_quick') {
          const result = rescue?._manualRecoveryNormalRestoreLast?.result
            || rescue?._manualRecoveryDockRearmLast?.result || 'unknown';
          const details = {
            visual_closed_required: ['Confirm the gate is physically CLOSED before restarting automation.', 'Bitte das vollständig GESCHLOSSENE Tor vor Ort bestätigen, bevor die Automatik wieder eingeschaltet wird.'],
            gate_open_contact_conflict: ['The real door contact reports OPEN. Do not restore automation before resolving this conflict.', 'Der echte Torkontakt meldet OFFEN. Vor Wiederfreigabe den Widerspruch prüfen.'],
            sensor_offline: ['Door sensor offline. Manual control remains available; automatic movement locked.', 'Torsensor offline. Manuelle Steuerung bleibt möglich, automatische Bewegung bleibt gesperrt.'],
            recent_gate_pulse: ['Wait for the recent gate movement to finish and reconfirm CLOSED.', 'Die letzte Torbewegung erst abschließen lassen und GESCHLOSSEN erneut bestätigen.'],
            emergency_gate_active: ['Gate emergency movement is still active; return to normal is unavailable.', 'Eine Tor-Notfallbewegung läuft noch; Wiederfreigabe nicht möglich.'],
            read_unavailable: ['Native station read could not be completed. Check mower connection and retry.', 'Direkte native Stationsabfrage nicht möglich. Verbindung zum Mäher prüfen und erneut versuchen.'],
            native_api_unavailable: ['Native station read is unavailable in this session.', 'Native Stationsabfrage in dieser Sitzung nicht verfügbar.'],
            no_native_frame: ['No fresh native station frame received.', 'Keine frische native Stationsmeldung empfangen.'],
            dock_not_locked: ['Native docking contacts not confirmed (IN_STATION/u0 missing).', 'Native Andockkontakte nicht bestätigt (IN_STATION/u0 fehlt).'],
            charging_missing: ['Native docking status must be verified.', 'Nativer Andockstatus muss bestätigt werden.'],
            dock_changed_during_check: ['Dock/charging contact changed during the two-read check. No release.', 'Andock- oder Ladekontakt hat sich während der Doppelprüfung geändert. Keine Freigabe.'],
            persist_failed: ['The emergency release could not be saved. Emergency remains latched.', 'Die Freigabe konnte nicht dauerhaft gespeichert werden. Notfallsperre bleibt aktiv.'],
            gate_moving: ['Gate is moving; rearm must wait for a stable end position.', 'Tor bewegt sich; Freigabe erst bei stabiler Endlage.'],
            active_navigation: ['A mower navigation/return command is still active.', 'Ein Mäher-/Rückkehrbefehl ist noch aktiv.'],
            unknown: ['Native IN_STATION/u0/charging readback not confirmed.', 'Nativer IN_STATION/u0/Lade-Nachweis nicht bestätigt.'],
          }[result] || ['Native docking verification failed.', 'Native Andockprüfung fehlgeschlagen.'];
          throw new Error(msg(homey, details[0], details[1]) + ' ' + msg(homey,
            'Emergency stays latched. The device tile saying Docked is not a native contact proof.',
            'Notfallsperre bleibt aktiv. Die Kachelanzeige „Angedockt“ ist kein nativer Kontaktnachweis.'));
        }
        throw new Error(msg(homey,
          'Manual recovery withheld: physical gate/waypoint/dock proof is missing.',
          'Manuelle Bergung gesperrt: Tor-, Wartungspunkt- oder Dock-Nachweis fehlt.'));
      }
      return {accepted: true};
    }
    const capability = capabilities[action];
    if (!capability) throw new Error(msg(homey, 'Invalid mower command', 'Ungültiger Mäherbefehl'));
    if (rescue?._manualRecoveryActive) {
      // Show ordinary mower buttons throughout recovery, but enforce the
      // existing recovery policy. Never dispatch PAUSE/RESUME as a toggle.
      if (action === 'pause') return module.exports.command({homey,query,body:{action:'recovery_pause_safely',supervised:true}});
      if (action === 'return') return module.exports.command({homey,query,body:{action:'recovery_quick_return',supervised:body?.supervised===true}});
      if (action !== 'stop') throw new Error(msg(homey,
        'Emergency is active: confirm the safe location, then restore automation or select a guarded waypoint. No motor command sent.',
        'Notfallsperre aktiv: Standort bestätigen, Automatik freigeben oder einen gesicherten Wartungspunkt wählen. Kein Fahrbefehl gesendet.'));
    }
    // Use precisely the existing capability listeners, including momentary
    // command locks, beginUserCommand and all GarageSafetyEngine guards.
    await d.triggerCapabilityListener(capability, true, {});
    return { requested: true }; // request accepted, not a fabricated hardware ack
  },
};

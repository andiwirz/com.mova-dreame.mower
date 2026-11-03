/* Pure presenter for native dock evidence; no hardware or Homey side effects. */
(function (global) {
  'use strict';

  const verified = new Set(['confirmed', 'confirmed_not_charging']);
  const messages = {
    read_unavailable: ['No response to the direct station query. Check mower connection.', 'Keine Antwort auf die direkte Stationsabfrage. Mäherverbindung prüfen.'],
    native_api_unavailable: ['Direct station query is not available.', 'Direkte Stationsabfrage ist nicht verfügbar.'],
    no_native_frame: ['Station telemetry is missing or outdated.', 'Stationsdaten fehlen oder sind veraltet.'],
    dock_not_locked: ['Native dock contact is not engaged. Mower may be slightly out of the station.', 'Nativer Andockkontakt nicht eingerastet. Mäher steht möglicherweise wenige Millimeter außerhalb.'],
    dock_changed_during_check: ['Dock contact changed between checks. No release.', 'Andockkontakt hat sich während der Prüfung geändert. Keine Freigabe.'],
    gate_moving: ['Gate moving; wait for a stable end position.', 'Tor bewegt sich. Stabile Endlage abwarten.'],
    active_navigation: ['Mower is still navigating. No release.', 'Mäher führt noch eine Fahrt aus. Keine Freigabe.'],
    persist_failed: ['Emergency release could not be saved.', 'Notfallfreigabe konnte nicht gespeichert werden.'],
    check_in_progress: ['Station check already running.', 'Stationsprüfung läuft bereits.'],
  };

  function describe(snapshot, translate) {
    const s = snapshot || {};
    const read = s.recoveryDockReadback || {};
    const now = Date.now();
    const age = now - Number(read.at || 0);
    const currentAge = s.recoveryNativeAgeMs == null ? NaN : Number(s.recoveryNativeAgeMs);
    const state = String(s.recoveryNativeDock || 'unknown');
    const physicalDocked = state === 'IN_STATION' && s.recoveryNativeUndock === 0;
    const physicalOutside = (state === 'OUT_OF_STATION' || s.recoveryNativeUndock === 1)
      && Number.isFinite(currentAge) && currentAge >= 0 && currentAge <= 10000;
    const current = physicalDocked && Number.isFinite(currentAge) && currentAge >= 0 && currentAge <= 10000;
    const result = String(read.result || '');
    const priorPositive = verified.has(result) && Number(read.reads) === 2 && Number(read.at) > 0;
    // A successful diagnostic is a historical fact; it is NOT automatically a
    // fresh permission to move. Never erase that fact merely because the native
    // idle stream is sparse. A newer physical OUT/undock always wins.
    const recent = priorPositive && age >= 0 && age <= 60000;
    const valid = recent && current;
    const charging = s.recoveryNativeCharging === true;
    const batteryFull = Number(s.battery) >= 99;
    const translation = pair => translate(pair[0], pair[1]);
    let text, detail = '', uiState = 'idle';
    if (physicalOutside) {
      text=translation(['Mower outside docking contacts','Mäher nicht im Andockkontakt']);
      detail=translation(messages.dock_not_locked);
      uiState='failed';
    } else if (valid) {
      text=translation(['Docking confirmed (2/2)','Angedockt bestätigt (2/2)']);
      uiState='confirmed';
    } else if (priorPositive && physicalDocked) {
      text=translation(['Last docking check: 2/2 confirmed','Letzte Andockprüfung: 2/2 bestätigt']);
      detail=translation(['Last check is not a fresh movement authorization; recheck before releasing automation.',
        'Letzte Prüfung ist keine frische Fahrfreigabe; vor Automatikfreigabe neu prüfen.']);
    } else if (current) {
      text=translation(['Dock detected · check to confirm','Station erkannt · zur Bestätigung prüfen']);
      if (result && !verified.has(result)) detail=translation([
        'Current native station contact detected; last diagnostic was not successful. Recheck if needed.',
        'Aktueller Stationskontakt erkannt; letzte Diagnose war nicht erfolgreich. Bei Bedarf erneut prüfen.']);
    } else if (priorPositive) {
      text=translation(['Last docking check: 2/2 confirmed (historical)','Letzte Andockprüfung: 2/2 bestätigt (historisch)']);
      detail=translation(['Live station data is outdated. No fresh movement authorization; recheck.',
        'Aktuelle Stationsdaten veraltet. Keine frische Fahrfreigabe; erneut prüfen.']);
    } else {
      text=translation(['Docking not yet confirmed','Andocken noch nicht bestätigt']);
      if (result && age >= 0 && age <= 60000) {
        detail=translation(messages[result] || ['Station could not be verified.','Station konnte nicht bestätigt werden.']);
        uiState='failed';
      }
    }
    const energy=physicalDocked && current
      ? charging ? translation(['charging','lädt'])
        : batteryFull ? translation(['battery full · not charging','Akku voll · lädt nicht'])
        : translation(['not charging','lädt nicht'])
      : '';
    return {state:uiState,text:text+(energy?' · '+energy:''),detail,verified:valid};
  }

  global.MovaDockStatus = { describe };
})(window);

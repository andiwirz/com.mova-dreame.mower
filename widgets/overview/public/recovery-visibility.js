/* Pure overview UI visibility policy. No commands or sensor-state changes. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MovaRecoveryVisibility = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function forOverview(snapshot = {}) {
    const emergency = snapshot.manualRecovery === true;
    const paused = snapshot.garagePaused === true || snapshot.garageEnabled === false;
    const safety = String(snapshot.safety || '').toLowerCase();
    const status = String(snapshot.status || '').toLowerCase();
    // A home/docked tile without native station evidence is uncertainty too.
    const dockMismatch = ['garage_home', 'charging', 'docked'].includes(status)
      && snapshot.recoveryNativeDock !== 'IN_STATION';
    const uncertain = ['warning', 'blocked', 'emergency'].includes(safety) || dockMismatch;
    const home = snapshot.recoveryNativeDock === 'IN_STATION' || ['garage_home','charging','docked'].includes(status);
    const returnHold = snapshot.returnHoldTerminal === true || snapshot.returnHoldStopped === true;
    const stalledOutside = !home && ['paused','idle','standby'].includes(status) && snapshot.mission !== 'mowing';
    const contextual = emergency || (snapshot.garageEnabled === true && ((returnHold && !home) || (snapshot.garagePaused === true && stalledOutside)));
    return {
      dockCheck: true, // Always show the read-only native dock/undock double-check, in AUTO and MANUAL.
      moreOptions: emergency,
      manualGateChecks: emergency && paused,
      contextualReturn: contextual,
    };
  }
  return { forOverview };
});

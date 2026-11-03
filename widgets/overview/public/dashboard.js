// English is the default Homey widget locale; German is selected only when requested.
let overviewGerman = String((typeof Homey !== 'undefined' && Homey.getLanguage?.()) || (navigator.language || 'en')).toLowerCase().startsWith('de');
function t(en,de){ return overviewGerman ? de : en; }
function localizeStaticOverview(){
  document.documentElement.lang = overviewGerman ? 'de' : 'en';
  // Small legacy labels authored directly in German must also follow an
  // English Homey locale (without duplicating the repair/map dictionaries).
  const enFromLegacy = {
    'Original-App: Wartungspunkt-Ziel wählen':'Original app: Select maintenance point',
    'Tor ist offen, der ursprüngliche Herstellerauftrag enthielt keine Punktnummer. Hier P1–P5 ausdrücklich wählen; kein Mähstart.':'Gate is open. The original vendor command contained no point number. Explicitly select P1–P5 here; no mowing start.',
    'Manuelle Übernahme aktivieren':'Enable supervised manual takeover',
    'Rückkehr':'Return to dock',
    'Wartungspunkt':'Maintenance point',
    'Wartungspunkt auswählen':'Select maintenance point',
    'Anfahren':'Drive to point',
    'Automatik wieder aktivieren':'Re-enable automation',
    'Mäher ist DRINNEN (Sichtprüfung)':'Mower is INSIDE (visual check)',
    'Standortangabe ist nur eine Sichtbestätigung, keine GPS- oder Fahrfreigabe.':'Location is a visual report only, not GPS or permission to drive.'
  };
  const de = {
    'Mower overview':'Mäher Totalübersicht','Loading status…':'Lade Status …',
    'Garage door':'Garagentor','End position unknown':'Endlage unbestätigt',
    'Safety: —':'Sicherheit: —','Open door':'Tor AUF','Close door':'Tor ZU',
    'Mowing map · Light / dark':'Mähkarte · Hell / Dunkel',
    'Mowing map':'Mähkarte','Map':'Karte','Edit':'Bearbeiten','Loading map…':'Karte wird geladen …',
    'Enlarge map':'Karte vergrößern','Refresh map':'Karte aktualisieren',
    'Show map status and notes':'Kartenstatus und Hinweise anzeigen',
    'Control mower':'Mäher steuern','Mow':'Mähen','Spot mow':'Spotmähen',
    'Pause / Resume':'Pause / Weiter','Stop mower':'Mäher STOP',
    'Return to dock':'Rückkehr','Maintenance point':'Wartungspunkt',
    'Spot mowing uses the spot selected on the mower.':'Spotmähen verwendet den im Mäher ausgewählten Spot.',
    'Manual rescue · automatic gate control disabled':'Manuelle Bergung · automatische Torsteuerung gesperrt',
    'Confirm gate physically open':'Tor vollständig offen bestätigen',
    'Drive to maintenance point':'Zum Wartungspunkt fahren',
    'Return to dock · no gate command':'Zur Station · ohne Torbefehl',
    'Re-enable automation after docking':'Automatik nach Andocken aktivieren',
    'Verify docking & re-enable automation':'Andocken prüfen & Automatik freigeben',
    'Pause garage automation':'Garagenautomatik pausieren',
    'Manual takeover · use original app':'Manuelle Übernahme · Original-App',
    'Emergency lock · native station verification':'Notfallsperre · nativer Stationsnachweis',
    'The device tile can say docked even if fresh native charging contacts have not been verified.':'Die Gerätekachel kann Angedockt anzeigen, ohne dass aktuelle native Ladekontakte geprüft wurden.',
    'Verify native dock & release automation':'Andocken prüfen & Automatik freigeben',
    'This only reads docking contacts; it does not move the gate or mower. If not fully docked, use manual takeover instead.':'Nur Leseprüfung der Stationskontakte; kein Tor- oder Mäherbefehl. Ist der Mäher nicht angedockt, die manuelle Übernahme verwenden.',
    'Recovery assistant · step by step':'Wiederherstellungs-Assistent · Schritt für Schritt',
    'I will check docking, gate sensor, and passage in a short dialogue.':'Ich prüfe Andocken, Torsensor und Durchfahrt in einem kurzen Dialog.',
    'Start guided recovery':'Wiederherstellung im Dialog starten',
    'More manual rescue options':'Weitere Bergungsfunktionen',
    'Check dock & restore automation':'Andocken prüfen & Automatik freigeben',
    'Confirm docked manually':'Mäher manuell als angedockt bestätigen',
    'Docking status':'Andockstatus','Not checked yet':'Noch nicht geprüft','Check dock':'Andockstatus prüfen','Restore automation':'Automatik wiederherstellen','Record my visual dock observation':'Sichtangabe: Mäher angedockt','Manual recovery options':'Manuelle Bergungsoptionen','Help when something is unclear':'Hilfe bei Unsicherheit','Answer a few questions to regain control safely.':'Bei Problemen führt dich ein kurzer Dialog zurück zur Kontrolle.','Back':'Zurück', 'Restart':'Neu beginnen','Restore normal operation':'Normalbetrieb wiederherstellen','Check mower docking and physically closed gate.':'Mäher in Station und Tor geschlossen? Ein Klick prüft und stellt wieder her.','More recovery options':'Weitere Möglichkeiten','Help with unusual problems':'Hilfe bei Sonderfällen',
    '🏠 Mower visibly docked':'🏠 Mäher sichtbar angedockt','↓ Gate safely CLOSED':'↓ Tor sicher geschlossen',
    'Gate position · visual check':'Torstellung · Sichtprüfung','On-site status verification':'Status vor Ort bestätigen','On-site check · report only, no safety override':'Vor-Ort-Prüfung · nur Anzeige, keine Sicherheitsfreigabe','🏠 Mower at home (visual check)':'🏠 Mäher zu Hause (Sichtprüfung)','↑ Gate safely OPEN':'↑ Tor sicher OFFEN',
    '↓ Gate safely CLOSED':'↓ Tor sicher GESCHLOSSEN',
    'Return needs attention':'Rückkehr benötigt Prüfung',
    'Check mower position and gate before choosing a supervised action.':'Mäherposition und Tor prüfen, dann eine beaufsichtigte Aktion wählen.',
    'Check position & request return':'Position prüfen & Rückkehr veranlassen',
    'Garage automation':'Garagenautomatik',
    'Reading mower and gate status…':'Mäher- und Torstatus wird gelesen …',
    'Visual safety checks':'Sichtprüfungen zur Sicherheit',
    'Mower safely OUTSIDE (visual)':'Mäher sicher DRAUSSEN (Sicht)',
    '↓ Gate visibly CLOSED (operator)':'↓ Tor physisch GESCHLOSSEN (Sichtprüfung)',
    'Original app: Select maintenance point':'Original-App: Wartungspunkt-Ziel wählen',
    'Gate is open. The original vendor command contained no point number. Explicitly select P1–P5 here; no mowing start.':'Tor ist offen, der ursprüngliche Herstellerauftrag enthielt keine Punktnummer. Hier P1–P5 ausdrücklich wählen; kein Mähstart.',
    'Enable supervised manual takeover':'Manuelle Übernahme aktivieren',
    'Re-enable automation':'Automatik wieder aktivieren',
    'Select maintenance point':'Wartungspunkt auswählen',
    'Drive to point':'Anfahren',
    'Mower is INSIDE (visual check)':'Mäher ist DRINNEN (Sichtprüfung)',
    'Location is a visual report only, not GPS or permission to drive.':'Standortangabe ist nur eine Sichtbestätigung, keine GPS- oder Fahrfreigabe.',
    'Direct DOCK (manual, no gate automation)':'Direkt ANDOCKEN (manuell, keine Torautomatik)',
    'P1 drive':'P1 anfahren','P2 drive':'P2 anfahren','P3 drive':'P3 anfahren','P4 drive':'P4 anfahren','P5 drive':'P5 anfahren'
  };
  document.title = overviewGerman ? de['Mower overview'] : 'Mower overview';
  const walker = document.createTreeWalker(document.body,4);
  for(let node;(node=walker.nextNode());){
    if(['SCRIPT','STYLE'].includes(node.parentElement?.tagName)) continue;
    const raw=node.nodeValue, key=raw.trim();
    const english=enFromLegacy[key]||key;
    const localized=overviewGerman?(de[english]||english):english;
    if(localized!==key)node.nodeValue=raw.replace(key,localized);
    // Legacy P1..P5 buttons live only in the original-app reissue surface.
    else if(/^P[1-5] anfahren$/.test(key)&&!overviewGerman)
      node.nodeValue=raw.replace(key,key.replace(' anfahren',' drive'));
  }
  document.querySelectorAll('[aria-label],[title]').forEach(el=>{
    for(const a of ['aria-label','title']){
      const raw=el.getAttribute(a);
      if(raw){const english=enFromLegacy[raw]||raw;const localized=overviewGerman?(de[english]||english):english;
        if(localized!==raw)el.setAttribute(a,localized);
      }
    }
  });
}
let H,id,inView=true,timer=null,mapTimer=null,mapEditing=false,mapExpanded=false;
let lastOverviewStatus='unknown',lastOverviewSnapshot=null,rLastManualRecovery=false,busyAction=null,lastRecoveryFeedbackAt=0,pauseFeedbackActive=false,pendingNavigationFeedback=null;
const $=id=>document.getElementById(id);
function makeOverviewLabels(){return {open:t('Open','Offen'),closed:t('Closed','Geschlossen'),opening:t('Opening','Öffnet'),closing:t('Closing','Schließt'),unknown:t('End position unknown','Endlage unbestätigt'),mowing:t('Mowing','Mäht'),paused:t('Paused','Pausiert'),returning:t('Returning','Rückkehr'),docked:t('Docked','Gedockt'),charging:t('Charging','Lädt'),idle:t('Ready','Bereit'),standby:t('Ready','Bereit'),garage_home:t('At home','Zuhause'),garage_zone_removing:t('Hiding no-go zones','Sperrzonen ausblenden'),garage_zone_restoring:t('Restoring no-go zones','Sperrzonen einblenden'),garage_start_pending:t('Starting','Startbefehl wird ausgeführt'),garage_exiting:t('Leaving garage','Ausfahrt'),garage_adjusting:t('Adjusting','Justieren'),garage_opening:t('Garage opening','Garage öffnet'),garage_closing:t('Garage closing','Garage schließt'),garage_positioning:t('Positioning','Positionierung'),garage_maintenance_transit:t('Going to maintenance point','Zum Wartungspunkt'),garage_maintenance_reached:t('Maintenance point reached','Wartungspunkt erreicht'),garage_free_drive:t('Garage travel','Garagenfahrt'),garage_app_control:t('App control','App-Steuerung')};}
let labels=makeOverviewLabels();
const activeMapStatuses=new Set(['mowing','edge_mowing','leaving','returning','paused','remote_control','mapping','garage_exiting','garage_adjusting','garage_positioning','garage_maintenance_transit']);
const api=(method,path,body={})=>H.api(method,path+(path.includes('?')?'&':'?')+'deviceId='+encodeURIComponent(id),body);
// Homey resizes its iframe after setHeight(). scrollHeight subsequently includes
// that iframe viewport and can never shrink! Measure the last visible flow
// child against the body top instead; hidden panels no longer hold the height.
function measureWidgetContentHeight(){
  const body=document.body;
  if(!body)return 0;
  const top=body.getBoundingClientRect().top;
  let bottom=0;
  for(const child of body.children){
    if(child.hidden || !child.getClientRects().length || getComputedStyle(child).display==='none')continue;
    if(['SCRIPT','STYLE'].includes(child.tagName))continue;
    bottom=Math.max(bottom,child.getBoundingClientRect().bottom-top);
  }
  const padding=parseFloat(getComputedStyle(body).paddingBottom)||0;
  return Math.ceil(Math.max(120,bottom+padding));
}
function resizeWidget(){
  if(!H)return;
  const height=measureWidgetContentHeight();
  if(height>0 && height!==resizeWidget.last){
    resizeWidget.last=height;
    H.setHeight?.(height); // accepts both increases AND decreases
  }
}
resizeWidget.last=0;
function resizeWidgetAfterMapLayout(){
  requestAnimationFrame(()=>requestAnimationFrame(resizeWidget));
  // Recheck once after the 180 ms map-height CSS transition has finished.
  setTimeout(resizeWidget,240);
}
function showError(e){$('error').textContent=e?.message||String(e);resizeWidget();}
function clearError(){$('error').textContent='';}
function markButtonAction(action,state){
  const button=document.querySelector('[data-action="'+action+'"]');
  if(!button)return;
  if(state)button.dataset.uiState=state;else delete button.dataset.uiState;
  button.setAttribute('aria-busy',String(state==='pending'));
}
function dockDescription(snapshot){
  return window.MovaDockStatus?.describe?.(snapshot,t) || {
    state:'idle',text:t('Dock status unavailable','Andockstatus nicht verfügbar'),detail:'',verified:false
  };
}
function displayDockDiagnostics(snapshot){
  const description=dockDescription(snapshot);
  const label=$('dockReadout'), detail=$('dockCheckResult');
  if(label)label.textContent=busyAction==='recovery_dock_check'?t('Checking…','Prüfung läuft …'):description.text;
  if(detail){detail.textContent=busyAction==='recovery_dock_check'?t('Two direct native station reads are in progress.','Zwei direkte native Stationsabfragen laufen.'):description.detail;detail.classList.toggle('failed',busyAction!=='recovery_dock_check'&&description.state==='failed');}
  // A read-only test never flips AUTO / MANUAL or issues any movement.
  if(busyAction!=='recovery_dock_check')markButtonAction('recovery_dock_check',
    description.state==='idle'?null:description.state);
}
function renderGateVisual(snapshot) {
  const view=window.MovaGarageSummary?.forOverview?.(snapshot)||{};
  const manualEmergency=!!snapshot?.manualRecovery;
  const group=$('gateVisualCheck');
  // Emergency uses the ONE compact restoration surface; do not repeat visual checks.
  if(group)group.hidden=!!snapshot?.manualRecovery || !view.showVisual;
  if(!view.showVisual && !snapshot?.manualRecovery)return;
  const visual=snapshot?.visualGate;
  const current=visual?.state;
  const dockVisual=!!snapshot?.visualDock;
  const result=$('gateVisualResult');
  const dockButton=document.querySelector('[data-action="dock_visual_docked"]');
  // During emergency the dedicated restore box owns the dock sight button.
  if(dockButton){
    dockButton.hidden=manualEmergency;
    dockButton.textContent=(dockVisual?'✓ ':'🏠 ')+t('Mower at home (visual check)','Mäher zu Hause (Sichtprüfung)');
    dockButton.setAttribute('aria-pressed',String(dockVisual));
    if(busyAction!=='dock_visual_docked')markButtonAction('dock_visual_docked',dockVisual?'confirmed':null);
  }
  for(const [action,state,label] of [
    ['gate_visual_open','open',t('Gate safely OPEN','Tor sicher OFFEN')],
    ['gate_visual_closed','closed',t('Gate safely CLOSED','Tor sicher GESCHLOSSEN')]]) {
    const button=document.querySelector('[data-action="'+action+'"]');
    if(!button)continue;
    const active=current===state;
    button.textContent=(active?'✓ ':(state==='open'?'↑ ':'↓ '))+label;
    button.setAttribute('aria-pressed',String(active));
    if(busyAction!==action)markButtonAction(action,active?'confirmed':null);
  }
  if(result)result.textContent=view.visualConflict
    ?t('Sensor and visual inspection disagree. Check the actual door. Automatic safety guards still apply.',
       'Sensor und Sichtprüfung widersprechen sich. Bitte Tor kontrollieren. Sicherheitssperren bleiben bestehen.')
    :t('Visual statements change only this display. They expire and never replace native docking, sensor contacts or automatic movement checks.',
       'Sichtprüfungen ändern nur diese Anzeige. Sie verfallen und ersetzen weder native Andockkontakte noch Torsensor oder Fahrfreigaben.');
}

function actionOutcome(action,response,snapshot){
  if(!snapshot)throw Error(t('Status check failed. Command may have been accepted; do not retry blindly.','Statusprüfung fehlgeschlagen. Befehl möglicherweise angenommen; nicht ungeprüft erneut auslösen.'));
  if (action==='context_return_checked' || action==='context_maintenance_checked') {
    if(!response?.positionVerified)throw Error(t('Physical position proof missing. No motion requested.','Physischer Positionsnachweis fehlt. Keine Fahrt angefordert.'));
    return {state:'requested',text:action==='context_return_checked'
      ?t('Native position verified ✓ · return requested under normal safety checks; wait for mower confirmation.',
          'Native Position geprüft ✓ · Rückkehr mit normalen Sicherheitsprüfungen angefordert; Mäherbestätigung abwarten.')
      :t('Native position verified ✓ · maintenance journey requested; wait for mower confirmation.',
          'Native Position geprüft ✓ · Wartungspunktfahrt angefordert; Mäherbestätigung abwarten.')};
  }
  if(action==='recovery_restore_normal') {
    if(snapshot.manualRecovery||snapshot.garagePaused)throw Error(t('Normal operation not confirmed; safety lock remains active.','Normalbetrieb nicht bestätigt; Sicherheits-Sperre bleibt aktiv.'));
    return {state:'confirmed',text:t('Ready ✓ · verified native position / dock · gate CLOSED · no movement', 'Bereit ✓ · native Position/Station geprüft · Tor ZU · keine Fahrt')};
  }
  if(action==='recovery_dock_check') {
    const description=dockDescription(snapshot);
    return {state:description.state==='idle'?'failed':description.state,
      text:description.text+(description.detail?' · '+description.detail:'')+' · '
        +t('Read-only: no movement, no automatic release.','Nur Leseprüfung: keine Bewegung, keine automatische Freigabe.')};
  }
  if(['gate_visual_open','gate_visual_closed','gate_visual_revoke'].includes(action)) {
    return {state: response?.visualGate?.state?'confirmed':'idle',
      text: response?.visualGate?.state
        ?t('Gate position recorded by visual inspection ✓ · sensor unchanged','Torstellung per Sichtprüfung gespeichert ✓ · Sensor unverändert')
        :t('Visual gate confirmation withdrawn','Tor-Sichtprüfung zurückgenommen')};
  }
  if(action==='dock_visual_docked' || action==='dock_visual_revoke') {
    return {state:response?.visualDock?'confirmed':'idle',text:response?.visualDock
      ?t('Mower at home ✓ · visual inspection only; native safety proof unchanged',
         'Mäher zu Hause ✓ · nur Sichtprüfung, nativer Sicherheitsnachweis unverändert')
      :t('Visual mower report withdrawn','Mäher-Sichtprüfung zurückgenommen')};
  }
  if(action==='recovery_operator_dock') {
    if(response?.operatorDockAt===0)return {state:'idle',text:t('Visual dock check withdrawn.','Sichtprüfung Andocken zurückgenommen.')};
    if(!snapshot.recoveryOperatorDockAt)throw Error(t('Manual dock statement was not recorded.','Manuelle Andockangabe wurde nicht übernommen.'));
    return {state:'confirmed',text:t('Docked as reported by operator ✓ · native verification still required for automatic motion','Andocken manuell bestätigt ✓ · zur Automatikfreigabe folgt die native Prüfung')};
  }
  if(action==='recovery_position_outside') {
    const selected=snapshot.manualOperatorPosition==='outside';
    if(selected !== (response?.operatorLocation==='outside'))
      throw Error(t('OUTSIDE observation not retained.','Standortbestätigung DRAUSSEN nicht gespeichert.'));
    return {state:selected?'confirmed':'idle',text:selected
      ?t('Outside observation saved ✓ · independent native position verification follows',
         'Mäher DRAUSSEN bestätigt ✓ · zur Freigabe folgt die native Positionsprüfung')
      :t('Outside visual observation withdrawn','Sichtangabe DRAUSSEN zurückgenommen')};
  }
  if(action==='recovery_confirm_closed') {
    if(response?.operatorGateClosedAt===0)return {state:'idle',text:t('Visual gate check withdrawn.','Sichtprüfung Tor geschlossen zurückgenommen.')};
    if(!snapshot.recoveryOperatorGateClosedAt)throw Error(t('Gate CLOSED observation was not saved.','Sichtprüfung Tor GESCHLOSSEN wurde nicht gespeichert.'));
    return {state:'confirmed',text:t('Gate visually CLOSED ✓ · not a sensor contact.','Tor sicher GESCHLOSSEN ✓ · Sichtprüfung, kein Sensorkontakt.')};
  }
  if(action==='recovery_gate_revoke') {
    return {state:'idle',text:t('Visual OPEN statement withdrawn · native sensor unchanged','Sichtbestätigung OFFEN zurückgenommen · echter Sensor unverändert')};
  }
  if(action==='gate_stop') {
    return {state:'requested',text:t('STOP flow requested · verify physical motor stop; this is not a contact confirmation','Tor-STOP-Flow angefordert · tatsächlichen Motorstopp prüfen; kein Sensornachweis')};
  }
  if(action==='recovery_confirm_open') {
    if(!snapshot.recoveryGateConfirmed)throw Error(t('Gate-open confirmation was not retained. Check current gate sensor and retry only after a visual inspection.','Toröffnung wurde nicht dauerhaft bestätigt. Torsensor kontrollieren und erst nach erneuter Sichtprüfung erneut versuchen.'));
    return {state:'confirmed',text:t('Passage confirmed ✓ · automatic garage mode remains locked','Durchfahrt bestätigt ✓ · Garagenautomatik bleibt gesperrt')};
  }
  if(action==='recovery_begin_manual') {
    if(!snapshot.manualRecovery || !snapshot.manualOperatorFree)throw Error(t('Manual mode not established.','Manueller Modus nicht bestätigt.'));
    return {state:'confirmed',text:t('Manual mode ready · garage automation OFF','Manuelle Steuerung bereit · Garagenautomatik AUS')};
  }
  if(action==='recovery_takeover') {
    if(!snapshot.manualRecovery||!snapshot.garagePaused)throw Error(t('Manual takeover is not confirmed. Check garage pause status.','Manuelle Übernahme nicht bestätigt. Garagenpausierung prüfen.'));
    return {state:'confirmed',text:t('Manual control active ✓ · automatic gate control OFF','Manuelle Übernahme aktiv ✓ · automatische Torsteuerung AUS')};
  }
  if(action==='recovery_rearm'||action==='recovery_rearm_quick') {
    if(snapshot.manualRecovery||snapshot.garagePaused)throw Error(t('Rearm not confirmed. Emergency remains active; original app/manual operation only.','Automatikfreigabe nicht bestätigt. Notfallsperre bleibt aktiv; nur manuelle Bedienung.'));
    return {state:'confirmed',text:t('Native docking verified ✓ · garage automation enabled','Natives Andocken bestätigt ✓ · Garagenautomatik aktiviert')};
  }
  if(action==='garage_pause') {
    if(snapshot.garagePaused!==response?.garagePaused)throw Error(t('Pause state not independently confirmed. Check garage state before continuing.','Pausenzustand nicht bestätigt. Garagenstatus vor Fortsetzung prüfen.'));
    return {state:snapshot.manualRecovery?'requested':'confirmed',text:snapshot.garagePaused?t('Garage automation paused ✓','Garagenautomatik pausiert ✓'):
      snapshot.manualRecovery?t('Automation ON selected ✓ · emergency still blocks gate/mower motion; verify docking to release','Automatik EIN gewählt ✓ · Notfallsperre blockiert Tor-/Mäherbewegung weiterhin; zum Freigeben Andocken prüfen'):
        t('Garage automation resumed ✓','Garagenautomatik fortgesetzt ✓')};
  }
  if(action==='gate_open'||action==='gate_close') {
    const target=action==='gate_open'?'open':'closed';
    if(snapshot.door===target && snapshot.sensorContact===target && !snapshot.doorEstimated)
      return {state:'confirmed',text:action==='gate_open'?t('Gate OPEN verified by contact ✓','Tor OFFEN durch Sensor bestätigt ✓'):t('Gate CLOSED verified by contact ✓','Tor GESCHLOSSEN durch Sensor bestätigt ✓')};
    return {state:'requested',text:t('Gate command accepted · sensor end-position confirmation pending','Torbefehl angenommen · Sensor-Endlagenbestätigung steht noch aus')};
  }
  return {state:'requested',text:actionText(action,snapshot)};
}
// Status below the controls must describe the CURRENT native mower state, not
// the last pause/resume command. Both the button and this feedback read the
// same nativeMowerStatus field. No speculative confirmation on stale data.
function nativePauseStateText(snapshot){
  const native=String(snapshot?.nativeMowerStatus||'').toLowerCase();
  if(native==='paused')return t('Mower paused','Mäher pausiert');
  if(native==='mowing')return t('Mower mowing','Mäher mäht');
  return null;
}
// A request is not a perpetual UI state. Keep the last command visible only
// until Homey reports real progress or a physical station/door result.
function reconcileNavigationFeedback(snapshot){
  if(!pendingNavigationFeedback || busyAction)return;
  const native=String(snapshot?.nativeMowerStatus||'').toLowerCase();
  const state=String(snapshot?.status||'').toLowerCase();
  const door=String(snapshot?.door||'').toLowerCase();
  const docked=['docked','charging','charging_completed'].includes(native)
    || state==='garage_home' || snapshot?.garageHomeConfirmed===true;
  if(docked){
    const gateText=door==='closed'?t(' · gate closed',' · Tor geschlossen'):
      door==='closing'?t(' · gate closing',' · Tor schließt'):'';
    setActionStatus(t('Mower docked','Mäher angedockt')+gateText);
    pendingNavigationFeedback=null;
  } else if(native==='returning' || state.includes('return')){
    setActionStatus(t('Mower returning to station','Mäher fährt zur Station'));
  }
}
function reconcilePauseFeedback(snapshot){
  if(!pauseFeedbackActive || busyAction==='pause')return;
  const current=nativePauseStateText(snapshot);
  if(current)setActionStatus(current);
}
function setActionStatus(text,isError=false){const quick=$('normalRestoreResult');if(quick&&(rLastManualRecovery||Date.now()-lastRecoveryFeedbackAt<30000)){quick.textContent=text||'';quick.classList.toggle('error-state',!!isError);}const el=$('actionStatus');if(el){el.textContent=text||'';el.classList.toggle('error-state',!!isError);}const recovery=$('recoveryInlineResult');if(recovery&&(rLastManualRecovery||Date.now()-lastRecoveryFeedbackAt<30000)){recovery.textContent=text||'';recovery.classList.toggle('error-state',!!isError);}resizeWidget();}
function rescueActionText(action){return ({recovery_operator_dock:t('Docked as reported by operator','Bediener bestätigt Andocken'),recovery_confirm_open:t('Gate opening confirmed by operator','Toröffnung durch Bediener bestätigt'),recovery_maintenance:t('Waypoint trip requested','Wartungspunktfahrt angefordert'),recovery_return:t('Return requested without gate motion','Rückkehr ohne Torbewegung angefordert'),recovery_rearm:t('Automation re-enabled after verified docking','Automatik nach geprüftem Andocken aktiviert'),recovery_rearm_quick:t('Automation re-enabled after verified docking','Automatik nach geprüftem Andocken aktiviert'),recovery_takeover:t('Manual control enabled. Automatic gate control remains OFF. Open passage must be supervised.','Manuelle Kontrolle freigegeben. Torautomatik bleibt AUS. Durchfahrt selbst beaufsichtigen.')})[action];}
function actionText(action,r){if(action==='recovery_dock_check')return t('Reading native dock contacts','Native Andockkontakte werden geprüft');if(rescueActionText(action))return rescueActionText(action);if(action==='mow')return t('Mowing started','Mähen gestartet');if(action==='spot')return t('Spot mowing started','Spotmähen gestartet');if(action==='pause')return (r?.nativeMowerStatus||r?.status)==='paused'?t('Mowing paused','Mähen pausiert'):((r?.nativeMowerStatus||r?.status)==='mowing'?t('Mowing resumed','Mähen fortgesetzt'):t('Pause / resume requested','Pause / Weiter angefordert'));if(action==='stop')return t('Stop requested','Mäher STOP angefordert');if(action==='recovery_pause_safely')return t('PAUSE requested; await native standstill','PAUSE angefordert; nativen Stillstand abwarten');if(action==='return')return t('Returning to dock','Zurück zur Ladestation');if(action==='maintenance')return t('Maintenance-point request sent; arrival not yet verified','Wartungspunkt angefordert; Ankunft noch nicht bestätigt');if(action==='garage_pause')return r?.garagePaused?t('Garage automation PAUSED – original app is your responsibility','Garagenautomatik PAUSIERT – Original-App nur unter eigener Aufsicht'):t('Garage automation resumed','Garagenautomatik fortgesetzt');if(action==='gate_open')return t('Garage door opening requested','Garagentor öffnen angefordert');if(action==='gate_close')return t('Garage door closing requested','Garagentor schließen angefordert');return t('Command sent','Befehl gesendet');}
async function refresh(){if(!id||document.hidden)return null;try{const r=await api('GET','/overview');lastOverviewSnapshot=r;lastOverviewStatus=String(r.status||'unknown');rLastManualRecovery=!!r.manualRecovery;$('name').textContent=r.name;$('battery').textContent=r.battery==null?'—':r.battery+' %';$('status').textContent=labels[r.status]||r.status||t('Unknown','Unbekannt');if($('garageSection'))$('garageSection').hidden=false; // Manual rescue remains reachable with Garage Mode disabled
  // Keep rescue-only controls off the ordinary dashboard. A latched
  // emergency automatically exposes all rescue actions on first observation.
  // Purely informative: native/sensor evidence is never a safety release.
  const garageSummary = document.getElementById('garageSummary');
  if(garageSummary)garageSummary.hidden=!r.garageEnabled;
  if($('garagePauseActions'))$('garagePauseActions').hidden=!r.garageEnabled;
  if (garageSummary && window.MovaGarageSummary) {
    const view = window.MovaGarageSummary.forOverview(r);
    garageSummary.dataset.state = view.state;
    $('garageSummaryTitle').textContent = t(view.titleEn, view.titleDe);
    $('garageSummaryDetail').textContent = t(view.detailEn, view.detailDe);
  }
  const controls=window.MovaRecoveryVisibility.forOverview(r);
  const externalChoice=$('externalMaintenanceChoice');
  if(externalChoice){
    $('externalMaintenanceChoiceTitle').textContent=t('Original app: select waypoint','Original-App: Wartungspunkt auswählen');
    $('externalMaintenanceChoiceHint').textContent=r.externalMaintenanceLearningIndex
      ?t(`Now select P${r.externalMaintenanceLearningIndex} AGAIN in the original MOVA app. Homey is observing the real native 109 journey and will learn its position only after verified arrival.`,`Jetzt P${r.externalMaintenanceLearningIndex} ERNEUT in der MOVA-Original-App anfahren. Homey beobachtet den nativen Auftrag und lernt die Position erst nach bestätigter Ankunft.`)
      :t('Select the configured P1-P5 target. If native coordinates are missing, Homey will ask you to reissue the same point in the original app; no other point is sent.','Konfigurierten Punkt P1–P5 auswählen. Fehlen die nativen Koordinaten, muss derselbe Punkt in der Original-App erneut angefahren werden; Homey sendet keinen Ersatzpunkt.');
    externalChoice.hidden=!r.garageEnabled || !r.externalMaintenanceSelectionPending || !!r.manualRecovery;
    const cancelChoice=externalChoice.querySelector('[data-action="external_maintenance_cancel"]');
    if(cancelChoice)cancelChoice.textContent=t('Cancel selection','Auswahl abbrechen');
    // Configured names remain visible even when native geometry is temporarily
    // missing. Such points arm vendor-app re-learning, NOT a blind motor start.
    const available=new Set((r.configuredMaintenancePoints||r.availableMaintenancePoints||[]).map(Number));
    const confirmed=new Set((r.availableMaintenancePoints||[]).map(Number));
    externalChoice.querySelectorAll('button[data-action^="external_maintenance_point_"]').forEach(btn=>{
      const index=Number(btn.dataset.action.slice(-1));
      btn.hidden=!available.has(index) || !!r.externalMaintenanceLearningIndex;
      const name=String(r.availableMaintenancePointNames?.[index]||'').trim();
      const suffix=confirmed.has(index)?'':t(' (relearn via original app)',' (über Original-App neu anlernen)');
      btn.textContent=(name && name!==`P${index}`?`P${index} – ${name}`:t(`Go to P${index}`,`P${index} anfahren`))+suffix;
    });
  }
  const manualBegin=$('operatorManualButton');
  if(manualBegin){
    // Always offer a non-moving MANUAL takeover while emergency/auto-off is
    // active. Showing it must not depend on gate OPEN, native position or Wi-Fi.
    manualBegin.hidden=(r.garageEnabled && !r.manualRecovery && !r.garagePaused
      && !['blocked','emergency'].includes(r.safety)) || !!r.manualOperatorFree;
    manualBegin.disabled=busyAction==='recovery_begin_manual';
    manualBegin.textContent=t('Activate supervised manual takeover (no movement)','Beaufsichtigte manuelle Übernahme (ohne Fahrbefehl)');
  }
  const dockGroup=$('dockDiagnostics');
  if(dockGroup)dockGroup.hidden=!controls.dockCheck || (r.manualRecovery && r.recoveryNativeDock==='OUT_OF_STATION');
  const more=$('recoveryDetails');
  if(more){
    // Advanced recovery is closed by default; never expand every action automatically.
    if(controls.moreOptions && more.hidden){ more.open=false; }
    if(!controls.moreOptions)more.open=false;
    more.hidden=!controls.moreOptions; // emergency does not hide read-only recovery information
  }
  if(controls.dockCheck)displayDockDiagnostics(r);
  const contextual=$('contextualReturnActions');
  const gateRecoveryOpen=document.querySelector('[data-action="recovery_confirm_open"]');
  const recoveryGrid=document.querySelector('#manualRecoverySection .grid');
  const contextualGrid=contextual?.querySelector('.contextual-return-grid');
  // One single native-open proof button, promoted into the garage panel only
  // when an emergency requires it. Do not clone or duplicate the action.
  if(gateRecoveryOpen && recoveryGrid && contextualGrid){
    const container=r.manualRecovery?document.querySelector('#normalRestoreBox .normal-visual-checks'):contextualGrid;
    if(gateRecoveryOpen.parentElement!==container)container.appendChild(gateRecoveryOpen);
    gateRecoveryOpen.hidden=!r.manualRecovery;
  }
  if(contextual){
    contextual.hidden=!controls.contextualReturn || !!r.manualRecovery;
    const title=$('contextualReturnTitle'),hint=$('contextualReturnHint');
    if(title)title.textContent=r.manualRecovery
      ? t('Manual recovery · choose next step','Manuelle Bergung · nächsten Schritt wählen')
      : t('Return held · choose next step','Rückkehr angehalten · nächsten Schritt wählen');
    if(hint)hint.textContent=r.manualRecovery
      ? (r.recoveryGateConfirmed
        ? t('Gate OPEN confirmed. Choose a supervised action. Native safety checks remain active.','Tor OFFEN bestätigt. Beaufsichtigte Aktion wählen. Native Sicherheitsprüfungen bleiben aktiv.')
        : t('First confirm the fully OPEN gate in “More recovery options”. No mower command without clearance.',
            'Erst das vollständig OFFENE Tor unter „Weitere Möglichkeiten“ bestätigen. Kein Fahrbefehl ohne Durchfahrtfreigabe.'))
      : (r.garagePaused
        ? t('Garage automation is paused. Enable it before requesting an ordinary safeguarded return; emergency recovery remains separate.',
            'Garagenautomatik pausiert. Für die regulär gesicherte Rückkehr erst aktivieren; die Notfallbergung bleibt getrennt.')
        : t('Check the mower and route on site. Two matching native position reads are required; the normal gate and return safeguards remain active.',
            'Mäher und Fahrweg vor Ort prüfen. Zwei übereinstimmende native Positionsmessungen sind Pflicht; die normalen Tor- und Rückkehrsperren bleiben aktiv.'));
    for(const action of ['context_return_checked','context_maintenance_checked']){
      const button=document.querySelector('[data-action="'+action+'"]');
      if(!button)continue;
      const allowed=controls.contextualReturn && (!r.manualRecovery || !!r.recoveryGateConfirmed)
        && (r.manualRecovery || !r.garagePaused)
        && (action==='context_maintenance_checked'
          ? !['returning','maintenance_enroute','docked_wait_rearm'].includes(r.recoveryPhase)
          : !['returning','maintenance_enroute','docked_wait_rearm'].includes(r.recoveryPhase)
             && Math.max(0,Number(r.recoveryReturnRetryAt||0)-Date.now())===0);
      button.disabled=!allowed || busyAction===action;
    }
  }

  const restore=$('normalRestoreBox'), restoreTitle=$('normalRestoreTitle'), restoreHint=$('normalRestoreHint');
  if(restore){
    const recentlyRestored=!r.manualRecovery&&!r.garagePaused&&Date.now()-lastRecoveryFeedbackAt<30000;
    const manualEmergency=!!r.manualRecovery;
    // Restore is available for an outdoor mower too. The server still checks
    // two native positions, safe lawn geometry and a physically closed gate.
    restore.hidden=!manualEmergency&&!recentlyRestored;
    if(restoreTitle)restoreTitle.textContent=recentlyRestored?t('Normal operation ready ✓','Normalbetrieb bereit ✓'):r.manualRecovery?t('Restore normal operation','Normalbetrieb wiederherstellen'):t('Automation paused','Automatik pausiert');
    const visualOpen=document.querySelector('#normalRestoreBox [data-action="recovery_confirm_open"]');
    if(visualOpen){
      const selected=!!r.recoveryGateConfirmed;
      visualOpen.textContent=selected?t('✓ OPEN confirmed · tap to withdraw','✓ Tor OFFEN bestätigt · zum Zurücknehmen tippen'):t('Gate safely OPEN (visual)','Tor physisch OFFEN (Sicht)');
      visualOpen.setAttribute('aria-pressed',String(selected));
      if(busyAction!=='recovery_confirm_open')markButtonAction('recovery_confirm_open',selected?'confirmed':null);
    }
    const visualDock=document.querySelector('#normalRestoreBox [data-action="recovery_operator_dock"]');
    const outsideBtn=document.querySelector('#normalRestoreBox [data-action="recovery_position_outside"]');
    if(outsideBtn){
      const outsideSelected=r.manualOperatorPosition==='outside';
      outsideBtn.hidden=r.recoveryNativeDock==='IN_STATION' || !!r.recoveryWaypointSeen;
      outsideBtn.textContent=outsideSelected?t('✓ Mower safely OUTSIDE (visual)','✓ Mäher sicher DRAUSSEN (Sicht)'):t('Mower safely OUTSIDE (visual)','Mäher sicher DRAUSSEN (Sicht)');
      outsideBtn.setAttribute('aria-pressed',String(outsideSelected));
      if(busyAction!=='recovery_position_outside')markButtonAction('recovery_position_outside',outsideSelected?'confirmed':null);
      outsideBtn.disabled=busyAction==='recovery_position_outside';
    }
    const nativeDockChecked=r.recoveryNativeDock==='IN_STATION'&&r.recoveryNativeUndock===0
      && ['confirmed','confirmed_not_charging'].includes(String(r.recoveryDockReadback?.result||''))
      && Number(r.recoveryDockReadback?.reads)===2
      && Date.now()-Number(r.recoveryDockReadback?.at||0)>=0
      && Date.now()-Number(r.recoveryDockReadback?.at||0)<10*60*1000;
    if(visualDock)visualDock.hidden=nativeDockChecked||!!r.recoveryGateConfirmed||r.recoveryNativeDock==='OUT_OF_STATION'||r.manualOperatorPosition==='outside'||r.recoveryWaypointSeen;
    const visualClosed=document.querySelector('#normalRestoreBox [data-action="recovery_confirm_closed"]');
    // A gate cannot be visually OPEN and CLOSED at the same time. Show
    // the selected state; let CLOSED be revoked by clicking it again.
    if(visualOpen)visualOpen.hidden=!!r.recoveryOperatorGateClosedAt;
    if(visualClosed)visualClosed.hidden=!!r.recoveryGateConfirmed;
    for(const [button,verified,en,de] of [
      [visualDock,!!r.recoveryOperatorDockAt,'Mower visibly docked','Mäher sichtbar angedockt'],
      [visualClosed,!!r.recoveryOperatorGateClosedAt,'Gate physically CLOSED (visual only)','Tor physisch GESCHLOSSEN (Sichtprüfung)']]){
      if(!button)continue;
      button.textContent=(verified?'✓ ':'🏠 ')+t(en,de);
      button.setAttribute('aria-pressed',String(verified));
      if(busyAction!==button.dataset.action)markButtonAction(button.dataset.action,verified?'confirmed':null);
      button.disabled=busyAction===button.dataset.action;
    }
    const quickControls=$('recoveryQuickControls');
    const mowerOutside=!!r.recoveryWaypointSeen||r.manualOperatorPosition==='outside';
    const moving=!!r.recoveryObservedMoving;
    // Native two-read station lock is stronger than a stale cloud 'docked'
    // activity label. No motor command follows from showing this evidence.
    const stationary=!!r.recoveryStationaryObserved||nativeDockChecked;
    const pauseButton=document.querySelector('[data-action="recovery_pause_safely"]');
    if(pauseButton){
      pauseButton.hidden=!r.manualRecovery||!moving;
      pauseButton.disabled=busyAction==='recovery_pause_safely';
      pauseButton.textContent=t('Safely PAUSE mower','Mäher sicher PAUSIEREN');
    }
    const motionHint=$('recoveryMotionHint');
    if(motionHint){
      motionHint.hidden=!r.manualRecovery||!mowerOutside||stationary;
      if(!motionHint.hidden)motionHint.textContent=moving
      ?t('Mower is still moving: PAUSE it first and wait for native standstill before releasing automation or choosing a waypoint.',
       'Mäher fährt noch: zuerst PAUSE und nativen Stillstand abwarten, bevor Automatik oder Wartungspunkt freigegeben werden.')
      :t('No fresh native standstill yet. Check the mower and wait for current telemetry. No movement command is sent.',
       'Noch kein frischer nativer Stillstand. Mäher prüfen und aktuelle Telemetrie abwarten. Kein Fahrbefehl.');
    }
    const stableGate=r.door==='open'||r.door==='closed';
    const visualGateOk=!!r.recoveryGateConfirmed || !!r.recoveryOperatorGateClosedAt;
    if(quickControls)quickControls.hidden=recentlyRestored||!r.manualRecovery||!stationary||nativeDockChecked;
    const quickReturn=document.querySelector('[data-action="recovery_quick_return"]');
    if(quickReturn){
      quickReturn.hidden=!mowerOutside||['returning','maintenance_enroute','docked_wait_rearm'].includes(r.recoveryPhase);
      quickReturn.disabled=busyAction==='recovery_quick_return'||!stableGate||!visualGateOk||!stationary;
    }
    const configuredPoints=(Array.isArray(r.availableMaintenancePoints)?r.availableMaintenancePoints:[])
      .map(Number).filter(p=>Number.isInteger(p)&&p>=1&&p<=5);
    const selector=$('recoveryPointSelect');
    if(selector){
      const wanted=configuredPoints.join(',');
      if(selector.dataset.available!==wanted){
        const selected=Number(selector.value);
        selector.replaceChildren(...configuredPoints.map(p=>{
          const option=document.createElement('option');option.value=String(p);option.textContent='P'+p;return option;
        }));
        selector.dataset.available=wanted;
        if(configuredPoints.includes(selected))selector.value=String(selected);
      }
    }
    const pointRow=document.querySelector('#recoveryQuickControls .recovery-point-choose');
    if(pointRow)pointRow.hidden=!mowerOutside||!configuredPoints.length||['returning','maintenance_enroute','docked_wait_rearm'].includes(r.recoveryPhase);
    const pointBtn=document.querySelector('[data-action="recovery_quick_waypoint"]');
    if(pointBtn)pointBtn.disabled=busyAction==='recovery_quick_waypoint'||!mowerOutside||!configuredPoints.length||!stationary;
    const quickBtn=document.querySelector('[data-action="recovery_restore_normal"]');
    if(quickBtn){
      quickBtn.hidden=recentlyRestored;
      // Offer only the NEXT available step. Do not let the user run into a
      // generic backend rejection while a visual prerequisite is missing.
      const hasGate=!!r.recoveryOperatorGateClosedAt || !!r.recoveryGateConfirmed;
      const hasLocation=nativeDockChecked || !!r.recoveryOperatorDockAt || r.manualOperatorPosition==='outside' || !!r.recoveryWaypointSeen;
      quickBtn.disabled=busyAction==='recovery_restore_normal';
      quickBtn.title=!stationary?t('Confirm fresh native standstill before recovery','Zuerst frischen nativen Stillstand abwarten')
        :!hasGate?t('Confirm gate OPEN or CLOSED first','Zuerst Tor OFFEN oder GESCHLOSSEN bestätigen')
        :!hasLocation?t('Confirm mower safely OUTSIDE or docked first','Zuerst Mäher sicher DRAUSSEN oder angedockt bestätigen')
        :t('Verify native evidence and restore automation','Native Nachweise prüfen und Automatik freigeben');
    }
    if(restoreHint){
      const outdoor=r.manualOperatorPosition==='outside'||r.recoveryWaypointSeen;
      const dock=nativeDockChecked;
      const contact=r.recoveryGateLastRealContact==='closed';
      const locationLabel=dock||outdoor?t('✓ Mower location selected','✓ Mäherstandort angegeben'):t('1. Confirm mower safely OUTSIDE or docked','1. Mäher sicher DRAUSSEN oder angedockt bestätigen');
      const gateLabel=r.recoveryGateConfirmed&&r.door==='open'?t('✓ Gate visually OPEN','✓ Tor physisch OFFEN'):
        r.recoveryOperatorGateClosedAt?t('✓ Gate visually CLOSED','✓ Tor physisch GESCHLOSSEN'):
        t('2. Confirm gate OPEN or CLOSED as observed','2. Tor OFFEN oder GESCHLOSSEN vor Ort bestätigen');
      restoreHint.textContent=locationLabel+' · '+gateLabel+'. '+
        (r.recoveryGateConfirmed&&r.door==='open'
         ? t('OPEN: choose guarded return. Native safety checks run before travel; no second gate pulse.',
             'OFFEN: Rückkehr wählen. Native Sicherheitsprüfung vor Fahrt; kein zweiter Torimpuls.')
         :dock||outdoor ? t('CLOSED: restore automation without moving mower or gate, or choose guarded return.',
             'ZU: Automatik ohne Bewegung wiederherstellen oder gesicherte Rückkehr wählen.')
         :t('No motor command is sent by these sight checks.','Sichtprüfungen senden keinen Fahrbefehl.'));
      // A real sensor report is NOT a substitute for the operator visual gate
      // check. Keep it visible only as context, never as a pre-checked button.
      if(!contact && r.recoveryGateLastRealContact==='open')
        restoreHint.textContent+=' '+t('Sensor last reported OPEN — verify discrepancy.','Sensor meldete zuletzt OFFEN – Widerspruch prüfen.');
    }
  }
  const summary=$('recoveryQuickStatus');
  if(summary){
    const showSuccess=!r.manualRecovery && Date.now()-lastRecoveryFeedbackAt<30000;
    summary.hidden=!r.manualRecovery&&!showSuccess;
    $('recoveryPrimaryActions').hidden=true; // duplicate restore removed; compact primary action owns release
    if(showSuccess){
      $('recoverySummaryTitle').textContent=t('Automation restored ✓','Automatik wieder aktiv ✓');
      $('recoverySummaryText').textContent=t('Emergency lock released after independent native evidence. No movement.','Notfallsperre nach unabhängiger nativer Prüfung aufgehoben. Keine Fahrt.');
    }else if(r.manualRecovery){
      const native=String(r.recoveryNativeDock||'unknown')==='IN_STATION'&&r.recoveryNativeUndock===0;
      const verified=native&&['confirmed','confirmed_not_charging'].includes(String(r.recoveryDockReadback?.result||''));
      const charged=!r.recoveryNativeCharging && Number(r.battery)>=99;
      $('recoverySummaryTitle').textContent=verified?t('Docking verified – automation still locked','Andocken bestätigt – Automatik noch gesperrt'):t('Emergency lock active · restore safely','Notfallsperre aktiv · sicher wiederherstellen');
      const state=native?t('Station reports docked','Station meldet angedockt'):t('Native station not confirmed','Native Station noch nicht bestätigt');
      const energy=r.recoveryNativeCharging?t(' · charging',' · lädt'):charged?t(' · full battery, not charging',' · Akku voll, lädt nicht'):t(' · not currently charging',' · lädt momentan nicht');
      const operator=r.recoveryOperatorDockAt?t(' · manually reported docked',' · manuell als angedockt bestätigt'):'';
      $('recoverySummaryText').textContent=state+energy+operator+'. '+t('Use “Check dock” above for a diagnostic. “Restore automation” is a separate, explicit step.','„Andockstatus prüfen“ liest nur den Kontakt. „Automatik wiederherstellen“ ist ein separater Schritt.');
    }
  }
  const doorActions=$('garageDoorActions');
  // Paused AUTO is NOT an operating mode: the server rejects ordinary manual
  // OPEN/CLOSE in that state. Never advertise clickable dead buttons.
  // Manual takeover stays possible even when the optional Garage Mode setting
  // is OFF. Safety BLOCK/EMERGENCY cannot advertise an ordinary gate motor pulse.
  const gateMotorAccessible=(!!r.manualRecovery && !!r.manualOperatorFree)
    || (!!r.garageEnabled && !r.garagePaused && !r.manualRecovery
      && !['blocked','emergency'].includes(r.safety));
  if(doorActions)doorActions.hidden=!gateMotorAccessible;
  const gateHint=$('garageDoorActionHint');
  if(gateHint){gateHint.textContent=r.manualRecovery&&!r.manualOperatorFree
    ?t('Activate supervised manual takeover to unlock individual gate commands.',
       'Für Tor-Einzelbefehle erst beaufsichtigte manuelle Übernahme aktivieren.')
    :['blocked','emergency'].includes(r.safety)&&!r.manualRecovery
      ?t('Sicherheitsmodus: Torbefehle gesperrt. Beaufsichtigte manuelle Übernahme wählen.',
         'Sicherheitsmodus: Torbefehle gesperrt. Beaufsichtigte manuelle Übernahme wählen.')
    :r.garagePaused&&!r.manualRecovery
      ?t('AUTO paused: choose supervised manual takeover before OPEN/CLOSE.',
         'Automatik pausiert: vor Tor AUF/ZU zunächst manuelle Übernahme aktivieren.')
      :r.manualRecovery
        ?t('Single supervised gate pulses; physical OPEN/CLOSED must be checked separately.',
           'Einzelne beaufsichtigte Torimpulse; OFFEN/ZU separat prüfen.')
        :t('Gate via Homey flows; a dispatched flow is not proof of motion.',
           'Torsteuerung über Homey-Flows; ein ausgelöster Flow beweist keine Torfahrt.');}
  const pauseBtn=document.querySelector('[data-action="garage_pause"]');
  if(pauseBtn){pauseBtn.textContent=r.garagePaused?t('Enable garage automation','Garagenautomatik aktivieren'):
    r.manualRecovery?t('Disable garage automation · emergency still locked','Garagenautomatik deaktivieren · Notfallsperre aktiv'):
      t('Pause garage automation','Garagenautomatik pausieren');pauseBtn.setAttribute('aria-pressed',String(!!r.garagePaused));
    pauseBtn.hidden=!!r.manualRecovery; // restore or manual takeover are the only emergency main actions
    if(busyAction!=='garage_pause')markButtonAction('garage_pause',r.manualRecovery?'requested':r.garagePaused?'confirmed':null);pauseBtn.disabled=busyAction==='garage_pause';}if($('door')){$('door').textContent=r.doorStopped?t('STOP active · ','STOP aktiv · ')+(labels[r.door]||t('End position unknown','Endlage unbestätigt')):((labels[r.door]||t('End position unknown','Endlage unbestätigt'))+(r.doorEstimated?t(' · time-based',' · zeitbasiert'):''));$('sensor').textContent='Sensor: '+({online:t('Online','Online'),offline:t('Offline','Offline'),unknown:t('Unknown','Unbekannt')}[r.sensor]||r.sensor);$('safety').textContent=t('Safety: ','Sicherheit: ')+({ok:t('clear','frei'),warning:t('Warning','Hinweis'),blocked:t('blocked','gesperrt'),emergency:t('Emergency','Notfall')}[r.safety]||t('unknown','unbekannt'));document.querySelectorAll('[data-action^="gate_"]').forEach(b=>{
      b.disabled=!gateMotorAccessible||busyAction===b.dataset.action;
      b.title=!gateMotorAccessible?t('Activate supervised manual takeover','Beaufsichtigte manuelle Übernahme aktivieren')
        :t('One gate motor request via configured Homey Flow; physical sensor/clearance checks still apply',
           'Ein Torbefehl über den eingerichteten Homey-Flow; Torsensor und Sicherheitsprüfungen bleiben maßgeblich');
      if(b.dataset.uiState==='requested' && r.door===(b.dataset.action==='gate_open'?'open':'closed')
        && r.sensorContact===r.door && !r.doorEstimated){
        markButtonAction(b.dataset.action,'confirmed');
        setActionStatus(b.dataset.action==='gate_open'
          ? t('Gate OPEN verified by contact ✓','Tor OFFEN durch Sensor bestätigt ✓')
          : t('Gate CLOSED verified by contact ✓','Tor GESCHLOSSEN durch Sensor bestätigt ✓'));
      }
    });if($('manualRecoverySection'))$('manualRecoverySection').hidden=!r.manualRecovery;

  const fastEvidence=$('emergencyDockEvidence');
  if(r.manualRecovery && fastEvidence){
    const age=r.recoveryNativeAgeMs==null?t('not available','nicht verfügbar')
      :Math.round(Number(r.recoveryNativeAgeMs)/1000)+' s';
    const nativeProof=t('Native station','Native Station')+': '+String(r.recoveryNativeDock||'unknown')
      +' · undock='+String(r.recoveryNativeUndock??'?')
      +' · '+t('charging','Laden')+'='+String(r.recoveryNativeCharging?'1':'0')
      +' · '+t('frame age','Meldungsalter')+'='+age;
    const reason=String(r.recoveryDockReadback?.result||'');
    const reasons={confirmed:t('Native contacts confirmed','Native Kontakte bestätigt'),read_unavailable:t('Direct station read failed','Direkte Stationsabfrage fehlgeschlagen'),native_api_unavailable:t('Native station query unavailable','Native Abfrage nicht verfügbar'),no_native_frame:t('Native frame missing/stale','Native Meldung fehlt/veraltet'),dock_not_locked:t('IN_STATION/u0 missing','IN_STATION/u0 fehlt'),charging_missing:t('Native charging not confirmed','Natives Laden nicht bestätigt'),dock_changed_during_check:t('Dock contact changed during verification','Andockkontakt bei der Prüfung verändert'),persist_failed:t('Release not durably stored','Freigabe nicht dauerhaft gespeichert'),gate_moving:t('Gate movement in progress','Torbewegung aktiv'),active_navigation:t('Navigation still active','Navigation noch aktiv')};
    fastEvidence.textContent=t('Homey tile “Docked” is not sufficient. ','Homey-Kachel „Angedockt“ reicht allein nicht. ')
      +nativeProof+(reason?' · '+t('Last verification','Letzte Prüfung')+': '+(reasons[reason]||reason):'');
  }
  const ordinaryMowerControls=$('ordinaryMowerControls');
  if(ordinaryMowerControls)ordinaryMowerControls.hidden=false; // Always display normal mower controls; server guards recovery commands.
  const normalPause=ordinaryMowerControls?.querySelector('[data-action="pause"]');
  if(normalPause && r.manualRecovery)normalPause.textContent=t('PAUSE safely (no resume)','Sicher PAUSE (kein Fortsetzen)');
  else if(normalPause){
    const native=String(r.nativeMowerStatus||'').toLowerCase();
    const paused=native==='paused';
    normalPause.textContent=paused?t('Resume mowing','Mähen fortsetzen'):t('Pause mowing','Mähen pausieren');
    // Clear command acknowledgement styling from the previous toggle as soon
    // as the native snapshot confirms the physical state.
    if(!busyAction && ['paused','mowing','returning','mapping','docked','charging','idle'].includes(native))
      markButtonAction('pause',null);
    reconcilePauseFeedback(r);
  }
  reconcileNavigationFeedback(r);
  if(r.manualRecovery){
    for(const redundant of ['recovery_maintenance','recovery_return']){
      const btn=document.querySelector('[data-action="'+redundant+'"]');
      if(btn)btn.hidden=true;
    }
    const currentLocation=r.manualOperatorPosition||'unknown';
    const locText=$('manualLocationHint');
    if(locText)locText.textContent=currentLocation==='outside'
      ? t('Outside reported · open the gate only after verifying the moving path is clear. Gate must be OPEN before any dock crossing.',
        'Mäher DRAUSSEN bestätigt · Tor nur bei freiem Schwenkbereich betätigen. Für die Einfahrt muss es vollständig offen sein.')
      : currentLocation==='inside'
        ? t('Inside reported · confirm full gate opening before asking the mower to leave.',
          'Mäher DRINNEN bestätigt · Tor vor einer Ausfahrt vollständig öffnen.')
        : t('Location unknown · obtain visual confirmation before any gate or mower command.',
          'Standort unklar · vor jedem Tor- oder Fahrbefehl Lage und Gefahrenbereich prüfen.');
    for(const button of document.querySelectorAll('#manualLocationChooser [data-action]')) {
      const selected=button.dataset.action==='recovery_position_'+currentLocation;
      button.setAttribute('aria-pressed',String(selected));
      if(busyAction!==button.dataset.action)markButtonAction(button.dataset.action,selected?'confirmed':null);
    }
    const info=$('manualRecoveryInfo');
    if(info){
      const reasonText=({no_departure:t('Dock command accepted but mower did not depart. Check the mower and try again manually.','Dock-Befehl angenommen, aber der Mäher ist nicht losgefahren. Mäher prüfen und manuell erneut versuchen.'),telemetry_timeout:t('No fresh mower position. Check connectivity and mower before proceeding.','Keine frische Mäherposition. Verbindung und Mäher vor Fortsetzung prüfen.'),progress_stalled:t('Return stopped progressing. Inspect mower and route.','Rückkehr ohne weiteren Fortschritt. Mäher und Fahrweg prüfen.'),overall_timeout:t('Return timed out. Inspect mower and route.','Rückkehrzeit überschritten. Mäher und Fahrweg prüfen.'),dock_ack_uncertain:t('Dock command response uncertain. Do not retry immediately; inspect the mower first.','Dock-Befehlsantwort unklar. Nicht sofort wiederholen; zuerst Mäher prüfen.'),watch_error:t('Return monitoring failed. Check the mower and try again only with fresh status and gate confirmation.','Rückkehrüberwachung fehlgeschlagen. Mäher prüfen und erst nach neuer Status- und Torbestätigung fortfahren.')})[r.recoveryReturnFailure];
      info.textContent=reasonText || t('Manual rescue commands. Use only while supervising the mower and the gate.','Weitere Funktionen für die beaufsichtigte manuelle Bergung.');
    }
    const retrySeconds=Math.max(0,Math.ceil((Number(r.recoveryReturnRetryAt||0)-Date.now())/1000));
    if(retrySeconds && r.recoveryReturnFailure==='dock_ack_uncertain' && info) info.textContent+=' '+t('Retry lock: ','Wiederholung gesperrt: ')+retrySeconds+' s';
    if(r.garagePaused&&info)info.textContent=r.manualOperatorFree
      ? t('Manual control ACTIVE: PAUSE/STOP, gate pulses and direct P1–P5/DOCK are shown below. A grey command needs a physical clearance; restart AUTO only after a separate native safety check.','MANUELLE KONTROLLE AKTIV: PAUSE/STOP, Torimpulse und direkte P1–P5-/DOCK-Befehle sind verfügbar. Graue Schaltflächen benötigen noch einen Sicherheitsnachweis. Automatik erst nach gesonderter nativer Freigabe einschalten.')
      : t('Garage automation is OFF. Activate supervised manual takeover to show all individual controls; no motor moves when switching modes.','Garagenautomatik AUS. Über „Beaufsichtigte manuelle Übernahme“ alle Einzelbefehle anzeigen; beim Moduswechsel fährt kein Motor.');
    else if(info)info.textContent+=' '+t('Automation ON is selected, but motion stays locked until native docking verification succeeds.','Automatik EIN ist gewählt, aber die Bewegungsfreigabe bleibt bis zur erfolgreichen nativen Andockprüfung gesperrt.');
    const gateConfirmed=!!r.recoveryGateConfirmed;
    const confirmBtn=document.querySelector('[data-action="recovery_confirm_open"]');
    if(confirmBtn){
      confirmBtn.textContent=gateConfirmed
        ? t('Passage confirmed ✓','Durchfahrt bestätigt ✓')
        : t('Confirm gate physically open','Tor vollständig offen bestätigen');
      confirmBtn.setAttribute('aria-pressed',String(gateConfirmed));
      if(busyAction!=='recovery_confirm_open')markButtonAction('recovery_confirm_open',gateConfirmed?'confirmed':null);
      confirmBtn.title=gateConfirmed
        ? t('Visual confirmation recorded for this recovery; a new gate movement invalidates it.','Sichtbestätigung für diese Bergung gespeichert; eine neue Torbewegung hebt sie auf.')
        : t('Only confirm after visually checking that the full passage is open and free.','Nur nach Sichtkontrolle der vollständig offenen und freien Durchfahrt bestätigen.');
    }
    const takeoverButton=document.querySelector('[data-action="recovery_takeover"]');
    if(takeoverButton){takeoverButton.textContent=r.manualOperatorFree?t('Manual takeover active ✓','Manuelle Übernahme aktiv ✓'):t('Take manual control (no movement)','Manuelle Übernahme (ohne Fahrt)');takeoverButton.setAttribute('aria-pressed',String(!!r.manualOperatorFree));if(busyAction!=='recovery_takeover')markButtonAction('recovery_takeover',r.manualOperatorFree?'confirmed':null);}
    const manualDirect=!!r.manualOperatorFree&&!!r.garagePaused;
    const directOutdoor=!!r.recoveryWaypointSeen || r.manualOperatorPosition==='outside';
    // Keep the ENTIRE manual command panel visible once takeover is active.
    // Previously the crucial DOCK/P buttons disappeared when the gate was
    // unconfirmed, making recovery appear broken or featureless. A disabled
    // action explains a missing physical prerequisite; visibility never grants
    // a firmware command, and all server-side safety interlocks still apply.
    for(const button of document.querySelectorAll('[data-action^="recovery_direct_"]')) {
      const isDock=button.dataset.action==='recovery_direct_dock';
      const pointIndex=isDock?null:Number(button.dataset.action.slice(-1));
      const configured=isDock || (Array.isArray(r.availableMaintenancePoints)
        && r.availableMaintenancePoints.map(Number).includes(pointIndex));
      const passageEligible=!!r.recoveryGateConfirmed || (!isDock && directOutdoor);
      button.hidden=!manualDirect || !configured;
      button.disabled=!manualDirect || !configured || !passageEligible || busyAction===button.dataset.action;
      button.title=!manualDirect?t('Activate manual takeover first','Zuerst manuelle Übernahme aktivieren')
        :passageEligible?t('Supervised command; native safeguards remain active','Beaufsichtigter Befehl; native Sicherheitsprüfungen bleiben aktiv')
        :isDock?t('Confirm the physically OPEN gate first','Zuerst die physisch OFFENE Durchfahrt bestätigen')
        :t('Confirm OPEN gate or verified outdoor position first','Tor OFFEN oder sichere Außenposition nachweisen');
      if(button.dataset.action==='recovery_direct_dock')button.textContent=t('Direct to dock (supervised)','Direkt zur Station (beaufsichtigt)');
      else button.textContent=t('Direct P','Direkt P')+button.dataset.action.slice(-1)+' · '+t('manual','manuell');
    }
    const possible={recovery_operator_dock:true,recovery_takeover:!r.manualOperatorFree,recovery_confirm_open:true,recovery_maintenance:!!r.recoveryGateConfirmed&&!['returning','maintenance_enroute','docked_wait_rearm'].includes(r.recoveryPhase),recovery_return:!!r.recoveryGateConfirmed&&retrySeconds===0&&Number(r.recoveryReturnAttempts||0)<2&&(r.recoveryPhase==='maintenance_reached'||r.recoveryCanRevalidate&&['revalidate_point','manual_hold'].includes(r.recoveryPhase)),recovery_rearm:true};
    for(const [action,enabled] of Object.entries(possible)){
      const button=document.querySelector('[data-action="'+action+'"]');
      if(button)button.disabled=!enabled||busyAction===action;
    }
  }
  renderGateVisual(r);
  $('garageNote').textContent=r.manualRecovery?
    t('Emergency latch active until verified outdoor or dock release.','Notfallsperre bis zur sicheren Außen- oder Stationsprüfung aktiv.'):
    r.garagePaused?t('Garage automation paused. You are responsible for the physical gate.','Garagenautomatik pausiert. Du übernimmst die Kontrolle über die Durchfahrt.'):r.garageEnabled?(r.doorStopped?t('Automation blocked. Secure gate operation locally.','Automatik gesperrt. Torantrieb vor Ort sichern.'):t('Door commands use your connected flows.','Torbefehle wirken über deine verknüpften Flows.')):t('Garage mode disabled','Garagenmodus deaktiviert');}resizeWidget();return r;}catch(e){showError(e);return null;}finally{clearTimeout(timer);timer=setTimeout(refresh,2200);}}
let compactMapStatus='';
function setCompactMapStatus(snapshot){
  const items=[];
  const name=String(snapshot?.mapName||t('Map','Karte'));
  items.push(t('Map','Karte')+': '+name);
  const ts=Number(snapshot?.updatedAt||0);
  if(ts>0)items.push(t('View refreshed','Ansicht abgerufen')+': '+new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
  if(snapshot?.mowerStatus){const state=String(snapshot.mowerStatus);items.push(t('Mower status','Mäherstatus')+': '+(labels[state]||state));}
  if(snapshot?.routeCompletionConfirmed)items.push(t('Mowing completed in Homey · mowing pattern saved','Mähen in Homey abgeschlossen · Mähmuster gespeichert'));
  if(!snapshot?.hasMap)items.push(t('No map data available.','Keine Kartendaten verfügbar.'));
  compactMapStatus=items.join('\n');
  const panel=$('overviewMapStatusPanel');
  if(panel&&!panel.hidden)panel.textContent=compactMapStatus;
}
function mapDelay(){return activeMapStatuses.has(lastOverviewStatus)?1800:8000;}
async function refreshMap(force=false){if(!id||document.hidden||!inView||mapEditing)return;const box=$('mapStatic'),refreshBtn=$('overviewMapRefresh');try{if(force&&refreshBtn){refreshBtn.classList.add('loading');refreshBtn.disabled=true;}const r=force?await api('GET','/map-snapshot?refresh=1&hard=1&_='+Date.now()):await api('GET','/map-snapshot');if(!box)return;setCompactMapStatus(r);if(r?.svg){box.innerHTML=r.svg;box.classList.remove('empty');const meta=$('overviewMapMeta');if(meta)meta.textContent=t('Map · ','Karte · ')+new Date(r.updatedAt||Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}else{box.innerHTML='<div class="map-loading">'+t('No map data available yet.','Noch keine Kartendaten verfügbar.')+'</div>';box.classList.add('empty');}resizeWidget();}catch(e){if(box)box.innerHTML='<div class="map-loading">'+t('Map temporarily unavailable.','Karte momentan nicht verfügbar.')+'</div>';setCompactMapStatus({hasMap:false});if(force)showError(e);}finally{if(force&&refreshBtn){refreshBtn.classList.remove('loading');refreshBtn.disabled=false;}clearTimeout(mapTimer);mapTimer=setTimeout(refreshMap,mapDelay());}}
function setupMapEditor(){
  const host=$('overviewMapInline'),staticMap=$('mapStatic'),footer=$('overviewMapFooter'),button=$('overviewMapEdit'),refreshBtn=$('overviewMapRefresh'),stage=$('overviewMapStage'),expandButton=$('overviewMapExpand');
  if(!host||!staticMap||!footer||!button||!stage||!expandButton)return;
  const statusButton=$('overviewMapInfo'),statusPanel=$('overviewMapStatusPanel');
  if(statusButton&&statusPanel){statusButton.onclick=()=>{const visible=statusPanel.hidden;statusPanel.hidden=!visible;statusButton.setAttribute('aria-expanded',String(visible));if(visible)statusPanel.textContent=compactMapStatus||t('Map status is not yet available.','Kartenstatus ist noch nicht verfügbar.');resizeWidget();};}
  let frame=null;
  function setEditorHeight(value){
    const requested=Math.max(270,Math.min(620,Number(value)||300));
    const h=mapExpanded?Math.max(510,requested):requested;
    host.style.height=Math.round(h)+'px';
    resizeWidget();
  }
  function setExpanded(expanded){
    mapExpanded=!!expanded;
    stage.classList.toggle('expanded',mapExpanded);
    expandButton.setAttribute('aria-expanded',String(mapExpanded));
    const german=overviewGerman;
    const label=mapExpanded?(german?'Karte verkleinern':'Reduce map size'):(german?'Karte vergrößern':'Enlarge map');
    expandButton.title=label;
    expandButton.setAttribute('aria-label',label);
    if(mapEditing)setEditorHeight(mapExpanded?510:300);
    resizeWidgetAfterMapLayout();
  }
  function closeEditor({refresh=true,notifyChild=true}={}){
    mapEditing=false;
    button.setAttribute('aria-expanded','false');
    if(frame){if(notifyChild){try{frame.contentWindow?.postMessage({channel:'mova-overview-map',type:'cancel'},'*');}catch(_){}}frame.remove();frame=null;}
    host.innerHTML='';host.hidden=true;host.style.height=mapExpanded?'510px':'300px';
    staticMap.hidden=false;footer.hidden=false;
    if(refresh)refreshMap(true).catch?.(()=>{});
    resizeWidget();
  }
  function directEditorAdapter(){
    return {
      getDeviceIds:()=>id?[id]:[],
      getLanguage:()=>((typeof H?.getLanguage==='function'&&H.getLanguage())||(overviewGerman?'de':'en')),
      getSettings:()=>{
        try{return typeof H?.getSettings==='function'?H.getSettings():{};}catch(_){return{};}
      },
      on:(name,fn)=>{
        try{return typeof H?.on==='function'?H.on(name,fn):undefined;}catch(_){return undefined;}
      },
      ready:()=>{},
      setHeight:setEditorHeight,
      finishEditor:()=>closeEditor({refresh:true,notifyChild:false}),
      api:(method,path,body)=>H.api(method,path,body||{})
    };
  }
  function initializeFrame(){
    if(!frame?.contentWindow||!id)return false;
    try{
      const child=frame.contentWindow;
      if(child.__movaOverviewDirectInitialized)return true;
      const init=child.initializeOverviewEditor;
      if(typeof init!=='function')return false;
      // Direct same-origin adapter: use the parent widget's real Homey session.
      // This avoids the nested iframe postMessage API proxy that can stall in
      // the Homey iOS WebView while keeping the exact single-map editor UI.
      child.__movaOverviewAutoEdit=true;
      child.__movaOverviewDirectInitialized=true;
      init(directEditorAdapter());
      return true;
    }catch(_){
      return false;
    }
  }
  function sendLegacyInit(){
    if(!frame?.contentWindow||!id)return;
    try{frame.contentWindow.postMessage({channel:'mova-overview-map',type:'init',deviceId:id,language:(typeof H?.getLanguage==='function'?H.getLanguage():navigator.language)},'*');}catch(_){}
  }
  function createEditor(){
    if(frame)return;
    frame=document.createElement('iframe');
    frame.className='map-editor-frame';
    frame.title=t('Edit mowing map','Mähkarte bearbeiten');
    frame.addEventListener('load',()=>{
      if(initializeFrame())return;
      // Defensive fallback only for runtimes that isolate the iframe origin.
      sendLegacyInit();
      setTimeout(()=>{if(!initializeFrame())sendLegacyInit();},120);
      setTimeout(()=>{if(!initializeFrame())sendLegacyInit();},500);
    });
    frame.src='map-editor.html?_='+Date.now();
    host.appendChild(frame);
  }
  window.addEventListener('message',async event=>{
    if(!frame||event.source!==frame.contentWindow||event.data?.channel!=='mova-overview-map')return;
    const message=event.data;
    if(message.type==='bridge-ready'){
      if(!initializeFrame())sendLegacyInit();
      return;
    }
    if(message.type==='done'){closeEditor();return;}
    if(message.type==='height'){setEditorHeight(message.height);return;}
    // Legacy API proxy is retained only as a compatibility fallback. In the
    // normal 1.2.16 path initializeFrame() injects H.api directly.
    if(message.type!=='api')return;
    const route=String(message.path||'').split('?')[0];
    const valid=(message.method==='GET'&&route==='/')||
      (message.method==='PUT'&&(route==='/garage-markers'||route==='/obstacle-rule'||route==='/maintenance-point-name'));
    const response={channel:'mova-overview-map',type:'result',requestId:message.requestId};
    try{
      if(!valid||!id||new URLSearchParams(String(message.path).split('?')[1]||'').get('deviceId')!==String(id))throw Error(t('Invalid map request','Ungültige Kartenanfrage'));
      response.result=await H.api(message.method,message.path,message.body||{});
    }catch(e){response.error=e?.message||String(e);}
    try{event.source?.postMessage(response,'*');}catch(_){}
  });
  button.onclick=()=>{
    if(mapEditing)return;
    if(statusPanel){statusPanel.hidden=true;statusButton?.setAttribute('aria-expanded','false');}
    mapEditing=true;
    clearTimeout(mapTimer);mapTimer=null;
    staticMap.hidden=true;footer.hidden=true;host.hidden=false;
    button.setAttribute('aria-expanded','true');
    setEditorHeight(Math.max(300,staticMap.clientHeight+30));
    createEditor();
    resizeWidget();
  };
  expandButton.onclick=()=>setExpanded(!mapExpanded);
  setExpanded(false);
  if(refreshBtn)refreshBtn.onclick=()=>refreshMap(true);
}
function onHomeyReady(Homey){if(typeof Homey.getLanguage==='function'&&Homey.getLanguage())overviewGerman=String(Homey.getLanguage()).toLowerCase().startsWith('de');window.MovaWidgetLanguage=overviewGerman?'de':'en';labels=makeOverviewLabels();localizeStaticOverview();H=Homey;id=H.getDeviceIds()[0];H.ready();setupMapEditor();resizeWidget();if(!id){showError(t('Please select a mower in the widget.','Bitte einen Mäher im Widget auswählen.'));return;}document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{if(busyAction)return;busyAction=b.dataset.action;if(b.dataset.action!=='pause')pauseFeedbackActive=false;b.disabled=true;markButtonAction(b.dataset.action,'pending');clearError();if(b.dataset.action==='recovery_dock_check'){if($('dockReadout'))$('dockReadout').textContent=t('Checking…','Prüfung läuft …');if($('dockCheckResult'))$('dockCheckResult').textContent=t('Reading two native station frames','Zwei native Stationsmeldungen werden abgefragt');}setActionStatus(t('Checking and sending…','Prüfung läuft – Rückmeldung wird abgewartet …'));try{let supervised=false;
    if(/^external_maintenance_point_[1-5]$/.test(b.dataset.action)) {
      // An explicit tap confirms the target; no unreliable modal dialog.
      // Server-side native station, gate and mission interlocks still apply.
      supervised=true;
    }
    // Homey embedded iOS widgets may resolve window.confirm() as false without
    // displaying a dialog. That turned manual takeover and visual reports
    // into a silent "Abgebrochen" BEFORE the request reached the engine.
    // These are individually labelled, explicitly tapped on-screen actions;
    // the backend still enforces native/sensor/geometry interlocks for motors.
    if (b.dataset.action==='recovery_begin_manual'
        || /^recovery_direct_(dock|point_[1-5])$/.test(b.dataset.action)
        || /^external_maintenance_point_[1-5]$/.test(b.dataset.action)
        || ['recovery_quick_return','recovery_quick_waypoint',
            'context_return_checked','context_maintenance_checked',
            'recovery_confirm_open','recovery_takeover','recovery_rearm',
            'recovery_rearm_quick','recovery_restore_normal',
            'gate_open','gate_close','gate_stop','recovery_gate_revoke'].includes(b.dataset.action)
        || (b.dataset.action==='return' && rLastManualRecovery)) supervised=true;
    const visualToggle=['recovery_operator_dock','recovery_position_outside','recovery_confirm_closed','gate_visual_open','gate_visual_closed','dock_visual_docked'].includes(b.dataset.action);
    if(visualToggle || b.dataset.action==='recovery_pause_safely' || /^recovery_position_(inside|unknown)$/.test(b.dataset.action))supervised=true; // button press = explicit sight statement
    const revoke=visualToggle && b.getAttribute('aria-pressed')==='true';
    const pointIndex=b.dataset.action==='recovery_quick_waypoint'?
      Number($('recoveryPointSelect')?.value):undefined;
    // OPEN is a reversible visual statement. A second tap retracts the
    // statement; it must NOT issue another OPEN pulse or fake a CLOSED sensor.
    const effectiveAction=b.dataset.action==='recovery_confirm_open'
      && b.getAttribute('aria-pressed')==='true' ? 'recovery_gate_revoke' : b.dataset.action;
    const response=await api('POST','/command',{action:effectiveAction,supervised,revoke,pointIndex});
    if(response?.accepted===false)throw Error(t('Device did not confirm the request.','Der Vorgang wurde nicht bestätigt.'));
    if(['recovery_rearm','recovery_rearm_quick','recovery_restore_normal'].includes(b.dataset.action))lastRecoveryFeedbackAt=Date.now();
    if(b.dataset.action==='recovery_dock_check'){
      const success=response?.verified===true;
      $('dockReadout').textContent=success?t('Dock verified (2/2) ✓','Angedockt bestätigt (2/2) ✓'):t('Dock not confirmed','Andocken nicht bestätigt');
      $('dockCheckResult').textContent=success
        ?t('Direct native check completed. No movement.','Native Doppelprüfung abgeschlossen. Keine Bewegung.')
        :t('Check unsuccessful: ','Prüfung fehlgeschlagen: ')+String(response?.result||'unknown');
    }
    const r=await refresh();const outcome=b.dataset.action==='recovery_dock_check'
      ? {state:response?.verified?'confirmed':'failed',text:response?.verified
        ?t('Dock verified (2/2) ✓ · read-only','Angedockt bestätigt (2/2) ✓ · nur Leseprüfung')
        :t('Dock not verified: ','Andocken nicht bestätigt: ')+String(response?.result||'unknown')}
      : (['recovery_quick_return','recovery_quick_waypoint','recovery_direct_dock'].includes(b.dataset.action) || (b.dataset.action==='return' && rLastManualRecovery) || /^recovery_direct_point_[1-5]$/.test(b.dataset.action))
        ? {state:'requested',text:t('Native command requested; physical arrival still unverified','Nativer Auftrag angefordert; physische Ankunft noch nicht bestätigt')}
        :actionOutcome(effectiveAction,response,r);
    markButtonAction(b.dataset.action,outcome.state);
    if (['return','recovery_quick_return','recovery_direct_dock','recovery_return','context_return_checked'].includes(b.dataset.action)) {
      pendingNavigationFeedback={kind:'return',at:Date.now()};
    }
    if(b.dataset.action==='pause')pauseFeedbackActive=true;if(['recovery_rearm','recovery_rearm_quick','recovery_restore_normal'].includes(b.dataset.action))lastRecoveryFeedbackAt=Date.now();setActionStatus(b.dataset.action==='pause' ? (nativePauseStateText(r)||t('Checking mower status…','Mäherstatus wird geprüft …')) : outcome.text);
    reconcileNavigationFeedback(r);
  }catch(e){if(b.dataset.action==='pause')pauseFeedbackActive=false;markButtonAction(b.dataset.action,'failed');if(b.dataset.action==='recovery_dock_check'){if($('dockReadout'))$('dockReadout').textContent=t('Dock check failed','Andockprüfung fehlgeschlagen');if($('dockCheckResult'))$('dockCheckResult').textContent=e?.message||String(e);}setActionStatus(t('Action failed: ','Aktion abgelehnt: ')+(e?.message||String(e)),true);showError(e);}finally{busyAction=null;b.disabled=false;}});refresh();refreshMap();}
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);clearTimeout(mapTimer);}else{refresh();refreshMap();}});window.addEventListener('pagehide',()=>{clearTimeout(timer);clearTimeout(mapTimer);});if(window.IntersectionObserver)new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;if(inView&&H){refresh();refreshMap();}},{threshold:0.02}).observe(document.body);if(window.ResizeObserver)new ResizeObserver(resizeWidget).observe(document.body);document.querySelectorAll?.('details')?.forEach(el=>el.addEventListener?.('toggle',resizeWidgetAfterMapLayout));window.addEventListener('resize',resizeWidget);document.addEventListener('toggle',resizeWidget,true);

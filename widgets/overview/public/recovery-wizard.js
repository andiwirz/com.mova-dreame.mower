/* Guided, explicitly supervised recovery. Human statements are not native telemetry. */
(function(global){
'use strict';
const L=(en,de)=>String(window.MovaWidgetLanguage||(typeof Homey!=='undefined'&&Homey.getLanguage?.())||navigator.language||'en').toLowerCase().startsWith('de')?de:en;
const byId=id=>document.getElementById(id);
const wizard={active:false,step:'dock',answers:{},evidence:{},snapshot:null,busy:false,history:[],message:'',messageError:false};
const answers={
 dock:[['yes',L('Yes, properly docked (battery may be full)','Ja, korrekt angedockt (Akku darf voll sein)')],['near',L('Not seated properly / position uncertain','Nicht richtig angedockt / Position unklar')],['away',L('No, outside the station','Nein, außerhalb der Station')],['unknown',L('I am not sure','Ich bin unsicher')]],
 sensor:[['yes',L('Yes, sensor online','Ja, Sensor online')],['no',L('No, offline','Nein, offline')],['unknown',L('I am not sure','Ich bin unsicher')]],
 gate_action:[['pulse',L('Try ONE supervised gate opening pulse','EINEN beaufsichtigten Tor-Öffnungsimpuls versuchen')],['hand',L('I will open the gate manually and check it','Ich öffne das Tor selbst und prüfe es')],['cannot',L('Opening is currently not possible','Öffnen ist gerade nicht möglich')]],
 gate:[['yes',L('YES – I can SEE the gate fully open and the entire passage is clear','JA – ich SEHE: Tor vollständig offen und Durchfahrt frei')],['no',L('No, gate closed / not fully open','Nein, Tor geschlossen / nicht vollständig offen')],['unknown',L('Cannot verify safely','Kann ich nicht sicher prüfen')]],
 mode:[['auto',L('Restore full automatic operation','Automatik wiederherstellen')],['manual',L('Take manual control','Manuelle Kontrolle übernehmen')],['pause',L('Only pause automation – no mower movement','Nur Automatik pausieren – ohne Mäherfahrt')]]
};
const steps=['dock','sensor','gate','gate_action','mode'];
function putMessage(message,error=false){wizard.message=message;wizard.messageError=!!error;const el=byId('recoveryWizardMessage');if(!el)return;el.textContent=message;el.classList.toggle('error-state',!!error);}
function stepText(){
 switch(wizard.step){
 case 'dock':return [L('1 · Where is the mower?','1 · Wo steht der Mäher?'),L('Please inspect it physically. “Docked” on the Homey tile is not proof of the native charging contacts. If you select YES, I will read the native dock contact twice without moving anything.','Bitte vor Ort nachsehen. „Angedockt“ in der Homey-Kachel beweist keinen Ladekontakt. Bei JA prüfe ich den nativen Stationskontakt zweimal – ohne Bewegung.')];
 case 'sensor':return [L(wizard.evidence.dock?.verified===true?'2/3 · Is the garage gate sensor online?':'2/4 · Is the garage gate sensor online?',wizard.evidence.dock?.verified===true?'2/3 · Ist der Garagentorsensor online?':'2/4 · Ist der Garagentorsensor online?'),L('Your answer is compared with the actual Homey sensor and contact state; it will never override the sensor.','Deine Antwort wird mit dem tatsächlichen Homey-Sensorstatus verglichen und überschreibt den Sensor nicht.')];
 case 'gate':return [L('3/4 · Is the gate completely open and the passage clear?','3/4 · Ist das Tor vollständig offen und die Durchfahrt frei?'),L('Only answer YES after looking at the gate and doorway yourself. This is a visual declaration for supervised manual rescue, NOT a forged door sensor.','JA nur nach eigener Sichtprüfung von Tor und Durchfahrt wählen. Das ist eine Sichtbestätigung für die beaufsichtigte manuelle Bergung – KEINE gefälschte Sensormeldung.')];
 case 'gate_action':return [L('Gate is not verified open – what next?','Tor ist nicht offen bestätigt – wie weiter?'),L('For a trapped mower, a single supervised OPEN command may be attempted, but will never release a mower drive. Otherwise, open the gate manually. Confirm OPEN only after a physical visual check.','Für einen eingeschlossenen Mäher kann EIN beaufsichtigter Öffnungsimpuls versucht werden – dadurch startet keine Mäherfahrt. Alternativ das Tor von Hand öffnen. OFFEN erst nach tatsächlicher Sichtprüfung bestätigen.')];
 case 'mode':return [L(wizard.evidence.dock?.verified===true?'3/3 · How would you like to regain control?':'4/4 · How would you like to regain control?',wizard.evidence.dock?.verified===true?'3/3 · Wie möchtest du die Kontrolle übernehmen?':'4/4 · Wie möchtest du die Kontrolle übernehmen?'),L('Automatic operation needs separate trustworthy technical evidence. Manual operation leaves gate responsibility with you. A pending emergency lock is not bypassed silently.','Für den Automatikbetrieb sind zusätzliche technische Nachweise erforderlich. Bei manueller Bedienung liegt die Verantwortung für das Tor bei dir. Eine Notfallsperre wird nicht unbemerkt umgangen.')];
 case 'done':return [L('Recovery result','Ergebnis der Wiederherstellung'),L('You can restart the dialogue at any time if the situation changes.','Wenn sich der Zustand ändert, kannst du den Dialog jederzeit neu starten.')];
 default:return ['',''];
 }
}
function progressText(){
 const s=wizard.snapshot||{}, e=wizard.evidence||{}, list=[];
 if(wizard.answers.dock){
   const dock=e.dock;
   list.push(L('Mower (operator)','Mäher (Sichtangabe)')+': '+(answers.dock.find(x=>x[0]===wizard.answers.dock)||[])[1]);
   if(dock)list.push(L('Native dock test','Native Andockprüfung')+': '+(dock.verified?L('VERIFIED (two reads)','BESTÄTIGT (zwei Abfragen)'):L('NOT VERIFIED','NICHT BESTÄTIGT'))+(dock.reason?' · '+dock.reason:''));
 }
 if(wizard.answers.sensor){
   list.push(L('Sensor (operator)','Sensor (Sichtangabe)')+': '+wizard.answers.sensor.toUpperCase());
   if(e.sensor)list.push('Homey: '+String(e.sensor.status||'?')+' · '+L('contact','Kontakt')+'='+String(e.sensor.contact||'?')+(e.sensor.ageMs==null?'':' · '+L('last contact','letzter Kontakt')+' '+Math.round(e.sensor.ageMs/1000)+'s'));
 }
 if(wizard.answers.gate){list.push(L('Gate (operator)','Tor (Sichtangabe)')+': '+wizard.answers.gate.toUpperCase()+(s.manualRecovery?' · '+(s.recoveryGateConfirmed?L('manual confirmation accepted','Sichtbestätigung angenommen'):L('no valid OPEN confirmation','kein gültiger OFFEN-Nachweis')):''));}
 return list.join('\n');
}
async function serverCommand(action,supervised=false){const resp=await wizard.api('POST','/command',{action,supervised});if(resp?.accepted===false)throw Error(L('Not accepted','Nicht angenommen'));return resp;}
async function getFresh(){const r=await wizard.api('GET','/overview');wizard.snapshot=r;return r;}
function render(){
 const section=byId('recoveryWizardSection');if(!section)return;
 const panel=byId('recoveryWizardPanel'),open=byId('recoveryWizardStart'),back=byId('recoveryWizardBack'),reset=byId('recoveryWizardReset');
 panel.hidden=!wizard.active;
 open.textContent=wizard.active?L('Hide assistant','Assistent schließen'):L('Start guided recovery','Wiederherstellung im Dialog starten');
 back.hidden=!wizard.active||wizard.step==='dock'||wizard.step==='done';reset.hidden=!wizard.active;
 if(!wizard.active){if(wizard.snapshot?.manualRecovery)byId('recoveryWizardTeaser').textContent=L('Emergency active – guided recovery is available.','Notfallsperre aktiv – geführte Wiederherstellung verfügbar.');else if(wizard.snapshot?.garagePaused)byId('recoveryWizardTeaser').textContent=L('Garage automation paused – you can choose your next steps here.','Garagenautomatik pausiert – hier kannst du den weiteren Weg wählen.');else byId('recoveryWizardTeaser').textContent=L('If something is unclear, I will ask one question at a time and check sensor and docking data.','Wenn etwas unklar ist, frage ich Schritt für Schritt und prüfe Sensor- und Andockdaten.');return;}
 const [heading,description]=stepText();byId('recoveryWizardHeading').textContent=heading;byId('recoveryWizardExplanation').textContent=description;
 const progress=byId('recoveryWizardProgress');progress.textContent=progressText();progress.hidden=!progress.textContent;
 const choices=byId('recoveryWizardChoices');choices.replaceChildren();
 for(const [value,label] of (answers[wizard.step]||[])){
   const b=document.createElement('button');b.type='button';b.textContent=label;b.disabled=wizard.busy;b.dataset.wizardChoice=value;
   if(wizard.answers[wizard.step]===value)b.classList.add('selected');
   b.onclick=()=>answer(value);choices.appendChild(b);
 }
 const status=byId('recoveryWizardMessage');status.textContent=wizard.message;status.classList.toggle('error-state',wizard.messageError);
 if(wizard.busy)status.textContent=L('Reading Homey / checking…','Homey-Abfrage läuft – bitte warten …');
 try{global.requestAnimationFrame?.(()=>global.resizeWidget?.());}catch(_){}
}
async function answer(value){
 if(wizard.busy)return;
 const step=wizard.step;wizard.busy=true;wizard.message='';wizard.messageError=false;render();
 try{
  const snap=await getFresh();wizard.answers[step]=value;
  if(step==='dock'){
    if(value==='yes'){
      if(snap.manualRecovery)await serverCommand('recovery_operator_dock',true);
      const result=await serverCommand('recovery_dock_check');
      wizard.evidence.dock={verified:result.verified===true,reason:String(result.result||'unknown')};
      putMessage(result.verified
       ? L('Native station confirmed twice. Charging is not required when the battery is full. No mower movement.','Station durch zwei native Abfragen bestätigt. Aktives Laden ist nicht notwendig. Keine Mäherbewegung.')
       : L('Visual declaration accepted, but native docking NOT confirmed. No automatic movement will be released; the manual recovery path remains available.','Deine Sichtangabe ist berücksichtigt, aber natives Andocken NICHT bestätigt. Keine automatische Bewegungsfreigabe; der manuelle Weg bleibt verfügbar.'),!result.verified);
    }else{wizard.evidence.dock=null;putMessage(value==='near'?L('Partially docked is NOT charging proof. Use supervised manual control to recover the mower.','Ist die Position unklar, den Mäher unter manueller Aufsicht richtig andocken.'):L('Docking can be checked again after manual correction.','Die physische Andockprüfung kann später wiederholt werden.'));}
    wizard.step='sensor';
  }else if(step==='sensor'){
    const result=await serverCommand('recovery_sensor_check');
    wizard.evidence.sensor={status:result.status,contact:result.contact,ageMs:result.ageMs};
    const mismatch=(value==='yes'&&result.status!=='online')||(value==='no'&&result.status==='online');
    putMessage(mismatch?L('Your answer differs from the Homey sensor report. Please inspect the sensor; its technical status has NOT been changed.','Deine Antwort widerspricht der Homey-Sensormeldung. Bitte Sensor prüfen; sein technischer Status wurde NICHT verändert.'):L('Sensor read complete. Your answer and Homey report are shown separately.','Sensorprüfung abgeschlossen. Deine Angabe und der Homey-Status werden getrennt angezeigt.'),mismatch);
    // A mower already confirmed at the station does not need an OPEN gate
    // just to restore automatic status. Door supervision remains for travel.
    wizard.step=wizard.answers.dock==='yes' && wizard.evidence.dock?.verified===true?'mode':'gate';
  }else if(step==='gate'){
    if(value==='yes'&&snap.manualRecovery){
      try{await serverCommand('recovery_confirm_open',true);const updated=await getFresh();putMessage(updated.recoveryGateConfirmed?L('Your supervised OPEN declaration was saved (not a sensor reading).','Deine beaufsichtigte OFFEN-Sichtbestätigung wurde gespeichert (keine Sensormeldung).'):L('Gate confirmation still unverified.','Torbestätigung weiterhin nicht verifiziert.'),!updated.recoveryGateConfirmed);}catch(err){putMessage(L('OPEN statement not accepted. A recent CLOSED contact or ongoing gate movement may contradict it. Check the actual gate: ','OFFEN-Angabe nicht angenommen. Ein frischer GESCHLOSSEN-Kontakt oder eine Torbewegung kann widersprechen. Tor prüfen: ')+(err?.message||err),true);}
    }else if(value!=='yes'&&snap.manualRecovery){await serverCommand('recovery_gate_revoke');putMessage(L('No OPEN release is retained. Do not move the mower through the passage.','Keine OFFEN-Freigabe gespeichert. Mäher nicht durch die Toröffnung fahren.'));}
    else putMessage(value==='yes'?L('Visual gate status recorded; this does not overwrite the sensor.','Sichtstatus des Tors erfasst; die Sensormeldung bleibt unverändert.'):L('Gate not confirmed open. Manual driving through the gate must wait.','Tor nicht offen bestätigt. Manuelle Fahrt durch das Tor muss warten.'));
    wizard.step=value==='yes'?'mode':'gate_action';
  }else if(step==='gate_action'){
    if(value==='pulse'){
      await serverCommand('gate_open',true);
      putMessage(L('ONE gate opening command accepted. WAIT for the real end position and physically inspect the passage before confirming.','EIN Öffnungsbefehl angenommen. Auf die tatsächliche Endlage warten, Durchfahrt ansehen und erst danach OFFEN bestätigen.'));
      wizard.step='gate';
    }else if(value==='hand'){
      putMessage(L('Open the gate yourself. Only confirm OPEN after a direct visual inspection.','Tor selbst öffnen und erst nach eigener Sichtprüfung OFFEN bestätigen.'));wizard.step='gate';
    }else{
      putMessage(L('No door opening released. Choose pause-only until the doorway can be made safe.','Keine Toröffnung freigegeben. Bis zur Sicherung der Durchfahrt nur „Automatik pausieren“ wählen.'),true);wizard.step='mode';
    }
  }else if(step==='mode'){
    // Entering manual mode is a non-moving UI switch. Passage checks belong
    // to EACH later mower/gate command, never to access to rescue controls.
    if(value==='pause'){
      if(!snap.garagePaused)await serverCommand('garage_pause');
      const after=await getFresh();
      putMessage(after.garagePaused?L('Manual/OFF preference active. The emergency latch, if any, stays active. Before any mower movement, verify that the entire doorway is open.','Manuell/AUS ist aktiv. Eine Notfallsperre bleibt bestehen. Vor JEGLICHER Mäherfahrt muss die gesamte Durchfahrt offen sein.'):L('Pause has not been confirmed.','Pausierung nicht bestätigt.'),!after.garagePaused);
    }else if(value==='manual'){
      await serverCommand('recovery_begin_manual',true);
      const after=await getFresh();
      putMessage(after.garagePaused&&after.manualOperatorFree?L('Manual control available. No motor command sent; inspect the doorway before individual movement.','Manuelle Bedienung bereit. Kein Fahrbefehl gesendet; vor einzelnen Bewegungen die Durchfahrt prüfen.'):L('Manual takeover could not be confirmed.','Manuelle Übernahme konnte nicht bestätigt werden.'),!(after.garagePaused&&after.manualOperatorFree));
    }else{
      if(snap.manualRecovery){
        if(!snap.garageEnabled)throw Error(L('Garage Mode is disabled in the device settings. Enable Garage Mode there first; the manual pause and guided help remain available meanwhile.','Der Garagenmodus ist in den Geräteeinstellungen ausgeschaltet. Bitte dort zuerst einschalten; manuelle Pause und Hilfe bleiben jederzeit verfügbar.'));
        if(wizard.answers.sensor!=='yes')throw Error(L('You have not confirmed the sensor online. Verify the sensor before restoring automatic operation.','Du hast den Sensor nicht als online bestätigt. Bitte vor Freigabe der Automatik den Sensor prüfen.'));
        if(!(wizard.evidence.dock?.verified===true || snap.manualOperatorPosition==='outside'))throw Error(L('Confirm the mower is docked OR safely outside before requesting native rearm verification.','Mäher zuerst als angedockt ODER sicher draußen bestätigen. Danach erfolgt die native Freigabeprüfung.'));
        if(snap.sensor!=='online')throw Error(L('Homey reports the gate sensor offline/unknown. Please restore sensor reliability first, or stay manual.','Homey meldet Torsensor offline/unbekannt. Bitte zuerst Sensorverbindung herstellen oder manuell bleiben.'));
        // Fresh, independent native readback is repeated by rearm itself.
        await serverCommand('recovery_restore_normal',true);
      }else if(snap.garagePaused){await serverCommand('garage_pause');}
      const after=await getFresh();
      if(after.manualRecovery||after.garagePaused||!after.garageEnabled)throw Error(L('Automation could not be fully restored. Review emergency and garage settings; no movement was requested.','Automatik nicht vollständig wiederhergestellt. Notfallsperre und Garageneinstellungen prüfen; keine Bewegung wurde ausgelöst.'));
      putMessage(L('Automatic garage control restored ✓. No mower or gate command was triggered by the assistant.','Garagenautomatik wiederhergestellt ✓. Der Assistent hat keinen Mäher- oder Torfahrbefehl ausgelöst.'));
      wizard.evidence.dock={verified:true,reason:'confirmed'};
    }
    wizard.step='done';
  }
 }catch(error){wizard.step=step;putMessage(L('Not completed: ','Nicht abgeschlossen: ')+(error?.message||String(error)),true);}
 finally{wizard.busy=false;render();}
}
function init(api){wizard.api=api;byId('recoveryWizardStart')?.addEventListener('click',()=>{wizard.active=!wizard.active;if(wizard.active){wizard.step='dock';wizard.answers={};wizard.evidence={};wizard.message='';}render();});byId('recoveryWizardReset')?.addEventListener('click',()=>{wizard.step='dock';wizard.answers={};wizard.evidence={};wizard.message='';render();});byId('recoveryWizardBack')?.addEventListener('click',()=>{const i=steps.indexOf(wizard.step);if(i>0){wizard.step=(wizard.step==='mode'&&wizard.answers.dock==='yes')?'sensor':((wizard.step==='mode'&&!wizard.answers.gate_action)?'gate':steps[i-1]);wizard.message='';render();}});render();}
function update(snapshot){wizard.snapshot=snapshot;if(wizard.active&&!wizard.busy)render();else if(!wizard.active)render();}
global.MovaRecoveryWizard={init,update,_debug:()=>wizard};
})(window);

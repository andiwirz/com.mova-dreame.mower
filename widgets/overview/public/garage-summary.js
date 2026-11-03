/* Read-only garage overview. Never authorize motion from this presentation layer. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MovaGarageSummary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const onTrip = new Set(['mowing', 'paused', 'returning', 'maintenance_enroute', 'garage_departing', 'garage_exiting']);
  const atHome = new Set(['garage_home', 'charging', 'docked']);
  function forOverview(s = {}) {
    const status=String(s.status||'').toLowerCase();
    const safety=String(s.safety||'').toLowerCase();
    const sensor=String(s.sensor||'').toLowerCase();
    const door=String(s.door||'').toLowerCase();
    const age=Number(s.recoveryNativeAgeMs);
    const binaryFresh=s.recoveryNativeAgeMs!=null && s.recoveryNativeAgeMs!=='' &&
      Number.isFinite(age) && age>=0 && age<=30000;
    const nativeHome=binaryFresh && s.recoveryNativeDock==='IN_STATION' && s.recoveryNativeUndock===0;
    const nativeOutside=binaryFresh && (s.recoveryNativeDock==='OUT_OF_STATION' || s.recoveryNativeUndock===1);
    const homeFromStatus=atHome.has(status);
    const visualHome=!!s.visualDock || (s.manualRecovery===true && Number(s.recoveryOperatorDockAt||0)>0);
    const visuallyClosed=s.visualGate?.state==='closed';
    const visuallyOpen=s.visualGate?.state==='open';

    // Prefer the gate controller's last REAL sensor contact. Its public Homey
    // capability can be unknown while this retained real contact is correct.
    const realState=['closed','open'].includes(String(s.recoveryGateLastRealContact))
      ? String(s.recoveryGateLastRealContact) : null;
    const contactCap=['closed','open'].includes(String(s.sensorContact))
      ? String(s.sensorContact) : null;
    const realAge=Number(s.sensorContactAgeMs);
    const internalContactValid=realState && s.sensorContactAgeMs!=null && s.sensorContactAgeMs!==''
      && Number.isFinite(realAge) && realAge>=0 && realAge<=24*60*60*1000;
    const bestContact=internalContactValid ? realState : contactCap;
    const physicalGate=sensor==='online' && s.doorEstimated!==true &&
      (door==='closed'||door==='open') && bestContact===door;
    const visualState=visuallyClosed?'closed':visuallyOpen?'open':null;
    const visualConflict=!!visualState && !!bestContact &&
      visualState!==bestContact && sensor==='online';

    let state='active',titleDe='Garagenautomatik aktiv',titleEn='Garage automation active';
    if(s.manualRecovery===true){state='emergency';titleDe='Notfall · manuelle Kontrolle';titleEn='Emergency · manual control';}
    else if(s.garagePaused===true || s.garageEnabled===false){state='paused';titleDe='Garagenautomatik pausiert';titleEn='Garage automation paused';}
    else if(['warning','blocked','emergency'].includes(safety)||s.doorStopped===true){state='attention';titleDe='Garagenstatus prüfen';titleEn='Check garage status';}

    let mowerDe='Mäher: Status unklar',mowerEn='Mower: status unknown';
    if(nativeHome){mowerDe='Mäher: nativ angedockt';mowerEn='Mower: docked (native)';}
    else if(nativeOutside){
      mowerDe=homeFromStatus?'Mäher: Stationsstatus widersprüchlich':'Mäher: außerhalb der Station';
      mowerEn=homeFromStatus?'Mower: station status inconsistent':'Mower: outside station';
      if(visualHome){mowerDe+=' · Sichtprüfung: Zuhause';mowerEn+=' · visual check: at home';}
    } else if(visualHome){mowerDe='Mäher: Zuhause (Sichtprüfung)';mowerEn='Mower: at home (visual check)';}
    else if(homeFromStatus){mowerDe='Mäher: Zuhause (Mäherstatus)';mowerEn='Mower: home (mower status)';}
    else if(onTrip.has(status)){mowerDe='Mäher: unterwegs';mowerEn='Mower: away';}
    const mowerReliable=nativeHome;
    const mowerNeedsVisual=homeFromStatus && !nativeHome && !visualHome;

    let gateDe='Tor: Endlage unbestätigt',gateEn='Gate: end position unverified';
    if(visualConflict){
      gateDe='Tor: Sensor und Sichtprüfung widersprechen sich';
      gateEn='Gate: sensor and visual check disagree';
    }else if(physicalGate){
      // Last observed real contact, not a promise of a fresh continuous sensor read.
      const old=internalContactValid && realAge>30*60*1000;
      gateDe=door==='closed'?(old?'Tor: ZU (letzter Sensorkontakt)':'Tor: ZU (Sensor)'):
        (old?'Tor: OFFEN (letzter Sensorkontakt)':'Tor: OFFEN (Sensor)');
      gateEn=door==='closed'?(old?'Gate: CLOSED (last sensor contact)':'Gate: CLOSED (sensor)'):
        (old?'Gate: OPEN (last sensor contact)':'Gate: OPEN (sensor)');
    }else if(visualState){
      gateDe=visualState==='closed'?'Tor: ZU (Sichtprüfung)':'Tor: OFFEN (Sichtprüfung)';
      gateEn=visualState==='closed'?'Gate: CLOSED (visual check)':'Gate: OPEN (visual check)';
    }else if(sensor==='offline'){
      gateDe='Tor: Sensor offline';gateEn='Gate: sensor offline';
    }else if(door==='closed'||door==='open'){
      if(bestContact && bestContact!==door && sensor==='online'){
        gateDe='Tor: Sensor und Torstatus widersprechen sich';
        gateEn='Gate: sensor and door status disagree';
      }else{
      // Door state is useful but must not be promoted to sensor proof.
      gateDe=door==='closed'?'Tor: ZU (Status, unbestätigt)':'Tor: OFFEN (Status, unbestätigt)';
      gateEn=door==='closed'?'Gate: CLOSED (status, unverified)':'Gate: OPEN (status, unverified)';
      }
    }
    const gateReliable=!!physicalGate&&!visualConflict;
    const gateNeedsVisual=!gateReliable && (['closed','open','unknown'].includes(door)||sensor==='offline');
    const showVisual=s.manualRecovery===true || s.garagePaused===true || s.garageEnabled===false;
    return {state,titleDe,titleEn,detailDe:mowerDe+' · '+gateDe,detailEn:mowerEn+' · '+gateEn,
      mowerReliable,gateReliable,mowerNeedsVisual,gateNeedsVisual,showVisual,visualConflict};
  }
  return {forOverview};
});

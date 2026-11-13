'use strict';

// Isolated CORE waypoint observer + map presentation. No movement commands.
// An unindexed original-app TASK109 may be associated only with the one named,
// still-unconfirmed P2..P5 candidate; arrival MUST independently validate P1
// distinction, firmware code 75, two native position readbacks and map identity.
const {
  NativeAdditionalMaintenanceEvidence, taskTarget, taskAnyTarget, STORE_KEY, LEARNING_WINDOW_MS,
} = require('./NativeAdditionalMaintenanceEvidence');
const { knownLearnedPoint, mapRevision } = require('./NativeAdditionalMaintenanceEvidence');
const { MaintenanceLearningNotice } = require('./MaintenanceLearningNotice');

const valid = p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
const dist = (a,b) => Math.hypot(Number(a.x)-Number(b.x),Number(a.y)-Number(b.y));
const DEFAULT_LABEL = index => ({en:`Maintenance point ${index}`,de:`Wartungspunkt ${index}`});
const POINT_NAMES_STORE = 'maintenance_point_names_v1';
const nameKey = index => `maintenance_point_${index}_name`;

class MaintenancePointCoordinator extends NativeAdditionalMaintenanceEvidence {
  constructor(device, log = () => {}) {
    super(device, log);
    this.listeners = new Set();
    this.inferred = null;
    this.operatorAssociation = null;
    this.revisionCache=null;
    this.names = {};
    this._lastConfirmedTravel = null;
    this.feedback = new MaintenanceLearningNotice(device, log);
  }
  async load() {
    this.stored = await Promise.resolve(this.device.getStoreValue(STORE_KEY)).catch(()=>null) || {};
    await this.reloadNames();
  }
  _pointName(index) {
    const key=nameKey(index);
    return String(this.names[key] || '').trim();
  }
  async reloadNames() {
    const stored = await Promise.resolve(this.device.getStoreValue(POINT_NAMES_STORE)).catch(()=>null);
    this.names=Object.fromEntries([2,3,4,5].map(index => {
      const key=nameKey(index);
      return [key,String(stored?.[key] || '').trim()];
    }));
    await this.syncButtons();
  }
  _names(index) {
    const name=this._pointName(index);
    return name ? {en:name,de:name} : DEFAULT_LABEL(index);
  }
  async observeStatus(code, fault = 0) {
    if (this.pending && Date.now() - this.pending.at > LEARNING_WINDOW_MS) {
      const expired = this.pending;
      this.pending = null;
      this.inferred = null;
      this.operatorAssociation = null;
      await this.feedback.show('expired', expired.index);
      this.log(`[maintenance-coordinator] P${expired.index} learning expired without confirmed native evidence`);
      return true; // Avoid misclassifying a late status as a P1 arrival.
    }
    const pending = this.pending;
    const handled = await super.observeStatus(code,fault);
    if (pending && this.pending && Number(code) !== 75 && Number(fault) === 75) {
      this.feedback.show('uncertain', pending.index, 'fault=75 is not native status=75').catch(()=>{});
    }
    if (pending && !this.pending) {
      this.stored = await Promise.resolve(this.device.getStoreValue(STORE_KEY)).catch(()=>null) || {};
      if (this.inferred?.index === pending.index && this.inferred?.mapIndex === pending.mapIndex) {
        const byMap=this.stored?.[String(pending.mapIndex)] || {};
        const point=byMap[String(pending.index)];
        if(point && ['native_task109_code75_stable','native_indexed_map_position_stable'].includes(point.source)) {
          point.source=this.inferred.operatorConfirmed
            ? (point.source==='native_indexed_map_position_stable'
              ? 'operator_associated_native_indexed_map_position_stable'
              : 'operator_associated_native_task109_code75_stable')
            : 'candidate_unindexed_native_task109_code75_stable';
          await this.device.setStoreValue(STORE_KEY,this.stored);
        }
        this.inferred=null;
      }
      await this.syncButtons();
      // Mirror Core's confirmed additional-marker merge into the live map.
      // Never overwrite the primary P1 marker or the mowing-zone geometry.
      // Publish the FIRST successfully learned point immediately, including when
      // there was no previous P2-P5 marker. Widget and map API both receive the
      // same snapshot; a second visit must never be needed to make it appear.
      const marks = await this.visiblePoints();
      if (this.device._cachedMapData) {
        this.device._cachedMapData.nativeMaintenancePoints = marks.filter(p=>p.confirmed).map(p=>({
          index:p.index,x:p.x,y:p.y,source:'native_maintenance_confirmed'
        }));
        this.device._cachedMapData.maintenancePoints = marks;
      }
      const proof = this.stored?.[String(pending.mapIndex)]?.[String(pending.index)];
      const isVerified = !!(proof && knownLearnedPoint(this.stored,pending.index,pending.mapIndex,proof.mapHash));
      const isObserved = proof?.source === 'operator_observed_native_task109_idle_stable';
      const visibleNow = marks.some(p => p.index === pending.index && p.confirmed);
      if (isVerified && visibleNow) {
        this.log(`[maintenance-map] P${pending.index} visible for map=${pending.mapIndex} x=${Math.round(Number(proof.x))} y=${Math.round(Number(proof.y))}; widget will read stored marker on next poll`);
        this._lastConfirmedTravel = { index: pending.index, at: Date.now() };
        this.log(`[maintenance-coordinator] first-arrival P${pending.index} confirmed and published to map (one OEM trip sufficient)`);
      } else if (isVerified) {
        this.log(`[maintenance-coordinator] P${pending.index} saved, but marker not visible; checking map revision/visibility`);
      }
      await this.feedback.show(isVerified && visibleNow ? 'confirmed' : isObserved ? 'positionObserved' : 'uncertain',pending.index);
      await this.device._garageSafety?.refreshTileStatus?.('native maintenance learning completion').catch(() => {});
      this.device._scheduleMapCameraImageUpdate?.();
    }
    return handled;
  }
  observeTask(task,mapIndex) {
    // A different executed OEM task invalidates the currently observed
    // maintenance trip. Never attach its later idle/position to P2..P5.
    if (this.pending && task?.exe === true && Number.isFinite(Number(task.o))
        && Number(task.o) !== 109) {
      const cancelled = this.pending.index;
      this.pending = null;
      this.inferred = null;
      this.operatorAssociation = null;
      this._lastConfirmedTravel = null;
      this.log(`[maintenance-coordinator] P${cancelled} pairing cancelled by another native task; no position stored`);
      this.feedback.show('uncertain', cancelled).catch(()=>{});
    }
    if (Number(task?.o)!==109 || task.exe!==true) return super.observeTask(task,mapIndex);
    this._lastConfirmedTravel = null;
    // Manufacturer explicitly naming P1 (or another point) must never be
    // rebound to the operator-selected P2..P5. The previous parser only
    // recognized P2..P5 and could therefore mistake explicit P1 for missing.
    const anyExplicit = taskAnyTarget(task);
    if (anyExplicit === 1 || (anyExplicit && this.operatorAssociation
        && anyExplicit !== this.operatorAssociation.index)) {
      const cancelled=this.operatorAssociation?.index;
      this.operatorAssociation=null; this.inferred=null; this.pending=null;
      this.log(`[maintenance-coordinator] explicit OEM P${anyExplicit} conflicts with selected P${cancelled||'?'}; no learning association`);
      return false;
    }
    const explicit = taskTarget(task);
    if (explicit) { this.inferred=null; this.operatorAssociation=null; return super.observeTask(task,mapIndex); }
    const chosen = this.operatorAssociation;
    const validChoice = chosen && chosen.mapIndex === Number(mapIndex)
      && Date.now()-chosen.at >= 0 && Date.now()-chosen.at <= 15*60000;
    // Duplicate manufacturer 109 samples frequently contain no point index.
    // They must not erase an already-paired generation during travel.
    if (this.inferred && this.pending && this.pending.index === this.inferred.index
      && Number(this.pending.mapIndex) === Number(mapIndex)
      && Date.now() - this.inferred.at < LEARNING_WINDOW_MS) return true;
    const candidates=[];
    for (let i=2;i<=5;i++) {
      if (!this._pointName(i)) continue;
      const map = this.stored?.[String(mapIndex)]?.[String(i)];
      if (!map || !valid(map)) candidates.push(i);
    }
    // Operator pairing takes priority over single-name CORE inference, and
    // expires after one native task even if the point's arrival later fails.
    if (validChoice) candidates.splice(0,candidates.length,chosen.index);
    this.operatorAssociation=null;
    // No unique owner selection means no association. Never select P1 by default.
    if (candidates.length!==1) {
      this.inferred=null;
      this.log(`[maintenance-coordinator] index-free 109: ${candidates.length} unresolved named candidates; no association`);
      return super.observeTask(task,mapIndex);
    }
    const index=candidates[0];
    const before=this.device._resolveStableMaintenancePoint;
    if (typeof before!=='function') return false;
    this.inferred={index,mapIndex:Number(mapIndex),at:Date.now(),operatorConfirmed:!!validChoice};
    const observed=super.observeTask({...task,point:index},mapIndex);
    if(observed){
      if (this.pending) {
        this.pending.operatorConfirmed=!!validChoice;
        this.pending.startPosition=chosen?.startPosition || null;
      }
      this.log(`[maintenance-coordinator] inferred candidate P${index}; NOT native index proof; waiting for task-correlated native arrival proof`);
      this.feedback.show('observed',index).catch(()=>{});
      this.device._garageSafety?.refreshTileStatus?.('native maintenance trip observed').catch(() => {});
    }
    return observed;
  }
  /** Display-only overlay. The native mower status remains untouched for gate safety.
   * A selected point without a correlated OEM TASK109 is NOT a trip.
   * An OEM maintenance transit is never a new lawn mowing session in the tile.
   */
  tileStatusForNative(nativeStatus, now = Date.now()) {
    const p = this.pending;
    if (p && Number.isInteger(Number(p.index)) && Number(p.index) >= 2 && Number(p.index) <= 5
        && p.mapIndex === Number(this.device._activeMapIndex ?? 0)
        && now - p.at >= 0 && now - p.at <= LEARNING_WINDOW_MS) {
      if (nativeStatus === 'mowing' || nativeStatus === 'mapping' || p.sawTransit === true) {
        if (nativeStatus === 'mowing' || nativeStatus === 'mapping' || nativeStatus === 'paused')
          return 'garage_maintenance_transit';
      }
    }
    if (this._lastConfirmedTravel && now - this._lastConfirmedTravel.at < 90000
        && ['idle', 'paused'].includes(nativeStatus)) return 'garage_maintenance_reached';
    return null;
  }

  async visiblePoints() {
    const mapIndex=Number(this.device._activeMapIndex||0);
    const raw=await Promise.resolve(this.device.getStoreValue(STORE_KEY)).catch(()=>null) || {};
    this.stored=raw;
    const now=Date.now();
    const needsRevision=Object.values(raw?.[String(mapIndex)]||{})
      .some(p=>p?.mapHash && valid(p));
    let currentHash='';
    if(needsRevision) {
      const prior=this.revisionCache;
      if(prior && prior.mapIndex===mapIndex && now-prior.at<120000) currentHash=prior.hash;
      else {
        const cached=mapRevision(this.device._cachedMAPI);
        const mapi=cached ? null : await this.device._api?.getMAPI?.(this.device.getData().id,mapIndex).catch(()=>null);
        currentHash=cached||mapRevision(mapi);
        this.revisionCache={mapIndex,at:now,hash:currentHash};
      }
    }
    const result=[];
    for(let i=2;i<=5;i++){
      const candidate=raw?.[String(mapIndex)]?.[String(i)];
      const point=knownLearnedPoint(raw,i,mapIndex,currentHash);
      // Display-only restoration: the original preflight deliberately expires
      // unindexed native proofs after 20 minutes. That must NOT silently erase
      // an operator-learned marker from the map. Do not extend drive permission.
      const durableOperatorMarker = !point && candidate
        && candidate.source === 'operator_associated_native_task109_code75_stable'
        && Number(candidate.index) === i && Number(candidate.mapIndex) === mapIndex
        && valid(candidate) && Number(candidate.confirmedAt) > 0
        && (!candidate.mapHash || !currentHash || candidate.mapHash === currentHash)
          ? candidate : null;
      const age=Date.now()-Number(candidate?.confirmedAt||0);
      const tentative=['candidate_unindexed_native_task109_code75_stable',
        'operator_observed_native_task109_idle_stable'].includes(candidate?.source)
        && age>=0 && age<=24*60*60000 && (!candidate.mapHash || !currentHash || candidate.mapHash===currentHash)
        && valid(candidate) ? candidate : null;
      const show=point||durableOperatorMarker||tentative;
      if(valid(show))result.push({index:i,x:Number(show.x),y:Number(show.y),name:this._names(i).de,confirmed:!!(point||durableOperatorMarker),observed:!point&&!durableOperatorMarker});
    }
    return result;
  }
  async attachMap(map) {
    if(!map)return map;
    return {...map,maintenancePoints:await this.visiblePoints()};
  }
  /** Repair-only state: position and name are intentionally independent. */
  async repairPointState(index) {
    if (!Number.isInteger(index) || index < 2 || index > 5) throw new Error('Invalid maintenance point');
    const mapIndex = Number(this.device._activeMapIndex ?? 0);
    const register = await Promise.resolve(this.device.getStoreValue(STORE_KEY)) || {};
    const point = register?.[String(mapIndex)]?.[String(index)] || null;
    const displayConfirmed = !!knownLearnedPoint(register,index,mapIndex,point?.mapHash || '')
      || !!(valid(point) && point.source === 'operator_associated_native_task109_code75_stable'
        && Number(point.index) === index && Number(point.mapIndex) === mapIndex
        && Number(point.confirmedAt) > 0);
    return { index, mapIndex, hasPosition: !!valid(point), confirmed: displayConfirmed,
      x: valid(point) ? Number(point.x) : null, y: valid(point) ? Number(point.y) : null,
      name: this._pointName(index), learnedAt: Number(point?.confirmedAt || 0),
      learning: !!(this.operatorAssociation?.index===index || this.pending?.index===index) };
  }

  async removeRepairPoint(index) {
    if (!Number.isInteger(index) || index < 2 || index > 5) throw new Error('P1 cannot be deleted');
    const mapIndex=Number(this.device._activeMapIndex ?? 0);
    const register=await Promise.resolve(this.device.getStoreValue(STORE_KEY)) || {};
    const byMap={...(register[String(mapIndex)] || {})};
    delete byMap[String(index)];
    await this.device.setStoreValue(STORE_KEY,{...register,[String(mapIndex)]:byMap});
    // Cancel only the chosen learn session, not active garage safety tasks.
    if(this.pending?.index===index) this.pending=null;
    if(this.operatorAssociation?.index===index) this.operatorAssociation=null;
    if(this.inferred?.index===index) this.inferred=null;
    if(this._lastConfirmedTravel?.index===index) this._lastConfirmedTravel=null;
    this.stored=await Promise.resolve(this.device.getStoreValue(STORE_KEY)) || {};
    if (this.stored?.[String(mapIndex)]?.[String(index)] != null) {
      throw new Error(`P${index} position deletion could not be verified`);
    }
    const marks=await this.visiblePoints();
    if(this.device._cachedMapData){
      this.device._cachedMapData.maintenancePoints=marks;
      this.device._cachedMapData.nativeMaintenancePoints=marks.filter(p=>p.confirmed).map(p=>({index:p.index,x:p.x,y:p.y,source:'native_maintenance_confirmed'}));
    }
    await this.syncButtons();
    this.device._scheduleMapCameraImageUpdate?.();
    this.log(`[maintenance-coordinator] Repair P${index} position deleted map=${mapIndex}; name and P1 preserved`);
    return {ok:true,index,mapIndex};
  }

  async prepareOriginalApp(index) {
    if (!Number.isInteger(index) || index < 2 || index > 5) return false;
    const mapIndex=Number(this.device._activeMapIndex||0);
    const garage=this.device._garageSafety;
    // This is an explicit human association, NOT proof of a native target.
    // Do not send opcode 109, resume, dock, or any mowing command.
    if (this.device.getSetting('garage_mode_enabled') === true && !garage?.enabled?.()) {
      this.log(`[maintenance-coordinator] P${index} pairing blocked: Garage Mode currently paused`);
      await this.feedback.show('blocked',index);
      return false;
    }
    if (garage?.enabled?.()) {
      const open=await garage.ensureDoorOpen('maintenance_point_observe', {allowOpenFromDanger:true});
      if(open!==true || !garage.isDoorOpenStable?.() || !garage._doorOpenReleaseVerified?.()
        || garage._lastSensorContactState !== 'open') {
        this.log(`[maintenance-coordinator] P${index} pairing withheld: gate not verified open`);
        await this.feedback.show('blocked',index);
        return false;
      }
    }
    // Capture an independent position at the time learning is armed. A stale
    // cached docking coordinate must never become a verified destination.
    const start=await this.device._api?.getMowerPosition?.(this.device.getData().id).catch(()=>null);
    const startPosition=valid(start) ? {x:Number(start.x),y:Number(start.y)} : null;
    this.operatorAssociation={index,mapIndex,at:Date.now(),startPosition};
    await this.feedback.show('prepared',index);
    const text=garage?._text?.(
      `Tor bereit. Wartungspunkt P${index} bitte innerhalb von 15 Minuten in der Original-MOVA-App auswählen. Homey beobachtet nur die native Ankunft.`,
      `Gate ready. Select maintenance point P${index} in the original MOVA app within 15 minutes. Homey only observes the native arrival.`,
    ) || `Select P${index} in MOVA app.`;
    if (typeof this.device._emitMowerNotice === 'function') {
      this.device._emitMowerNotice('maintenance_selection_required', text, `maintenance_pairing_P${index}`);
    } else {
      this.device._garageSafety?._timeline?.(text, `maintenance:pairing_P${index}`);
    }
    this.log(`[maintenance-coordinator] operator pairing P${index} map=${mapIndex}; no native command dispatched`);
    return true;
  }
  async syncButtons() {
    const d=this.device;
    if(!d.hasCapability||!d.registerCapabilityListener)return;
    const confirmed=await this.visiblePoints();
    const usable=new Set(confirmed.filter(p=>p.confirmed).map(p=>p.index));
    for(let i=2;i<=5;i++) {
      const cap=`cmd_maintenance_point_${i}`, named=!!this._pointName(i);
      const visible=named||usable.has(i);
      if(visible&&!d.hasCapability(cap)) await d.addCapability(cap).catch(e=>this.log(`[maintenance-coordinator] add ${cap}: ${e.message}`));
      if(!d.hasCapability(cap))continue;
      if(typeof d.setCapabilityOptions==='function') {
        const label=this._names(i);
        await d.setCapabilityOptions(cap,{uiComponent:visible?'button':null,title:{en:`Go to ${label.en}`,de:`${label.de} anfahren`},hint:{en:usable.has(i)?`Confirmed native point P${i}`:'Not confirmed. Tap to open gate safely, then select this point in MOVA app for observation.',de:usable.has(i)?`Nativer Wartungspunkt P${i} bestätigt`:'Noch nicht bestätigt. Antippen öffnet sicher das Tor; anschließend diesen Punkt in der MOVA-App zur Beobachtung auswählen.'}}).catch(()=>{});
      }
      if(this.listeners.has(i))continue;
      this.listeners.add(i);
      d.registerCapabilityListener(cap,async value=>{
        if(!value)return;
        try {
          const verified=(await this.visiblePoints()).some(point=>point.index===i && point.confirmed);
          if(verified) await d.cmdGoToMaintenancePoint(i);
          else await this.prepareOriginalApp(i);
        } finally {await d.setCapabilityValue(cap,false).catch(()=>{});}
      });
      await d.setCapabilityValue(cap,false).catch(()=>{});
    }
  }
}
module.exports={MaintenancePointCoordinator};

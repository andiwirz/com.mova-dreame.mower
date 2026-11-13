'use strict';
const assert = require('node:assert/strict');
const { MaintenancePointCoordinator } = require('../lib/garage/MaintenancePointCoordinator');

(async () => {
  for (const index of [2,3,4,5]) {
    const realNow = Date.now;
    let now = realNow(); Date.now = () => now;
    try {
      let saved = {};
      let requested = 0;
      const events=[];
      const device = {
        _activeMapIndex: 0, _latestNativeStatusCode: 2, _nativeMowerStatus: 'idle',
        _cachedMapData: { mowingAreas: [{ id: 7 }], maintenancePoints: [] },
        _api: { getMowerPosition: async () => (++requested===1 ? ({ x: 0, y: 260 }) : ({ x: 4800 + (requested % 2), y: -3500 })), getMAPI: async () => ({ d: { hash: 'maprevision123456' } }) },
        getData: () => ({id:'a2'}), getSetting: () => false,
        getCapabilityValue: () => 'idle',
        _resolveStableMaintenancePoint: async () => ({x:0,y:0}),
        getStoreValue: async key => key === 'native_additional_maintenance_points_v1' ? saved : {},
        setStoreValue: async (key,val) => { if(key === 'native_additional_maintenance_points_v1') saved=val; },
        hasCapability: () => true, registerCapabilityListener: () => {},
        setCapabilityOptions: async () => {}, setCapabilityValue: async (key,val) => events.push([key,val]),
        _scheduleMapCameraImageUpdate: () => events.push(['map-refresh',true]),
        _garageSafety: {refreshTileStatus: async () => events.push(['tile-refresh',true])},
        homey: {i18n:{getLanguage:()=> 'de'}},
      };
      const c = new MaintenancePointCoordinator(device);
      device._additionalMaintenanceEvidence = c;
      await c.load();
      assert.equal(saved['0'], undefined, 'point store must start empty');
      assert.equal(await c.prepareOriginalApp(index), true);
      assert.equal(c.observeTask({o:109, exe:true, status:true}, 0), true);
      now += 10000;
      await c.observeStatus(1,27); // actual OEM trip
      now += 10000;
      await c.observeStatus(2,75); // arrival candidate
      assert.equal(saved['0'], undefined, 'no premature store on first observation');
      now += 5000;
      await c.observeStatus(2,75); // independently stable arrival
      assert.equal(c.pending,null,'learning should complete on first trip');
      const stored = saved['0']?.[String(index)];
      assert.equal(stored?.source,'operator_associated_native_task109_code75_stable');
      assert.equal(stored?.index,index);
      assert.ok(events.some(([key,value])=>key==='maintenance_learning_status'&&value.includes('bestätigt')));
      assert.ok(events.some(([key])=>key==='map-refresh'));
      assert.ok(events.some(([key])=>key==='tile-refresh'));
      assert.equal(device._cachedMapData.maintenancePoints.length,1);
      assert.equal(device._cachedMapData.maintenancePoints[0].index,index);
      assert.equal(device._cachedMapData.maintenancePoints[0].confirmed,true);
      assert.equal(device._cachedMapData.mowingAreas[0].id,7,'do not change mowing geometry');
      assert.equal(c.tileStatusForNative('idle'),'garage_maintenance_reached');
      const reloaded = new MaintenancePointCoordinator(device);
      await reloaded.load();
      const points = await reloaded.visiblePoints();
      assert.equal(points.length,1,'point must survive reopened view');
      assert.equal(points[0].confirmed,true);
    } finally { Date.now = realNow; }
  }
  console.log('PASS: P2-P5 first OEM arrival with empty point store -> confirmed, visible, reloaded and status updated');
})().catch(e=>{ console.error(e); process.exitCode=1; });

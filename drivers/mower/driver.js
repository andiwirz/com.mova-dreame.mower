'use strict';

const Homey = require('homey');
const MovaApi = require('../../lib/MovaApi');
const { availableGarageMaintenancePointIndexes } = require('../../lib/garage/MaintenancePointResolver');
const safeGetStoreValue = require('../../lib/util/safe-store');

class MowerDriver extends Homey.Driver {
  async onInit() {
    this.log('Mower driver initialized');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    const flow = this.homey.flow;

    // ─── Actions ──────────────────────────────────────────────────────────────

    flow.getActionCard('start_mowing')
      .registerRunListener(({ device }) => device.cmdStartMowing());

    flow.getActionCard('start_zone_mowing')
      .registerRunListener(({ device, zones }) => device.cmdStartZoneMowing(zones));

    flow.getActionCard('start_edge_zone_mowing')
      .registerRunListener(({ device, zone }) => device.cmdStartEdgeZoneMowing(zone));

    flow.getActionCard('start_border_patrol')
      .registerRunListener(({ device, zone }) => device.cmdStartBorderPatrol(zone));

    flow.getActionCard('start_edge_mowing')
      .registerRunListener(({ device }) => device.cmdStartEdgeMowing());

    flow.getActionCard('start_spot_mowing')
      .registerRunListener(({ device, spots }) => device.cmdStartSpotMowing(spots));

    flow.getActionCard('pause_mowing')
      .registerRunListener(({ device }) => device.cmdPause());

    flow.getActionCard('resume_mowing')
      .registerRunListener(({ device }) => device.cmdResume());

    flow.getActionCard('stop_mowing')
      .registerRunListener(({ device }) => device.cmdStop());

    flow.getActionCard('return_to_dock')
      .registerRunListener(({ device }) => device.cmdDock());

    flow.getActionCard('set_mowing_mode')
      .registerRunListener(({ device, mode }) => device.cmdSetMowingMode(mode));

    flow.getActionCard('find_bot')
      .registerRunListener(({ device }) => device.cmdFindBot());

    flow.getActionCard('suppress_fault')
      .registerRunListener(({ device }) => device.cmdSuppressFault());

    // The ORIGINAL action ID stays stable. Homey Flows created before the
    // point-selection update omit maintenance_point and must keep working.
    // Special symbolic IDs never depend on editable point names.
    const primaryIndex = (device) => {
      const index = Number(device?._garageMaintenanceConfig?.primary);
      return Number.isInteger(index) && index >= 1 && index <= 5 ? index : 1;
    };
    const driveToSelectedMaintenance = ({ device, maintenance_point }) => {
      const value = maintenance_point == null || maintenance_point === ''
        ? 'primary' : (typeof maintenance_point === 'object' ? maintenance_point.id : maintenance_point);
      if (value === 'primary') return device.cmdGoToMaintenancePoint(primaryIndex(device));
      if (value === 'rotation') return device.cmdGoToRotatingMaintenancePoint();
      const id = String(value ?? '');
      if (!/^P[1-5]$/.test(id)) {
        const de = String(device?.homey?.i18n?.getLanguage?.() || 'en').toLowerCase().startsWith('de');
        throw new Error(de ? 'Ungültige oder veraltete Wartungspunkt-ID.' : 'Invalid or outdated maintenance point ID.');
      }
      return device.cmdGoToMaintenancePoint(Number(id.slice(1)));
    };

    const maintenanceCard = flow.getActionCard('go_to_maintenance_point');
    maintenanceCard.registerRunListener(driveToSelectedMaintenance);
    maintenanceCard.registerArgumentAutocompleteListener('maintenance_point',
      (query, { device } = {}) => device ? device.getMaintenancePointFlowAutocomplete(query) : []);

    flow.getActionCard('set_cutting_height')
      .registerRunListener(({ device, height }) => device.cmdSetCuttingHeight(height));

    flow.getActionCard('set_efficiency_mode')
      .registerRunListener(({ device, mode }) => device.cmdSetEfficiencyMode(mode));

    flow.getActionCard('set_lift_alarm')
      .registerRunListener(({ device, enabled }) => device.cmdSetLiftAlarm(enabled === 'true'));

    flow.getActionCard('set_child_lock')
      .registerRunListener(({ device, enabled }) => device.cmdSetChildLock(enabled === 'true'));

    const setMapCard = flow.getActionCard('set_active_map');
    setMapCard.registerRunListener(({ device, map_name }) => device.cmdSetActiveMap(Number(map_name.id)));
    setMapCard.registerArgumentAutocompleteListener('map_name', (query, { device }) => device.getMapAutocomplete(query));

    flow.getActionCard('refresh_data')
      .registerRunListener(({ device }) => device.cmdRefreshData());

    flow.getActionCard('garage_set_door_state')
      .registerRunListener(({ device, state }) => device.cmdGarageSetDoorState(state));

    flow.getActionCard('garage_set_sensor_available')
      .registerRunListener(({ device, available }) => device.cmdGarageSetSensorAvailable(available));

    flow.getActionCard('garage_set_sensor_battery')
      .registerRunListener(({ device, battery }) => device.cmdGarageSetSensorBattery(battery));

    flow.getActionCard('garage_safe_return')
      .registerRunListener(({ device }) => device.cmdGarageSafeReturn());

    // ─── Conditions ───────────────────────────────────────────────────────────

    flow.getConditionCard('is_mowing')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('mower_status') === 'mowing',
      );

    flow.getConditionCard('is_docked')
      .registerRunListener(({ device }) => {
        const s = device.getCapabilityValue('mower_status');
        return s === 'docked' || s === 'charging' || s === 'charging_completed';
      });

    flow.getConditionCard('is_charging')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('charging_status') === 'charging',
      );

    flow.getConditionCard('mower_has_error')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('alarm_generic') === true,
      );

    flow.getConditionCard('mowing_mode_is')
      .registerRunListener(async ({ device, mode }) =>
        (await device.getStoreValue('mowing_mode') || 'all_area') === mode,
      );

    flow.getConditionCard('is_efficient_mode')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('mow_efficiency') === 'efficient',
      );

    flow.getConditionCard('battery_level_is')
      .registerRunListener(({ device, percentage }) =>
        device.getCapabilityValue('measure_battery') >= percentage,
      );

    flow.getConditionCard('garage_mode_is_enabled')
      .registerRunListener(({ device }) => !!device.getSetting('garage_mode_enabled'));

    flow.getConditionCard('garage_door_is_open')
      .registerRunListener(({ device }) => device.getCapabilityValue('garage_door_status') === 'open');

    flow.getConditionCard('garage_at_maintenance_point')
      .registerRunListener(({ device }) => device._garageSafety ? device._garageSafety.isAtMaintenancePointHeuristic() : false);

    const activeMapCard = flow.getConditionCard('active_map_is');
    activeMapCard.registerRunListener(({ device, map_name }) =>
      device.getCapabilityValue('mow_map') === `map_${map_name.id}`,
    );
    activeMapCard.registerArgumentAutocompleteListener('map_name', (query, { device }) => device.getMapAutocomplete(query));

    // ─── Trigger run-listeners (for arg-filtered triggers) ────────────────────

    flow.getDeviceTriggerCard('battery_low')
      // Fire only when the battery level crosses below the configured threshold in this
      // poll step (prev >= threshold && pct < threshold). This prevents the trigger from
      // re-firing on every subsequent poll while the battery stays below the threshold.
      .registerRunListener((_args, { pct, prev }) =>
        prev >= _args.threshold && pct < _args.threshold,
      );

    flow.getDeviceTriggerCard('consumable_needs_replacement')
      .registerRunListener((_args, state) => state.pct <= _args.threshold);
  }

  // ─── Repair (re-authentication after password change) ─────────────────────

  async onRepair(session, device) {
    let api = null;

    // Diagnostic only: view transitions are useful when Homey cannot load a
    // custom repair asset. No credentials or map data are logged here.
    session.setHandler('showView', async (viewId) => {
      this.log('[repair] view', String(viewId || 'unknown'));
      return true;
    });

    // The repair flow doubles as a device-local map editor. This makes the
    // interactive garage/safety editor available even when no dashboard widget
    // has been installed. It uses the same device methods/store keys as the widget.
    session.setHandler('get_map_editor_runtime', async () => {
      // Fixed packaged source only: no input-controlled path or executable data.
      const html = require('node:fs').readFileSync(require('node:path').join(__dirname, 'repair/map_editor.html'), 'utf8');
      const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      if (!source) throw new Error('Packaged repair-map runtime is missing');
      this.log('[repair map] Editor-Startcode angefordert / Editor startup code requested');
      return source;
    });

    session.setHandler('get_map_editor_data', async () => {
      if (!device || typeof device.getMapData !== 'function') return null;
      return await Promise.resolve(device.getMapData()) ?? null;
    });

    session.setHandler('map_editor_diagnostic', async (payload) => {
      this.error('[repair map]', String(payload?.stage || 'unknown').slice(0, 32),
        String(payload?.message || 'unknown error').replace(/[\r\n]/g, ' ').slice(0, 200));
      return true;
    });

    session.setHandler('refresh_map_editor_data', async () => {
      if (!device) return null;
      if (typeof device.refreshMapData === 'function') {
        return await Promise.resolve(device.refreshMapData({ hard: true })) ?? null;
      }
      if (typeof device.getMapData === 'function') return await Promise.resolve(device.getMapData()) ?? null;
      return null;
    });

    session.setHandler('save_map_editor_markers', async (payload) => {
      if (!device || typeof device.updateGarageOverlayMarkers !== 'function') {
        throw new Error('Mower device does not support map marker editing');
      }
      return device.updateGarageOverlayMarkers(payload || {});
    });

    // Per-repair-session language override. This does not change the mower,
    // Homey hub's global language, or other users' sessions. The iOS Repair
    // WebView may disallow localStorage, so this also synchronizes subviews.
    let repairUiLanguageOverride = null;
    session.setHandler('set_repair_ui_language', ({ language } = {}) => {
      if (language !== 'de' && language !== 'en') throw new Error('Unsupported repair UI language');
      repairUiLanguageOverride = language;
      return repairUiLanguageOverride;
    });

    // Repair webviews may use an embedded-browser locale that differs from Homey.
    // Read the authoritative locale from Homey's application i18n instead.
    session.setHandler('get_repair_ui_language', () => {
      const language = String(this.homey?.i18n?.getLanguage?.() || 'en');
      return repairUiLanguageOverride || (/^de(?:[-_]|$)/i.test(language) ? 'de' : 'en');
    });

    session.setHandler('get_garage_repair_configuration', async () => {
      if (!device?.getGarageRepairConfiguration) throw Error('Garage configuration unavailable');
      const config=device.getGarageRepairConfiguration();
      const markerDiagnosis=String(await safeGetStoreValue(device, 'garage_marker_diagnosis_v2')||'');
      // One stable native-map point resolver for Repair and the map marker.
      const available=availableGarageMaintenancePointIndexes(device);
      const source=device?._cachedMapData?.nativeMaintenancePoints || device?._cachedMapData?.maintenancePoints || [];
      const stored=device?._storedAdditionalMaintenancePoints?.[String(device?._activeMapIndex??0)] || {};
      const known=[1,2,3,4,5].filter(i=>i===1 || source.some(p=>Number(p?.index)===i
        && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
        || (stored[String(i)] && Number.isFinite(Number(stored[String(i)].x)) && Number.isFinite(Number(stored[String(i)].y))));
      const selected=Number(device._garageMaintenanceConfig?.primary||1);
      const selectable=[1,2,3,4,5].filter(index=>index===1 || String(device._getGarageManagedSetting(`maintenance_point_${index}_name`)||'').trim());
      return {...config,markerDiagnosis,pointSelection:{available,known,selectable,selected,
        rotation:device._garageMaintenanceConfig?.rotation==='alternate'&&available.length>1?'alternate':'fixed',
        effective:device._maintenancePointIndex(),
        names:Object.fromEntries(available.map(index=>[String(index),
          String(device._getGarageManagedSetting(`maintenance_point_${index}_name`)||'').trim()||`P${index}`]))}};
    });
    session.setHandler('save_garage_repair_configuration', async payload => {
      if (!device?.saveGarageRepairConfiguration) throw Error('Garage configuration unavailable');
      return device.saveGarageRepairConfiguration(payload);
    });
    session.setHandler('confirm_garage_repair_migration', async () => {
      if (!device?.confirmGarageRepairMigrationReview) throw Error('Garage review unavailable');
      return device.confirmGarageRepairMigrationReview();
    });
    session.setHandler('reset_garage_markers', async payload => {
      if (payload?.confirm !== 'RESET GARAGE MARKERS') throw Error('Reset confirmation required');
      return device.resetGarageMarkersFromRepair();
    });

    session.setHandler('get_maintenance_point_config', async () => {
      if (!device) return { garageEnabled:false, available:[], known:[], selected:1, effective:1, rotation:'fixed', names:{}, busy:true };
      const garageEnabled=device.getSetting('garage_mode_enabled')===true;
      const available=availableGarageMaintenancePointIndexes(device);
      const selected=Number(device._garageMaintenanceConfig?.primary||1);
      const rotation=device._garageMaintenanceConfig?.rotation==='alternate'?'alternate':'fixed';
      const map=String(device._activeMapIndex??0);
      const rawPoints=device._cachedMapData?.nativeMaintenancePoints||device._cachedMapData?.maintenancePoints||[];
      const points=Array.isArray(rawPoints)?rawPoints:[];
      const persisted=device._storedAdditionalMaintenancePoints?.[map]||{};
      const known=[1,2,3,4,5].filter(index=>index===1||points.some(p=>Number(p?.index)===index&&Number.isFinite(Number(p.x))&&Number.isFinite(Number(p.y)))||!!(persisted[String(index)]&&Number.isFinite(Number(persisted[String(index)].x))&&Number.isFinite(Number(persisted[String(index)].y))));
      const names=Object.fromEntries([1,2,3,4,5].map(index=>[String(index),String(device._getGarageManagedSetting(`maintenance_point_${index}_name`)||'').trim()]));
      const selectable=[1,2,3,4,5].filter(index=>index===1||!!names[String(index)]);
      const busy=!!(device._garageSafety?.isReturnCycleActive?.()||device._garageSafety?._outbound||device._garageSafety?._manualMaintenanceTransit||device._garageSafety?._emergencyHoldActive?.()||['opening','closing'].includes(device._garageSafety?.doorState?.()));
      return {garageEnabled,available,known,selectable,names,selected,effective:device._maintenancePointIndex(),rotation,busy};
    });

    session.setHandler('save_maintenance_point_config', async (payload) => {
      if (!device) throw Error('Mower device unavailable');
      if (device._garageSafety?.isReturnCycleActive?.() || device._garageSafety?._outbound || device._garageSafety?._manualMaintenanceTransit) {
        throw new Error(device.homey?.__('user_error.garage_repair_busy')||'Maintenance changes are locked during an active mission.');
      }
      const point = Number(payload?.selected);
      const rotation = String(payload?.rotation || 'fixed');
      if (!Number.isInteger(point) || point<1 || point>5) throw new Error('Maintenance point must be P1–P5.');
      if (rotation !== 'fixed' && rotation !== 'alternate') throw new Error(device.homey?.__('user_error.maintenance_rotation_invalid')||'Invalid rotation mode.');
      return device.updateGarageMaintenancePointConfig({ primary: point, rotation });
    });

    session.setHandler('save_maintenance_point_name', async (payload) => {
      if (!device || typeof device.updateMaintenancePointName !== 'function') {
        throw new Error('Mower device does not support maintenance point names');
      }
      return device.updateMaintenancePointName(payload?.index, payload?.name, payload?.primary);
    });

    session.setHandler('save_map_obstacle_rule', async (payload) => {
      this.log('[repair] pylon action requested', payload?.deleteForbidden ? 'delete' : payload?.remove ? 'hide' : payload?.action === 'avoid' ? 'save zone' : 'marker',
        'id=', String(payload?.id || '').slice(0, 64));
      if (!device || typeof device.updateObstacleRule !== 'function') {
        throw new Error('Mower device does not support obstacle marker editing');
      }
      try {
        const result = await device.updateObstacleRule(payload || {});
        this.log('[repair] pylon action confirmed', result?.rule?.nativeId ?? 'marker');
        return result;
      } catch (err) {
        this.error('[repair] pylon action failed:', err.message);
        throw err;
      }
    });

    // Let the repair page pre-select the correct brand and region.
    session.setHandler('get_repair_settings', async () => ({
      brand:  await device.getStoreValue('brand')  || 'mova',
      region: await device.getStoreValue('region') || 'eu',
    }));

    session.setHandler('login', async ({ brand, region, username, password }) => {
      api = new MovaApi({ brand, region, log: (...a) => this.log(...a) });
      await api.login(username, password);
      return true;
    });

    session.setHandler('repair_credentials', async () => {
      if (!api) throw new Error('Not authenticated — please log in first.');
      const tokens = api.getTokens();
      await device.updateTokens({ ...tokens, uid: api.getUid?.() || null });
      return true;
    });
  }

  // ─── Pairing ───────────────────────────────────────────────────────────────

  async onPair(session) {
    let api = null;
    let discoveredDevices = [];

    session.setHandler('login', async ({ brand, region, username, password }) => {
      api = new MovaApi({ brand, region, log: (...a) => this.log(...a) });
      await api.login(username, password);

      const all = await api.getDevices();

      // Debug: log what the API returns so we can identify the model-name format.
      this.log('[pair] raw device list:', JSON.stringify(
        all.map((d) => ({ did: d.did, name: d.name, model: d.model, type: d.type, category: d.category })),
      ));

      // Accept devices whose model identifier OR display name hints at a mower.
      // We check several field names because the MOVA cloud may use productModel/type
      // instead of model, and model identifiers vary (e.g. mova.mower.* vs mova.robot.*).
      const MOWER_KEYWORDS = ['mow', 'lawn', 'mäh'];
      discoveredDevices = all.filter((d) => {
        if (!d || !d.did) return false;
        const model = (d.model || d.productModel || d.type || '').toLowerCase();
        const name  = (d.name || '').toLowerCase();
        return MOWER_KEYWORDS.some((kw) => model.includes(kw) || name.includes(kw));
      });

      // If keyword matching finds nothing, fall back to showing every device so the
      // user can still pick their mower manually (avoids a dead-end in the pairing UI).
      if (discoveredDevices.length === 0) {
        this.log('[pair] no mower keyword match — showing all', all.length, 'devices as fallback');
        discoveredDevices = all.filter((d) => d && d.did);
      }

      if (discoveredDevices.length === 0) {
        throw new Error(this.homey.__('pair.error_no_devices'));
      }

      return {
        devices: discoveredDevices.map((d) => ({
          name:  d.customName || (d.deviceInfo && d.deviceInfo.displayName) || d.name || d.model,
          model: d.model,
          did:   d.did,
        })),
      };
    });

    session.setHandler('get_credentials', async ({ did }) => {
      const device = discoveredDevices.find((d) => d.did === did);
      if (!device) throw new Error('Device not found');

      const tokens = api.getTokens();
      return {
        name: device.customName || (device.deviceInfo && device.deviceInfo.displayName) || device.name || device.model,
        data: { id: did },
        store: {
          access_token:  tokens.accessToken,
          refresh_token: tokens.refreshToken,
          token_expiry:  tokens.tokenExpiry,
          brand:         api.getBrand(),
          region:        api.getRegion(),
          model:         device.model || '',
          bind_domain:   device.bindDomain || '',
        },
        settings: {
          username:      api.getUsername(),
          brand:         api.getBrand(),
          region:        api.getRegion(),
          device_model:  device.model || '',
          poll_interval: 30,
        },
      };
    });
  }
}

module.exports = MowerDriver;

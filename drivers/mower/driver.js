'use strict';

const Homey = require('homey');
const MovaApi = require('../../lib/MovaApi');

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

    flow.getActionCard('start_edge_mowing')
      .registerRunListener(({ device }) => device.cmdStartEdgeMowing());

    flow.getActionCard('start_spot_mowing')
      .registerRunListener(({ device, spots }) => device.cmdStartSpotMowing(spots));

    flow.getActionCard('pause_mowing')
      .registerRunListener(({ device }) => device.cmdPause());

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

    // ─── Trigger run-listeners (for arg-filtered triggers) ────────────────────

    flow.getDeviceTriggerCard('battery_low')
      .registerRunListener(({ device, threshold }) =>
        device.getCapabilityValue('measure_battery') < threshold,
      );
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

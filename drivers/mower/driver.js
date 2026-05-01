'use strict';

const Homey = require('homey');
const DreameApi = require('../../lib/DreameApi');

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
      .registerRunListener(({ device, zones, passes }) =>
        device.cmdStartZoneMowing(zones, passes ?? 1),
      );

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

    flow.getActionCard('set_mowing_speed')
      .registerRunListener(({ device, speed }) => device.cmdSetMowingSpeed(speed));

    flow.getActionCard('set_mowing_pattern')
      .registerRunListener(({ device, pattern }) => device.cmdSetMowingPattern(pattern));

    flow.getActionCard('set_rain_protection')
      .registerRunListener(({ device, enabled }) =>
        device.cmdSetRainProtection(enabled === 'true'),
      );

    flow.getActionCard('set_night_mode')
      .registerRunListener(({ device, enabled }) =>
        device.cmdSetNightMode(enabled === 'true'),
      );

    flow.getActionCard('find_bot')
      .registerRunListener(({ device }) => device.cmdFindBot());

    flow.getActionCard('suppress_fault')
      .registerRunListener(({ device }) => device.cmdSuppressFault());

    flow.getActionCard('set_child_lock')
      .registerRunListener(({ device, enabled }) =>
        device.cmdSetChildLock(enabled === 'true'),
      );

    flow.getActionCard('set_dnd')
      .registerRunListener(({ device, enabled }) =>
        device.cmdSetDND(enabled === 'true'),
      );

    flow.getActionCard('reset_consumable')
      .registerRunListener(({ device, consumable }) =>
        device.cmdResetConsumable(consumable),
      );

    // ─── Conditions ───────────────────────────────────────────────────────────

    flow.getConditionCard('is_mowing')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('mower_status') === 'mowing',
      );

    flow.getConditionCard('is_docked')
      .registerRunListener(({ device }) => {
        const s = device.getCapabilityValue('mower_status');
        return s === 'docked' || s === 'charging';
      });

    flow.getConditionCard('is_charging')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('charging_status') === 'charging',
      );

    flow.getConditionCard('mower_has_error')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('alarm_generic') === true,
      );

    flow.getConditionCard('is_child_locked')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('child_lock') === true,
      );

    flow.getConditionCard('mowing_mode_is')
      .registerRunListener(({ device, mode }) =>
        device.getCapabilityValue('mower_mode') === mode,
      );

    flow.getConditionCard('mowing_pattern_is')
      .registerRunListener(({ device, pattern }) =>
        device.getCapabilityValue('mower_pattern') === pattern,
      );

    flow.getConditionCard('mowing_speed_is')
      .registerRunListener(({ device, speed }) =>
        device.getCapabilityValue('mowing_speed') === speed,
      );

    flow.getConditionCard('rain_protection_is_enabled')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('rain_protection') === true,
      );

    flow.getConditionCard('night_mode_is_enabled')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('night_mode') === true,
      );

    // ─── Trigger run-listeners (for arg-filtered triggers) ────────────────────

    flow.getDeviceTriggerCard('battery_low')
      .registerRunListener(({ device, threshold }) =>
        device.getCapabilityValue('measure_battery') < threshold,
      );

    flow.getDeviceTriggerCard('consumable_low')
      .registerRunListener(({ device, consumable, threshold }) => {
        const capId = `consumable_${consumable}`;
        return device.getCapabilityValue(capId) < threshold;
      });
  }

  // ─── Pairing ───────────────────────────────────────────────────────────────

  async onPair(session) {
    let api = null;
    let discoveredDevices = [];

    session.setHandler('login', async ({ brand, region, username, password }) => {
      api = new DreameApi({ brand, region });
      await api.login(username, password);

      const all = await api.getDevices();
      discoveredDevices = all.filter((d) => {
        if (!d || !d.model) return false;
        return d.model.toLowerCase().includes('mow');
      });

      if (discoveredDevices.length === 0) {
        throw new Error(this.homey.__('pair.error_no_devices'));
      }

      return {
        devices: discoveredDevices.map((d) => ({
          name:  d.name || d.model,
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
        name: device.name || device.model,
        data: { id: did },
        store: {
          access_token:  tokens.accessToken,
          refresh_token: tokens.refreshToken,
          token_expiry:  tokens.tokenExpiry,
          brand:         api.getBrand(),
          region:        api.getRegion(),
          model:         device.model || '',
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

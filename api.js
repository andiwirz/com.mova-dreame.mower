'use strict';

const DreameApi = require('./lib/DreameApi');

module.exports = {

  /**
   * Returns a list of all paired mower devices.
   * Called from settings/index.html via Homey.api('GET', '/getDevices', ...)
   */
  async getDevices({ homey }) {
    const driver = homey.drivers.getDriver('mower');
    return driver.getDevices().map((d) => ({
      id:        d.getData().id,
      name:      d.getName(),
      model:     d.getSetting('device_model') || '',
      available: d.getAvailable(),
    }));
  },

  /**
   * Polls the cloud API for a specific device and returns the raw properties.
   * Called from settings/index.html via Homey.api('GET', '/pollDevice?deviceId=...', ...)
   *
   * Special mode: deviceId === '__discover__' authenticates with the supplied
   * brand/region/username/password query params and returns the raw cloud device
   * list — used by the Discover Devices section in the settings page.
   */
  async pollDevice({ homey, query }) {
    const { deviceId } = query;
    if (!deviceId) throw new Error('Missing deviceId parameter');

    // ── Discovery mode ───────────────────────────────────────────────────────
    if (deviceId === '__discover__') {
      const { brand, region, username, password } = query;
      if (!brand || !region || !username || !password) {
        throw new Error('brand, region, username and password are required');
      }
      const api = new DreameApi({ brand, region, log: (...a) => homey.app.log(...a) });
      await api.login(username, password);
      return api.getRawDevices();
    }

    // ── Normal poll mode ─────────────────────────────────────────────────────
    const driver = homey.drivers.getDriver('mower');
    const device = driver.getDevices().find((d) => d.getData().id === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);

    return device.getDebugPollData();
  },

};

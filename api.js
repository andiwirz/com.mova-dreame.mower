'use strict';

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
   */
  async pollDevice({ homey, query }) {
    const { deviceId } = query;
    if (!deviceId) throw new Error('Missing deviceId parameter');

    const driver = homey.drivers.getDriver('mower');
    const device = driver.getDevices().find((d) => d.getData().id === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);

    return device.getDebugPollData();
  },

};

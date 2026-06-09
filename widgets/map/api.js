'use strict';

module.exports = {
  async getMapData({ homey, query }) {
    const { deviceId } = query;
    if (!deviceId) return null;

    for (const driver of Object.values(homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        if (device.getId() === deviceId) {
          return device.getMapData() ?? null;
        }
      }
    }
    return null;
  },
};

'use strict';

function findDevice(homey, requestedDeviceId) {
  let firstDevice = null;
  for (const driver of Object.values(homey.drivers.getDrivers())) {
    for (const device of driver.getDevices()) {
      if (!firstDevice && typeof device.getMapData === 'function') firstDevice = device;
      const ids = [
        typeof device.getId === 'function' ? device.getId() : null,
        device.getData && device.getData() ? device.getData().id : null,
        device.getData && device.getData() ? device.getData().deviceId : null,
      ].filter(Boolean).map(String);
      if (requestedDeviceId && ids.includes(String(requestedDeviceId))) return device;
    }
  }
  return firstDevice;
}

module.exports = {
  async getMapData({ homey, query }) {
    const device = findDevice(homey, query && query.deviceId);
    if (!device) return null;
    return await Promise.resolve(device.getMapData()) ?? null;
  },

  async updateGarageMarkers({ homey, query, body }) {
    const device = findDevice(homey, query && query.deviceId);
    if (!device || typeof device.updateGarageOverlayMarkers !== 'function') {
      throw new Error('Mower device does not support garage marker editing');
    }
    return device.updateGarageOverlayMarkers(body || {});
  }
};

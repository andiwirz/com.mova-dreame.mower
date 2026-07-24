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
    const requestedDeviceId = query && query.deviceId;
    let firstDevice = null;

    for (const driver of Object.values(homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        if (!firstDevice && typeof device.getMapData === 'function') firstDevice = device;
        const ids = [
          typeof device.getId === 'function' ? device.getId() : null,
          device.getData && device.getData() ? device.getData().id : null,
          device.getData && device.getData() ? device.getData().deviceId : null,
        ].filter(Boolean).map(String);
        if (requestedDeviceId && ids.includes(String(requestedDeviceId)) && typeof device.getMapData === 'function') {
          return await Promise.resolve(device.getMapData()) ?? null;
        }
      }
    }

    // Homey mobile/dashboard can occasionally open a singular device widget
    // without passing the deviceId on the first request. Fall back to the first
    // mower device instead of returning null and showing "No map data yet".
    // Some Homey clients pass the widget instance id instead of the app device id.
    // In a singular app widget that must not result in a false 'No map data' page.
    if (firstDevice) {
      return await Promise.resolve(firstDevice.getMapData()) ?? null;
    }

    return null;
  },

  async updateGarageMarkers({ homey, query, body }) {
    const device = findDevice(homey, query && query.deviceId);
    if (!device || typeof device.updateGarageOverlayMarkers !== 'function') {
      throw new Error('Mower device does not support garage marker editing');
    }
    return device.updateGarageOverlayMarkers(body || {});
  }
};

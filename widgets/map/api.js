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
  return requestedDeviceId ? null : firstDevice;
}

module.exports = {
  async getMapData({ homey, query }) {
    const device = findDevice(homey, query && query.deviceId);
    if (!device) return null;
    const forceRefresh = ['1', 'true', 'yes'].includes(String(query?.refresh || '').toLowerCase());
    const hardRefresh = ['1', 'true', 'yes'].includes(String(query?.hard || '').toLowerCase());
    if (forceRefresh && typeof device.refreshMapData === 'function') {
      return await Promise.resolve(device.refreshMapData({ hard: hardRefresh })) ?? null;
    }
    return await Promise.resolve(device.getMapData()) ?? null;
  },

  async updateGarageMarkers({ homey, query, body }) {
    const device = findDevice(homey, query && query.deviceId);
    if (!device || typeof device.updateGarageOverlayMarkers !== 'function') {
      throw new Error('Mower device does not support garage marker editing');
    }
    return device.updateGarageOverlayMarkers(body || {});
  },

  async updateObstacleRule({ homey, query, body }) {
    const device = findDevice(homey, query && query.deviceId);
    if (!device || typeof device.updateObstacleRule !== 'function') {
      throw new Error('Mower device does not support obstacle rule editing');
    }
    device.log?.('[widget-map] pylon rule request',
      body?.deleteForbidden ? 'delete' : body?.remove ? 'hide' : body?.action === 'label' ? 'save-native-label' : body?.action === 'avoid' ? 'save-zone' : 'observe',
      `id=${String(body?.id || '').slice(0,64)}`);
    try {
      const result = await device.updateObstacleRule(body || {});
      device.log?.('[widget-map] pylon rule result', `pending=${!!result?.pending}`,
        `nativeId=${result?.rule?.nativeId ?? 'none'}`, `verification=${result?.rule?.verification || 'none'}`);
      return result;
    } catch (err) {
      device.error?.('[widget-map] pylon rule failed:', err.message);
      throw err;
    }
  }
};

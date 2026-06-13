'use strict';

function findDevice(homey, deviceId) {
  for (const driver of Object.values(homey.drivers.getDrivers())) {
    for (const device of driver.getDevices()) {
      if (device.getId() === deviceId) return device;
    }
  }
  return null;
}

module.exports = {
  async getSessions({ homey, query }) {
    const device = findDevice(homey, query.deviceId);
    if (!device) return [];
    return device.getActivitySessions();
  },

  async getPhotos({ homey, query }) {
    const device = findDevice(homey, query.deviceId);
    if (!device || !query.filename) return [];
    return device.getSessionPhotos(query.filename);
  },

  async getPhoto({ homey, query }) {
    const device = findDevice(homey, query.deviceId);
    if (!device || !query.photoId) return null;
    return device.getObstaclePhotoBase64(query.photoId);
  },
};

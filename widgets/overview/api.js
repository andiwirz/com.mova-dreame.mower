'use strict';
const dashboard = require('../../lib/widgets/MowerDashboard');
const map = require('../map/api');
const { renderMapSnapshot } = require('../../lib/widgets/MapSnapshotRenderer');

module.exports = {
  ...map,
  getOverview: dashboard.getOverview,
  camera: dashboard.camera,
  command: dashboard.command,
  async getMapSnapshot({ homey, query }) {
    const data = await map.getMapData({ homey, query });
    const svg = renderMapSnapshot(data);
    return {
      svg,
      updatedAt: Date.now(),
      hasMap: !!svg,
    };
  },
};

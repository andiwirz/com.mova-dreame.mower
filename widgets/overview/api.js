'use strict';
const dashboard = require('../../lib/widgets/MowerDashboard');
const map = require('../map/api');
const { renderMapSnapshot } = require('../../lib/widgets/MapSnapshotRenderer');

module.exports = {
  ...map,
  getOverview: dashboard.getOverview,
  command: dashboard.command,
  async getMapSnapshot({ homey, query }) {
    const data = await map.getMapData({ homey, query });
    const svg = renderMapSnapshot(data);
    return {
      svg,
      updatedAt: Date.now(),
      hasMap: !!svg,
      mapName: typeof data?.name === 'string' ? data.name : null,
      mowerStatus: typeof data?.mowerStatus === 'string' ? data.mowerStatus : null,
      positionUpdatedAt: Number(data?.positionUpdatedAt || 0),
      routeCompletionConfirmed: data?.routeCompletionConfirmed === true,
    };
  },
};

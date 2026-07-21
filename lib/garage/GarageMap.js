'use strict';

class GarageMap {
  constructor(device) { this.device = device; }
  getMapData() { return this.device.getMapData(); }
}

module.exports = GarageMap;

'use strict';

class GarageOverlay {
  constructor(engine) { this.engine = engine; }
  data() { return this.engine.getGarageOverlayData(); }
}

module.exports = GarageOverlay;

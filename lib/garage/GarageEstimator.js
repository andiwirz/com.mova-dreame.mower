'use strict';

class GarageEstimator {
  constructor(engine) { this.engine = engine; }
  speed() { return this.engine.estimateSpeed ? this.engine.estimateSpeed() : null; }
}

module.exports = GarageEstimator;

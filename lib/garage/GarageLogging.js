'use strict';

class GarageLogging {
  constructor(engine) { this.engine = engine; }
  log(...args) { return this.engine.log(...args); }
}

module.exports = GarageLogging;

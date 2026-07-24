'use strict';

class GarageReturn {
  constructor(engine) { this.engine = engine; }
  request(source, dockFn, maintenanceFn) { return this.engine.returnRequested(source, dockFn, maintenanceFn); }
}

module.exports = GarageReturn;

'use strict';

class GarageDoorController {
  constructor(engine) { this.engine = engine; }
  state() { return this.engine.doorState(); }
  ensureOpen(reason, opts) { return this.engine.ensureDoorOpen(reason, opts); }
  requestClose(reason, opts) { return this.engine.requestClose(reason, opts); }
}

module.exports = GarageDoorController;

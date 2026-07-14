'use strict';

const Homey = require('homey');

const MAX_LOG_ENTRIES = 1000;

class DreameApp extends Homey.App {
  async onInit() {
    this._logBuffer = [];
    this._logSeq    = 0;
    this.log('MOVA Mower app started');
  }

  _pushLog(level, msg) {
    this._logSeq++;
    this._logBuffer.push({ seq: this._logSeq, ts: Date.now(), level, msg });
    if (this._logBuffer.length > MAX_LOG_ENTRIES) this._logBuffer.shift();
  }

  getLogs(since = 0) {
    if (!this._logBuffer) return [];
    return this._logBuffer.filter((e) => e.seq > since);
  }
}

module.exports = DreameApp;

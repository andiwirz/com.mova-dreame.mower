'use strict';

const Homey = require('homey');
const util = require('node:util');

const MAX_LOG_ENTRIES = 1000;

function formatLogArgs(args) {
  return args.map((value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    return util.inspect(value, { depth: 4, breakLength: 180, maxArrayLength: 40 });
  }).join(' ');
}

class DreameApp extends Homey.App {
  log(...args) {
    super.log(...args);
    if (this._logBuffer) this._pushLog('info', formatLogArgs(args));
  }

  error(...args) {
    super.error(...args);
    if (this._logBuffer) this._pushLog('error', formatLogArgs(args));
  }

  warn(...args) {
    if (typeof super.warn === 'function') super.warn(...args); else super.log(...args);
    if (this._logBuffer) this._pushLog('warn', formatLogArgs(args));
  }
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

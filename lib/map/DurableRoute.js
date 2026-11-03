'use strict';
const PEN = [32767, -32768];
const valid = p => Array.isArray(p) && p.length >= 2 && p[0] !== 32767 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const fingerprint = path => JSON.stringify(path || []);
class DurableRoute {
  constructor(saved) {
    this.data = saved?.schema === 1 && saved.maps && typeof saved.maps === 'object' ? saved : { schema: 1, maps: {} };
    this.seen = new Map();
  }
  entry(map) { return this.data.maps[String(map)]; }
  begin(map, { fresh = false, blockedPath = [] } = {}) {
    const key = String(map);
    if (fresh || !this.entry(map)) {
      this.data.maps[key] = { active: true, startedAt: Date.now(), path: [], blockedFingerprint: fingerprint(blockedPath) };
      this.seen.delete(key);
    } else this.entry(map).active = true;
    // Bound retained map history, never mix coordinates from different maps.
    const keys = Object.keys(this.data.maps);
    if (keys.length > 8) for (const old of keys.filter(k => k !== key).slice(0, keys.length - 8)) { delete this.data.maps[old]; this.seen.delete(old); }
  }
  _edges(map) {
    const key = String(map);
    if (!this.seen.has(key)) {
      const set = new Set(); let a = null;
      for (const b of this.entry(map)?.path || []) { if (!valid(b)) { a = null; continue; } if (a) set.add(`${a[0]},${a[1]}>${b[0]},${b[1]}`); a = b; }
      this.seen.set(key, set);
    }
    return this.seen.get(key);
  }
  ingest(map, path, { cloud = false } = {}) {
    const entry = this.entry(map);
    if (!entry?.active || !Array.isArray(path)) return;
    if (cloud && entry.blockedFingerprint === fingerprint(path)) return;
    const seen = this._edges(map); let a = null;
    for (const source of path) {
      if (!valid(source)) { a = null; continue; }
      const b = [Math.round(source[0]), Math.round(source[1])];
      if (a) {
        const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const edge = `${a[0]},${a[1]}>${b[0]},${b[1]}`;
        if (distance > 0 && distance <= 3000 && !seen.has(edge)) {
          // Extremely long sessions stop accumulating instead of deleting old lanes.
          if (entry.path.length >= 60000) { entry.capacityReached = true; break; }
          const last = entry.path.at(-1);
          if (!valid(last) || last[0] !== a[0] || last[1] !== a[1]) {
            if (entry.path.length) entry.path.push(PEN.slice());
            entry.path.push(a.slice());
          }
          entry.path.push(b); seen.add(edge);
        }
      }
      a = b;
    }
  }
  finish(map) { if (this.entry(map)) this.entry(map).active = false; }
  path(map) { return this.entry(map)?.path || []; }
  snapshot() { return JSON.parse(JSON.stringify(this.data)); }
}
module.exports = { DurableRoute };

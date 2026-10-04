'use strict';
// Owns one worker. Idle health never calls startWorker. All stop/start races
// await disposal before another SDK process may be created.
class CameraSession {
  constructor({ startWorker, now = Date.now, idleMs = 15000, maxMs = 15 * 60000, onState = () => {} }) {
    Object.assign(this, { startWorker, now, idleMs, maxMs, onState });
    this.state = 'off'; this.worker = null; this.generation = 0; this.startedAt = 0; this.lastClientAt = 0;
    this.leases = new Map(); this.error = null;
  }
  status() { return { state: this.state, error: this.error, startedAt: this.startedAt, clients: this.leases.size }; }
  touch(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('invalid client'); this.leases.set(id, this.now()); this.lastClientAt = this.now(); }
  async start(id, authorized) {
    if (this.error === 'camera_stop_failed') throw new Error('restart required after unconfirmed shutdown');
    if (authorized !== true) throw new Error('outside evidence required');
    if (this.stopping) await this.stopping;
    this.touch(id);
    if (this.state === 'live' || this.state === 'starting') return this.status();
    const generation = ++this.generation;
    this.state = 'starting'; this.error = null; this.startedAt = this.now(); this.onState(this.state);
    this.abortController = new AbortController();
    this.starting = (async () => {
      let worker;
      try {
        worker = await this.startWorker(this.abortController.signal);
        if (generation !== this.generation) { await worker.stop(); return; }
        this.worker = worker; this.state = 'live'; this.onState(this.state);
      } catch (error) { if (generation !== this.generation) { if (error?.code === 'CAMERA_ABORTED') return; throw error; } this.state = 'error'; this.error = error?.code === 'CAMERA_STOP_FAILED' ? 'camera_stop_failed' : 'camera_start_failed'; this.onState(this.state); }
    })();
    return this.status();
  }
  async release(id) { this.leases.delete(id); if (!this.leases.size) await this.stop(); return this.status(); }
  async stop() {
    if (this.stopping) return this.stopping;
    ++this.generation; this.state = 'stopping'; this.leases.clear(); this.abortController?.abort();
    this.stopping = (async () => {
      await this.starting;
      const worker = this.worker; this.worker = null;
      if (worker) await worker.stop();
      this.state = 'off'; this.error = null; this.onState(this.state);
    })();
    try { await this.stopping; } catch (_) { this.state = 'error'; this.error = 'camera_stop_failed'; throw new Error('camera stop failed'); }
    finally { this.stopping = null; }
  }
  async tick() {
    const now = this.now();
    for (const [id, at] of this.leases) if (now - at > this.idleMs) this.leases.delete(id);
    if (['live','starting'].includes(this.state) && (now - this.startedAt >= this.maxMs || (!this.leases.size && now - this.lastClientAt >= this.idleMs))) await this.stop();
  }
}
module.exports = { CameraSession };

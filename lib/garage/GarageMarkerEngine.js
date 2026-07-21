'use strict';

const DEFAULT_DANGER_RADIUS_MM = 1200;
const DEFAULT_DANGER_HYSTERESIS_MM = 250;
const DEFAULT_LINE_HYSTERESIS_MM = 250;
const DEFAULT_LINE_SEGMENT_MARGIN_MM = 500;
const DEFAULT_DANGER_STABLE_MS = 2000;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asPoint(value) {
  if (!value || typeof value !== 'object') return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  if (x === null || y === null) return null;
  return { x, y, ts: value.ts || 0 };
}

class GarageMarkerEngine {
  constructor(device, opts = {}) {
    this.device = device;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this._dangerInside = false;
    this._dangerPending = null;
    this._dangerPendingCount = 0;
    this._dangerPendingSince = 0;
    this._lineSide = null;
    this._linePending = null;
    this._linePendingCount = 0;
    this._linePendingSince = 0;
    this._lineRecentSamples = [];
  }

  position() {
    const p = typeof this.device._getBufferedLivePosition === 'function'
      ? this.device._getBufferedLivePosition(5000)
      : (this.device._livePos || null);
    return asPoint(p);
  }

  async dangerCenter() { return asPoint(await this.device.getStoreValue('garage_danger_center')); }
  async rawLineA() { return asPoint(await this.device.getStoreValue('garage_line_a')); }
  async rawLineB() { return asPoint(await this.device.getStoreValue('garage_line_b')); }

  async effectiveLine() {
    const a = await this.rawLineA();
    const b = await this.rawLineB();
    if (!a || !b) return { a, b };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // RC77: the stored A/B points are already native map coordinates captured
    // from the mower position. Do not rotate, offset or re-scale them here.
    // Map, robot, maintenance point and safety logic must use the same frame.
    if (!Number.isFinite(len) || len < 250) return { a: null, b: null, invalid: 'line_points_too_close' };
    return { a, b, invalid: null };
  }

  async lineA() { return (await this.effectiveLine()).a; }
  async lineB() { return (await this.effectiveLine()).b; }


  async directionState() {
    const { a, b } = await this.effectiveLine();
    const garage = await this.dangerCenter();
    if (!a || !b || !garage) return { known: false, garageSide: null, lawnSide: null, vector: null, midpoint: null };
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len = Math.hypot(vx, vy);
    if (!len) return { known: false, garageSide: null, lawnSide: null, vector: null, midpoint: null };
    const nx = -vy / len; // positive signed-distance normal
    const ny = vx / len;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const garageDistance = (garage.x - mx) * nx + (garage.y - my) * ny;
    // Danger-center is the authoritative garage side. If it is extremely close
    // to the line, keep a deterministic side instead of changing direction due
    // to RTK noise.
    const garageSide = garageDistance < 0 ? -1 : 1;
    const lawnSide = -garageSide;
    return {
      known: true,
      garageSide,
      lawnSide,
      midpoint: { x: mx, y: my },
      vector: { x: nx * lawnSide, y: ny * lawnSide }, // garage -> lawn
      garageDistance,
    };
  }

  dangerRadius() {
    const raw = finiteNumber(this.device.getSetting('garage_danger_radius_mm'));
    return raw && raw > 0 ? raw : DEFAULT_DANGER_RADIUS_MM;
  }

  dangerHysteresis() {
    const configured = finiteNumber(this.device.getSetting('garage_danger_hysteresis_mm'));
    return configured !== null && configured >= 0 ? configured : DEFAULT_DANGER_HYSTERESIS_MM;
  }

  lineHysteresis() {
    const configured = finiteNumber(this.device.getSetting('garage_line_hysteresis_mm'));
    return configured !== null && configured >= 0 ? configured : DEFAULT_LINE_HYSTERESIS_MM;
  }

  lineSegmentMargin() {
    const configured = finiteNumber(this.device.getSetting('garage_line_segment_margin_mm'));
    return configured !== null && configured >= 0 ? configured : DEFAULT_LINE_SEGMENT_MARGIN_MM;
  }

  async ready() {
    const danger = await this.dangerCenter();
    const a = await this.lineA();
    const b = await this.lineB();
    if (!danger || !a || !b) return false;
    if (a.x === b.x && a.y === b.y) return false;
    return this.dangerRadius() > 0;
  }

  async distanceToDangerCenter() {
    const c = await this.dangerCenter();
    const p = this.position();
    if (!c || !p) return null;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  async dangerState() {
    const distance = await this.distanceToDangerCenter();
    if (distance === null) return { known: false, inside: false, distance: null, radius: this.dangerRadius() };

    const radius = this.dangerRadius();
    const hysteresis = this.dangerHysteresis();
    let candidate = this._dangerInside;

    if (this._dangerInside) {
      if (distance > radius + hysteresis) candidate = false;
    } else if (distance <= radius) {
      candidate = true;
    }

    // Debounce RTK/GPS jitter at the circle edge. A danger state change must be
    // seen in at least three consecutive position updates before it becomes
    // visible to the garage state machine. This prevents inside/outside spam and
    // false emergency reversals near the boundary.
    if (candidate !== this._dangerInside) {
      if (this._dangerPending === candidate) this._dangerPendingCount += 1;
      else { this._dangerPending = candidate; this._dangerPendingCount = 1; this._dangerPendingSince = Date.now(); }
      if (this._dangerPendingCount >= 3 && Date.now() - this._dangerPendingSince >= DEFAULT_DANGER_STABLE_MS) {
        this._dangerInside = candidate;
        this._dangerPending = null;
        this._dangerPendingCount = 0;
        this._dangerPendingSince = 0;
      }
    } else {
      this._dangerPending = null;
      this._dangerPendingCount = 0;
      this._dangerPendingSince = 0;
    }

    return { known: true, inside: this._dangerInside, distance, radius, hysteresis, pending: this._dangerPending, pendingCount: this._dangerPendingCount };
  }

  async isInDangerArea() {
    return (await this.dangerState()).inside;
  }

  async signedDistanceToLine() {
    const a = await this.lineA();
    const b = await this.lineB();
    const p = this.position();
    if (!a || !b || !p) return null;

    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const length = Math.sqrt(vx * vx + vy * vy);
    if (!length) return null;

    // Safety-line crossing is only valid on the configured segment A–B plus a
    // small margin. Earlier builds used the infinite line which caused crossings
    // and danger chatter far away while mowing.
    const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / (length * length);
    const marginT = this.lineSegmentMargin() / length;
    const onSegment = t >= -marginT && t <= 1 + marginT;
    const cross = vx * (p.y - a.y) - vy * (p.x - a.x);
    return { distance: cross / length, t, onSegment, positionTs: p.ts || Date.now() };
  }

  async lineState() {
    const info = await this.signedDistanceToLine();
    if (info === null) return { known: false, side: null, distance: null, stable: false, onSegment: false };

    const { distance, t, onSegment, positionTs } = info;
    const hysteresis = this.lineHysteresis();
    const rawThreshold = Math.max(60, Math.min(hysteresis, 240) / 2);
    const rawSide = onSegment && Math.abs(distance) >= rawThreshold ? (distance > 0 ? 1 : -1) : null;
    let side = this._lineSide;
    let stable = false;
    const now = Date.now();

    // Keep a short fresh sample history. A side change is accepted only after two
    // consecutive fresh samples and at least 700 ms. Missing/invalid samples do
    // not erase the last stable side, so direction remains deterministic.
    this._lineRecentSamples.push({ ts: positionTs || now, distance, t, onSegment, rawSide });
    this._lineRecentSamples = this._lineRecentSamples.filter((x) => now - Number(x.ts || now) <= 12000).slice(-8);

    if (rawSide !== null && Math.abs(distance) >= hysteresis) {
      const candidate = rawSide;
      if (candidate !== this._lineSide) {
        if (this._linePending === candidate) this._linePendingCount += 1;
        else {
          this._linePending = candidate;
          this._linePendingCount = 1;
          this._linePendingSince = now;
        }
        if (this._linePendingCount >= 3 && now - this._linePendingSince >= 1200) {
          side = candidate;
          stable = true;
          this._lineSide = side;
          this._linePending = null;
          this._linePendingCount = 0;
          this._linePendingSince = 0;
        }
      } else {
        side = candidate;
        stable = true;
        this._linePending = null;
        this._linePendingCount = 0;
        this._linePendingSince = 0;
      }
    }

    const direction = await this.directionState();
    return { known: true, side, rawSide, distance, stable, hysteresis, rawThreshold, t, onSegment, expandedOnSegment: onSegment, segmentMargin: this.lineSegmentMargin(), pending: this._linePending, pendingCount: this._linePendingCount, positionTs, direction };
  }

  async currentLineSide() {
    return (await this.lineState()).side;
  }

  resetRuntime() {
    this._dangerInside = false;
    this._dangerPending = null;
    this._dangerPendingCount = 0;
    this._dangerPendingSince = 0;
    this._lineSide = null;
    this._linePending = null;
    this._linePendingCount = 0;
    this._linePendingSince = 0;
    this._lineRecentSamples = [];
  }

  async overlayData() {
    return {
      dangerCenter: await this.dangerCenter(),
      dangerRadius: this.dangerRadius(),
      dangerHysteresis: this.dangerHysteresis(),
      lineA: await this.lineA(),
      lineB: await this.lineB(),
      lineHysteresis: this.lineHysteresis(),
      lineDirection: await this.directionState(),
      lineSegmentMargin: this.lineSegmentMargin(),
    };
  }
}

module.exports = GarageMarkerEngine;

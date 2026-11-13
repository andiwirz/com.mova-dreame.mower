'use strict';
const { knownLearnedPoint, mapRevision } = require('./NativeAdditionalMaintenanceEvidence');

/**
 * Conservative native MAPI evidence for an explicitly selected P2-P5.
 * A visual map marker, a manually entered name, or an old arrival coordinate
 * is NOT proof that the mower still has that native target configured.
 * Neither this module nor the caller sends any mower command.
 */
function asPosition(value) {
  const p = value?.point || value?.position || value;
  if (!p) return null;
  const x = Array.isArray(p) ? p[0] : p.x;
  const y = Array.isArray(p) ? p[1] : p.y;
  if (x == null || y == null || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return null;
  return { x: Number(x), y: Number(y) };
}

function unwrap(input) {
  let obj = input;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch (_) { return null; }
    } else if (obj && typeof obj === 'object' && (obj.d != null || obj.data != null)) {
      obj = obj.d ?? obj.data;
    } else break;
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
}

function nativeMaintenanceIndexes(mapi) {
  const found = new Set();
  let evidence = false;
  const visited = new WeakSet();
  const add = (point, index) => {
    const n = Number(index);
    if (Number.isInteger(n) && n >= 1 && n <= 5 && asPosition(point)) found.add(n);
  };
  const inspectPointCollection = (value) => {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { return; }
    }
    if (Array.isArray(value)) {
      // A bare coordinate pair has no reliable manufacturer target index.
      for (const point of value) if (point && typeof point === 'object') {
        add(point, point.index ?? point.pointIndex ?? point.point_index ?? point.id);
      }
    } else if (value && typeof value === 'object') {
      for (const [key, point] of Object.entries(value)) {
        if (/^([1-5]|P[1-5]|point_[1-5])$/i.test(key))
          add(point, point?.index ?? point?.pointIndex ?? key.replace(/\D/g, ''));
      }
      for (const key of ['points', 'list', 'data', 'd']) if (value[key] != null) inspectPointCollection(value[key]);
    }
  };
  const scan = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { return; }
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      // Traverse manufacturer envelopes, not arbitrary coordinates.
      for (const item of value) if (item && typeof item === 'object') scan(item, depth + 1);
      return;
    }
    const collections = ['maintenancePoints', 'maintenancePointList', 'servicePoints', 'repairPoints',
      'maintenance_points', 'service_points'];
    for (const key of collections) if (Object.prototype.hasOwnProperty.call(value, key)) {
      evidence = true;
      inspectPointCollection(value[key]);
    }
    for (let index = 1; index <= 5; index++) for (const key of [
      `maintenancePoint${index}`, `maintenance_point_${index}`, `servicePoint${index}`,
    ]) if (Object.prototype.hasOwnProperty.call(value, key)) {
      evidence = true;
      add(value[key], index);
    }
    // Only follow known MAPI envelope properties, avoiding accidental matches
    // to an unrelated mowing zone/obstacle named 'point_2'.
    for (const key of ['d', 'data', 'result', 'out', 'map', 'mapData', 'metadata', 'markers']) {
      if (value[key] != null) scan(value[key], depth + 1);
    }
  };
  scan(mapi);
  return { indexes: [...found].sort((a, b) => a - b), evidence };
}

/** Return coordinates ONLY from a manufacturer-labelled maintenance-point field.
 * Generic map points, mowing boundaries and arbitrary ids must never qualify. */
function nativeMaintenancePosition(mapi, index) {
  if (!Number.isInteger(index) || index < 2 || index > 5) return null;
  const seen = new WeakSet();
  const parse = value => {
    if (typeof value === 'string') { try { return JSON.parse(value); } catch (_) { return null; } }
    return value;
  };
  const readCollection = input => {
    const value = parse(input);
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const n = Number(entry.index ?? entry.pointIndex ?? entry.point_index ?? entry.id);
        if (n === index) { const pos = asPosition(entry); if (pos) return pos; }
      }
    } else if (value && typeof value === 'object') {
      for (const key of [String(index), `P${index}`, `point_${index}`]) {
        if (Object.prototype.hasOwnProperty.call(value,key)) {
          const item = value[key];
          const n = item && typeof item === 'object' &&
            (item.index ?? item.pointIndex ?? item.point_index);
          if (n != null && Number(n) !== index) continue;
          const pos=asPosition(item);
          if (pos) return pos;
        }
      }
      for (const key of ['points', 'list', 'data', 'd']) if (value[key] != null) {
        const pos=readCollection(value[key]); if (pos) return pos;
      }
    }
    return null;
  };
  const scan = (input,depth=0) => {
    if (depth>6) return null;
    const value=parse(input);
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) { const pos=scan(entry,depth+1); if(pos)return pos; }
      return null;
    }
    for (const key of ['maintenancePoints','maintenancePointList','servicePoints','repairPoints',
      'maintenance_points','service_points']) if (value[key] != null) {
      const pos=readCollection(value[key]); if(pos)return pos;
    }
    for (const key of [`maintenancePoint${index}`, `maintenance_point_${index}`, `servicePoint${index}`]) {
      if (Object.prototype.hasOwnProperty.call(value,key)) {
        const pos=asPosition(value[key]); if(pos)return pos;
      }
    }
    for (const key of ['d','data','result','out','map','mapData','metadata','markers'])
      if (value[key] != null) { const pos=scan(value[key],depth+1); if(pos)return pos; }
    return null;
  };
  return scan(mapi);
}

/** Inspect partial native MAPI replies independently of garden-zone rendering.
 * This is observation only: it never creates or authorizes a point by itself. */
function maintenanceMapEvidence(raw, pointIndex) {
  const { indexes, evidence } = nativeMaintenanceIndexes(raw);
  const position = nativeMaintenancePosition(raw, pointIndex);
  return { indexes, evidence, position, shape: safeMAPIShape(raw) };
}

/** Log schema only, never actual coordinates, raw map data or credentials. */
function safeMAPIShape(raw) {
  const parts = [];
  let next = raw;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof next === 'string') {
      try { next = JSON.parse(next); } catch (_) { break; }
    }
    if (!next || typeof next !== 'object') break;
    const keys = Object.keys(next).slice(0, 24).filter(k => /^[a-zA-Z0-9_]{1,32}$/.test(k));
    parts.push(keys.join(','));
    next = next.d ?? next.data ?? next.result ?? next.out ?? next.map ?? null;
  }
  return parts.join(' > ').slice(0, 300);
}

async function checkMaintenancePoint({ point, getMAPI, mapIndex, learned = null }) {
  // P1 remains the tested backwards-compatible native maintenance command.
  if (point === 1) return { allowed: true, reason: 'native_p1' };
  if (!Number.isInteger(point) || point < 2 || point > 5) {
    return { allowed: false, reason: 'invalid' };
  }
  // A FRESH map read is required; stale cached map content can hide deletions.
  let raw;
  try { raw = await getMAPI(mapIndex); }
  catch (_) { return { allowed: false, reason: 'unverifiable' }; }
  if (!raw) return { allowed: false, reason: 'unverifiable', shape: 'empty' };
  const parsed = nativeMaintenanceIndexes(raw);
  if (parsed.indexes.includes(point)) return { allowed: true, reason: 'native_map_confirmed' };
  // An explicit, independently confirmed manufacturer P2/P3 visit can be a
  // bounded proof when the MAPI schema never lists additional service points.
  // A manufacturer map revision change always invalidates that observation.
  if (!parsed.evidence && knownLearnedPoint(learned, point, mapIndex, mapRevision(raw)))
    return { allowed: true, reason: 'native_arrival_confirmed' };
  return { allowed: false, reason: parsed.evidence ? 'not_configured' : 'unverifiable',
    shape: safeMAPIShape(raw) };
}

module.exports = { nativeMaintenanceIndexes, nativeMaintenancePosition, maintenanceMapEvidence, checkMaintenancePoint, safeMAPIShape };

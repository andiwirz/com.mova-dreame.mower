'use strict';

const SESSION_TRANSIENT_STATUSES = new Set([
  'mowing', 'edge_mowing', 'leaving', 'returning', 'paused', 'error', 'adjusting', 'positioning',
]);

const ROUTE_ACTIVE_STATUSES = new Set([
  'mowing', 'edge_mowing', 'leaving', 'returning', 'paused', 'error',
  'remote_control', 'adjusting', 'positioning',
]);

function isSessionTransientStatus(status) {
  return SESSION_TRANSIENT_STATUSES.has(String(status || '').toLowerCase());
}

function isRouteSessionActive(status) {
  return ROUTE_ACTIVE_STATUSES.has(String(status || '').toLowerCase());
}

function isChargeBreakContinuation(until, now = Date.now()) {
  const deadline = Number(until || 0);
  return Number.isFinite(deadline) && deadline > Number(now);
}

function compactRouteTrail(source, threshold = 1600) {
  if (!Array.isArray(source)) return [];
  if (source.length <= threshold) return source.slice();

  const compacted = [];
  let realIndex = 0;
  let lastRealIndex = -1;
  for (let i = source.length - 1; i >= 0; i--) {
    const pt = source[i];
    if (Array.isArray(pt) && pt.length >= 2 && pt[0] !== 32767) {
      lastRealIndex = i;
      break;
    }
  }
  for (let i = 0; i < source.length; i++) {
    const pt = source[i];
    if (!Array.isArray(pt) || pt.length < 2) continue;
    if (pt[0] === 32767) {
      if (compacted.length && compacted[compacted.length - 1][0] !== 32767) {
        compacted.push([32767, -32768]);
      }
      continue;
    }
    const keep = (realIndex++ % 2 === 0) || i === lastRealIndex;
    if (keep) compacted.push(pt);
  }
  while (compacted.length && compacted[compacted.length - 1][0] === 32767) compacted.pop();
  return compacted;
}

module.exports = {
  SESSION_TRANSIENT_STATUSES,
  ROUTE_ACTIVE_STATUSES,
  isSessionTransientStatus,
  isRouteSessionActive,
  isChargeBreakContinuation,
  compactRouteTrail,
};

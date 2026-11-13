'use strict';
/**
 * Core-inspired route eligibility gate. A stale/unknown position is not
 * a reliable reason to release a direct return toward a closed garage.
 * No motion is commanded by this module. The existing A–B interlock stays
 * responsible for actual stopping and release.
 */
const POSITION_MAX_AGE_MS = 15000;
function returnRouteEvidence(position, line, danger, now=Date.now()) {
  const ts=Number(position?.ts || 0);
  const physical=position && ['mqtt','siid:1:4'].includes(String(position.source || ''))
    && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))
    && ts > 0 && now >= ts && now-ts <= POSITION_MAX_AGE_MS;
  const lineTimestamp=Number(line?.positionTs || 0);
  const lineFresh=!lineTimestamp || now-lineTimestamp <= POSITION_MAX_AGE_MS;
  const side=line?.side ?? line?.rawSide ?? null;
  const lawn=line?.direction?.lawnSide ?? null;
  const clearance=Number(line?.distance);
  const safeLawnSide=physical && lineFresh && line?.known === true
    && side !== null && lawn !== null && side === lawn
    && Number.isFinite(clearance) && Math.abs(clearance) >= 1200;
  const safeDanger= danger?.known === true && danger.inside === false;
  return {physical:!!physical, safeLawnSide:!!safeLawnSide, safeDanger,
    directEligible:!!(safeLawnSide && safeDanger)};
}
module.exports={returnRouteEvidence,POSITION_MAX_AGE_MS};

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../widgets/map/public/index.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/i)?.[1];
assert.ok(script, 'inline widget script available');
const ctx = { navigator: { language: 'de-DE' } };
vm.createContext(ctx);
vm.runInContext(script, ctx, { filename: 'map-widget.js' });

const pattern = (route, tx = x => x, ty = y => y, ref = 10000, sw = 40) =>
  ctx.buildMowingPatternPaths(route, tx, ty, ref, sw);

const pathD = (svg, cls) => svg.match(new RegExp(`class="${cls}" d="([^"]+)"`))?.[1] || '';
const segmentCount = d => (d.match(/M/g) || []).length;

const base = {
  name: 'Testgarten', boundary: { x1: 0, y1: 0, x2: 10000, y2: 10000 },
  mowingAreas: [[1, { path: [{x: 100, y: 100}, {x: 9900, y: 100}, {x: 9900, y: 9900}, {x:100, y:9900}] }]],
  forbiddenAreas: [], spotAreas: [], contours: [],
  livePath: [
    [1000, 3000], [3000, 3000], [5000, 3000],
    [5000, 3400], [3000, 3400], [1000, 3400],
  ],
  robotPos: [1000, 3400], robotAngle: 270,
  garageOverlay: {}, overlayVisibility: { garageMode: false }
};

test('alternating mowing pattern renders opposite travel directions light and dark', () => {
  const svg = pattern(base.livePath);
  const light = pathD(svg, 'mowing-pattern-light');
  const dark = pathD(svg, 'mowing-pattern-dark');
  assert.ok(light, 'one travel direction has a bright path');
  assert.ok(dark, 'opposite travel direction has a darker path');
  assert.ok(segmentCount(light) >= 2);
  assert.ok(segmentCount(dark) >= 2);
});

test('turn connectors stay neutral instead of being mislabeled as mowing lanes', () => {
  const svg = pattern([[0,0],[2000,0],[2000,500],[0,500]]);
  const light = pathD(svg, 'mowing-pattern-light');
  const dark = pathD(svg, 'mowing-pattern-dark');
  assert.equal(segmentCount(light) + segmentCount(dark), 2, 'only the two horizontal mowing passes are overlaid');
});

test('sentinels, invalid points and >3m jumps never create a false mowing lane', () => {
  assert.equal(pattern([[0,0],[32767,-32768],[2000,0]]), '');
  assert.equal(pattern([[0,0],[5000,0]]), '');
  assert.equal(pattern([[0,0],[null,0],[2000,0]]), '');
  assert.equal(pattern([[0,0],[Infinity,0],[2000,0]]), '');
});

test('map transform changes only screen geometry, never source route ownership or order', () => {
  const track = [[0,0],[2000,0],[2000,500],[0,500]];
  const before = JSON.stringify(track);
  const normal = pattern(track);
  const mirrored = pattern(track, x => 4000 - x, y => 4000 - y);
  assert.match(normal, /mowing-pattern-light/);
  assert.match(mirrored, /mowing-pattern-light/);
  assert.match(mirrored, /mowing-pattern-dark/);
  assert.equal(JSON.stringify(track), before, 'read-only renderer must not mutate waypoints');
});

test('renderer shows persistent light/dark route pattern and no instantaneous heading arrow', () => {
  const yes = ctx.buildSvg(structuredClone(base), {show_path:true,show_direction:true});
  const noPattern = ctx.buildSvg(structuredClone(base), {show_path:true,show_direction:false});
  const noPath = ctx.buildSvg(structuredClone(base), {show_path:false,show_direction:true});
  assert.match(yes, /class="driven-route"/);
  assert.match(yes, /class="mowing-pattern-light"/);
  assert.match(yes, /class="mowing-pattern-dark"/);
  assert.doesNotMatch(yes, /route-direction-arrows/);
  assert.doesNotMatch(yes, /stroke="rgba\(76,175,80,0\.95\)"/, 'old current-heading line removed');
  assert.doesNotMatch(noPattern, /mowing-pattern-(?:light|dark)/);
  assert.doesNotMatch(noPath, /class="driven-route"/);
  assert.doesNotMatch(noPath, /mowing-pattern-(?:light|dark)/);
});

test('completed route and overlays survive the pattern renderer without mutation', () => {
  const data = structuredClone(base);
  data.livePath = [[0,0],[1000,0],[32767,-32768],[2000,0],[1000,0]];
  data.obstaclePylons = [{id:'pylon-1',x:3500,y:3500,rule:{action:'no_turn',radius:500}}];
  data.overlayVisibility.garageMode = true;
  data.garageOverlay = { lineA:{x:1000,y:1000},lineB:{x:3000,y:1000}, dangerCenter:{x:2000,y:2000}, dangerRadius:500,cautionRadius:1200};
  const old = JSON.stringify(data);
  const svg = ctx.buildSvg(data, {show_path:true,show_direction:true,show_obstacles:true,show_garage_overlay:true});
  assert.match(svg,/mowing-pattern-/);
  assert.match(svg,/fill="rgba\(255,152,0,\.88\)"/, 'unassigned pylon remains visible as a marker');
  assert.doesNotMatch(svg,/stroke="rgba\(255,152,0,\.95\)"/, 'unassigned pylon has no exclusion radius');
  assert.match(svg,/Gefahrenbereich/);
  assert.equal(JSON.stringify(data),old, 'read-only rendering must not mutate map or safety data');
});

test('mowing pattern uses broad lawn bands rather than thin white direction lines', () => {
  const svg=pattern([[0,0],[2000,0],[2000,500],[0,500]]);
  assert.match(svg,/stroke-width="480.00"/);
  assert.match(svg,/rgba\(164,205,137,0.90\)/);
  assert.match(svg,/rgba\(80,137,73,0.90\)/);
});

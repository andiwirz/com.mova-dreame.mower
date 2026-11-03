'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let buildSvgFn = null;

function getBuildSvg() {
  if (buildSvgFn) return buildSvgFn;
  const htmlPath = path.join(__dirname, '../../widgets/map/public/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script>\s*([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Map renderer script not found');
  const context = { navigator: { language: 'de-DE' }, console };
  vm.createContext(context);
  vm.runInContext(match[1], context, { filename: 'mower-map-renderer.js' });
  if (typeof context.buildSvg !== 'function') throw new Error('Map renderer unavailable');
  buildSvgFn = context.buildSvg;
  return buildSvgFn;
}

const SNAPSHOT_SETTINGS = Object.freeze({
  show_zones: true,
  show_forbidden: true,
  show_spots: true,
  show_robot: true,
  show_obstacles: true,
  show_garage_overlay: true,
  show_path: true,
  show_direction: true,
  show_maintenance_point: true,
});

function renderMapSnapshot(data) {
  if (!data || !data.boundary) return null;
  return getBuildSvg()(data, SNAPSHOT_SETTINGS);
}

module.exports = { renderMapSnapshot };

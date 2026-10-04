'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const overviewHtml = fs.readFileSync(path.join(root, 'widgets/overview/public/index.html'), 'utf8');
const overviewCss = fs.readFileSync(path.join(root, 'widgets/overview/public/style.css'), 'utf8');
const cameraCss = fs.readFileSync(path.join(root, 'widgets/camera/public/style.css'), 'utf8');
const mapHtml = fs.readFileSync(path.join(root, 'widgets/map/public/index.html'), 'utf8');
const overviewJs = fs.readFileSync(path.join(root, 'widgets/overview/public/dashboard.js'), 'utf8');
const compose = JSON.parse(fs.readFileSync(path.join(root, 'widgets/overview/widget.compose.json'), 'utf8'));

assert(!/<iframe\b/i.test(overviewHtml), 'overview must not embed a nested iframe');
assert(overviewHtml.includes('id="mapStatic"'), 'overview must use an inline static map container');
assert(overviewCss.includes('overflow:hidden;touch-action:auto'), 'overview root must not become an inner scroll view');
assert(cameraCss.includes('overflow:hidden;touch-action:auto'), 'camera root must not become an inner scroll view');
assert(mapHtml.includes('overflow: hidden; touch-action: auto;'), 'map root should be non-scrollable outside edit mode');
assert(overviewJs.includes("api('GET','/map-snapshot')"), 'overview must fetch map snapshot without iframe');
assert(overviewJs.includes("setActionStatus('Befehl wird gesendet …')"), 'overview must show immediate command feedback');
assert(compose.api.getMapSnapshot && compose.api.getMapSnapshot.path === '/map-snapshot', 'overview map snapshot API must be declared');
assert(!fs.existsSync(path.join(root, 'widgets/overview/public/map.html')), 'unused nested map iframe document must be removed');

console.log('mobile-scroll-v179: ok');

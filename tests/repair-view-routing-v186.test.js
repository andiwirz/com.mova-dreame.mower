'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('custom repair views are packaged in drivers/mower/repair', () => {
  for (const name of ['repair.html','map_editor.html','reauth.html']) {
    assert.equal(fs.existsSync(path.join(root, 'drivers/mower/repair', name)), true, name);
    assert.equal(fs.existsSync(path.join(root, 'drivers/mower/pair', name)), false, `repair view must not live in pair/: ${name}`);
  }
  const compose = JSON.parse(fs.readFileSync(path.join(root, 'drivers/mower/driver.compose.json'), 'utf8'));
  assert.deepEqual(compose.repair.map(v => v.id), ['repair','map_editor','reauth']);
});

test('repair selector routes to editor and reauth by manifest id', () => {
  const html = fs.readFileSync(path.join(root, 'drivers/mower/repair/repair.html'), 'utf8');
  assert.match(html, /Homey\.showView\('map_editor'\)/);
  assert.match(html, /Homey\.showView\('reauth'\)/);
});

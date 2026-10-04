
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

for (const name of ['repair.html','map_editor.html','reauth.html']) {
  test(`repair custom view ${name} is an injectable fragment`, () => {
    const html = fs.readFileSync(path.join(root,'drivers/mower/repair',name),'utf8');
    assert.doesNotMatch(html, /<!DOCTYPE/i);
    assert.doesNotMatch(html, /<html\b/i);
    assert.doesNotMatch(html, /<head\b/i);
    assert.doesNotMatch(html, /<body\b/i);
  });
}

test('map editor initializes after injection instead of waiting for DOMContentLoaded', () => {
  const html = fs.readFileSync(path.join(root,'drivers/mower/repair/map_editor.html'),'utf8');
  assert.doesNotMatch(html, /DOMContentLoaded/);
  assert.match(html, /setTimeout\(initRepairMap,\s*0\)/);
  assert.match(html, /Homey\.emit\('get_map_editor_data'\)/);
});

test('repair selector contains visible map and reconnect actions', () => {
  const html = fs.readFileSync(path.join(root,'drivers/mower/repair/repair.html'),'utf8');
  assert.match(html, /Mähkarte bearbeiten/);
  assert.match(html, /Verbindung neu anmelden/);
  assert.match(html, /Homey\.showView\('map_editor'\)/);
});

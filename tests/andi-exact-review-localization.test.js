'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('all DE/EN locale keys and substitution tokens match after remaining error translations', () => {
  const flatten = (x, prefix = '', out = {}) => { for (const [k,v] of Object.entries(x)) { const key = prefix ? prefix+'.'+k : k; if (typeof v === 'object') flatten(v,key,out); else out[key]=v; } return out; };
  const de = flatten(JSON.parse(fs.readFileSync('locales/de.json', 'utf8')));
  const en = flatten(JSON.parse(fs.readFileSync('locales/en.json', 'utf8')));
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  for (const k of Object.keys(de)) {
    assert.ok(de[k].trim() && en[k].trim(), k);
    assert.deepEqual((de[k].match(/__\w+__/g)||[]).sort(), (en[k].match(/__\w+__/g)||[]).sort(), k);
  }
});

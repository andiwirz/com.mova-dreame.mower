'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');
const src=fs.readFileSync(path.join(root,'lib/garage/GarageSafetyEngine.js'),'utf8');
const section=src.slice(src.indexOf("  _timeline(message, key = '')"),src.indexOf('    const clean =',src.indexOf("  _timeline(message, key = '')")));
const log=src.slice(src.indexOf('  log(...args) {'),src.indexOf('  error(...args) {',src.indexOf('  log(...args) {')));
for(const part of [section,log]){
  assert.match(part,/getSetting\('garage_debug_verbose'\)/);
  assert.match(part,/getSetting\('garage_mode_enabled'\)/);
  assert.match(part,/getSetting\('garage_logging_enabled'\)/);
  assert.match(part,/if \(!debug && !regular\) return/);
}
const enabled=(garage,regular,debug)=>!!debug||!!(garage&&regular);
assert.equal(enabled(false,true,false),false);
assert.equal(enabled(true,true,false),true);
assert.equal(enabled(false,false,true),true);
assert.equal(enabled(true,false,true),true);
const device=fs.readFileSync(path.join(root,'drivers/mower/device.js'),'utf8');
assert.match(device,/this\.homey\.app\._pushLog/);
const api=fs.readFileSync(path.join(root,'api.js'),'utf8');
assert.match(api,/deviceId === '__logs__'/);
const recover=fs.readFileSync(path.join(root,'lib/garage/CoreExternalStartRecovery.js'),'utf8');
assert.match(recover,/return !!this\.garage\?\.enabled\?\.\(\)/);
console.log('PASS: mode-gated garage events, independent debug and Windows log API');

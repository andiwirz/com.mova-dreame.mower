'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const editors=['widgets/map/public/index.html','widgets/overview/public/map-editor.html','drivers/mower/repair/map_editor.html'];

test('UI release has one aligned version and bilingual changelog in package and manifests',()=>{
 const files=['package.json','package-lock.json','.homeycompose/app.json','app.json'].map(f=>JSON.parse(read(f)));
 const version=files[0].version;
 for(const file of files)assert.equal(file.version,version);
 const log=JSON.parse(read('.homeychangelog.json'))[version];
 assert.ok(log.de&&log.en);
 assert.deepEqual(files[3].changelog[version],log);
});

test('All map variants use a short status and an accessible full-status info control',()=>{
 for(const file of editors){
  const html=read(file);
  assert.match(html,/id="footer-info"/);
  assert.match(html,/footerText\.textContent=t\('Map','Karte'\)\+' · '\+ts/);
  assert.match(html,/infoButton\._fullStatus=fullMapStatus/);
  assert.match(html,/\('footer-info'\)\.addEventListener\('click'/);
  assert.match(html,/Mowing completed in Homey/);
  assert.doesNotMatch(html,/#footer\s*\{[^}]*overflow:\s*hidden\s*;/);
 }
});

test('All map variants restrict waypoint edits to Edit mode including touch label fallback',()=>{
 for(const file of editors){
  const html=read(file);
  assert.match(html,/if \(!_editMode \|\| _editMarkersHidden\) return;/);
  assert.match(html,/svg\.editing \[data-maintenance-hit-index\]/);
  assert.match(html,/svg:not\(\.editing\) \[data-maintenance-hit-index\]/);
  assert.match(html,/svg\.editing \[data-pylon-id\]/);
  assert.match(html,/svg\.editing \[data-native-zone-id\]/);
  assert.match(html,/Anzeige vereinfachen/);
  assert.match(html,/\['edit-btn','Edit','Bearbeiten'\]|t\('Edit','Bearbeiten'\)/);
 }
});

test('Repair language preference is device-local, Homey-first and user-switchable',()=>{
 const html=read('drivers/mower/repair/repair.html');
 assert.match(html,/repair-language-de/);
 assert.match(html,/repair-language-en/);
 assert.match(html,/localStorage\.setItem\('mova\.repair\.uiLanguage'/);
 assert.match(html,/set_repair_ui_language/);
 assert.match(read('drivers/mower/driver.js'),/session\.setHandler\('set_repair_ui_language'/);
 assert.match(html,/return override\|\|homeyLanguage\|\|serverLanguage/);
 assert.match(html,new RegExp('UI '+JSON.parse(read('package.json')).version.replace(/\./g,'\\.')));
 for(const file of ['garage_settings','maintenance_settings','map_editor','reauth'])
  assert.match(read(`drivers/mower/repair/${file}.html`),/localStorage\.getItem\('mova\.repair\.uiLanguage'\)/);
});

test('Safety reset is inside diagnosis section without competing accordion',()=>{
 const html=read('drivers/mower/repair/garage_settings.html');
 const marker=html.indexOf('id="marker-diagnostics-panel"');
 const reset=html.indexOf('id="reset"');
 const end=html.indexOf('</div></details>',marker);
 assert.ok(marker>=0&&reset>marker&&reset<end);
 assert.doesNotMatch(html,/details class="reset-section"/);
 assert.match(html,/if\(!confirm\(labels\.confirm\)\)return/);
 assert.match(html,/reset_garage_markers/);
});

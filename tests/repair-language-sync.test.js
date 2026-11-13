const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const repair=path.join(__dirname,'../drivers/mower/repair');
const backend=fs.readFileSync(path.join(__dirname,'../drivers/mower/driver.js'),'utf8');
test('repair session exposes language get/set independent from localStorage',()=>{
  assert.match(backend,/session\.setHandler\('set_repair_ui_language'/);
  assert.match(backend,/session\.setHandler\('get_repair_ui_language'/);
  assert.match(backend,/repairUiLanguage = language/);
  assert.match(backend,/this\.homey\?\.i18n\?\.getLanguage/);
});
for(const view of ['repair.html','reauth.html','maintenance_settings.html']){
  test(`${view} loads and publishes a shared repair language`,()=>{
    const html=fs.readFileSync(path.join(repair,view),'utf8');
    assert.match(html,/repairEmit\('get_repair_ui_language',\{\}\)/);
    assert.match(html,/repairEmit\('set_repair_ui_language',\{language:l\}\)/);
    assert.match(html,/restoreRepairLanguage\(\)/);
    assert.match(html,/await languagePending/);
    assert.match(html,/data-repair-view=/);
    assert.match(html,/viewAll\('\[data-de\]'\)/);
    for(const label of ['Connection','Maintenance points','Verbindung','Wartungspunkte'])assert(html.includes(label));
  });
}

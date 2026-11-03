const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
test('external-start finally preserves pending waypoint chooser',()=>{assert.match(src,/if \(!\(this\._externalStartRecoveryPhase === 'MANUAL_REISSUE_REQUIRED'[\s\S]*?this\._externalMaintenanceSelectionRequiredAt/);});
test('mandatory notice flows ignore optional garage switch',()=>{assert.match(src,/\['emergency', 'safety_block', 'maintenance_selection_required', 'gate_open_unconfirmed'\]/);assert.match(src,/_garageNotice\('maintenance_selection_required'/);assert.match(src,/_garageNotice\('emergency'/);});

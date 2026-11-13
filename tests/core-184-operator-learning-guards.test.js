'use strict';
const assert = require('node:assert/strict');
const {canConfirmCoreOperatorArrival} = require('../lib/garage/CoreOperatorArrivalProof');
const base={operatorConfirmed:true,explicitNativeIndex:false,sawTransit:true,nativeCode:2,faultCode:75,mowerStatus:'idle',taskAgeMs:23000,mapMatch:true,positionStable:true,p1Separated:true,hasContradictoryIndexedMap:false,conflictsWithOtherPoint:false,docked:false};
assert.equal(canConfirmCoreOperatorArrival(base), true);
for (const [key,val] of Object.entries({operatorConfirmed:false,sawTransit:false,nativeCode:5,faultCode:50,mowerStatus:'mowing',taskAgeMs:1000,mapMatch:false,positionStable:false,p1Separated:false,hasContradictoryIndexedMap:true,conflictsWithOtherPoint:true,docked:true})) {
 const test={...base,[key]:val};
 if(key==='operatorConfirmed')test.explicitNativeIndex=false;
 assert.equal(canConfirmCoreOperatorArrival(test),false,`${key} must prevent commit`);
}
assert.equal(canConfirmCoreOperatorArrival({...base,operatorConfirmed:false,explicitNativeIndex:true}),true,'explicit OEM point may qualify');
assert.equal(canConfirmCoreOperatorArrival({...base,operatorConfirmed:false,explicitNativeIndex:false}),false,'ambiguous OEM 109 must never learn');
console.log('PASS: operator binding, native transit, status 2/75, mapping and geometry guards');

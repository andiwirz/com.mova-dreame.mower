'use strict';
const DOCK_STATES = ['IN_STATION','OUT_OF_STATION','PAUSE_DOCKING','FINISH_DOCKING','DOCKING_FAILED','DOCKING_IN_BASE'];
function decodeNativeDockFrame(value){
  const bytes = Array.isArray(value) ? value : (Buffer.isBuffer(value)? [...value]:null);
  if(!bytes || bytes.length < 20 || bytes[0] !== 0xce || bytes[19] !== 0xce) return null;
  const byte=Number(bytes[14]);const code=(byte >> 2)&7;
  return {dockingCode:code,dockingState:DOCK_STATES[code]||`UNKNOWN_${code}`,undocking:(byte>>6)&1,
    locationState:byte&3,chargingLive:(Number(bytes[11])&0x80)!==0};
}
module.exports={decodeNativeDockFrame};

'use strict';
const crypto=require('node:crypto');
// Dreamehome Android 2.5.8.1 app-level decoding, as documented by the
// independent HA reference. Never print or persist decrypted credentials.
const KEY=Buffer.from('EETjszu*XI5znHsI','utf8');
function decode(value){
  if(typeof value!=='string')return null;
  const text=value.trim().replace(/^0x/i,'');
  if(!/^(?:[0-9a-f]{2})+$/i.test(text) || text.length%32)return null;
  try {
    const decipher=crypto.createDecipheriv('aes-128-cbc',KEY,KEY);
    decipher.setAutoPadding(false);
    const output=Buffer.concat([decipher.update(Buffer.from(text,'hex')),decipher.final()]);
    const decoded=output.toString('utf8').replace(/\x00+$/g,'');
    if(decoded.includes('\ufffd'))return null;
    return decoded.split('|',1)[0]||null;
  } catch (_){return null;}
}
function deriveTxVideoAppCredentials(secretId,secretKey){
  return {appId:decode(secretId),appSecret:decode(secretKey)};
}
module.exports={deriveTxVideoAppCredentials};

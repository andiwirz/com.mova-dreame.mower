'use strict';
// Productive TX-video request contract reconstructed from the original
// Dreamehome Android TX bridge. getTxRtcInfo serializes exactly {did, os}
// and the repository supplies the literal Android platform marker.
// Account/video authentication belongs to the HTTP/interceptor profile, not
// to extra speculative fields in the identity JSON body.
const VIDEO_TOKEN_PATH='/dreame-third-video/tx/user/accesstoken';
const VIDEO_IDENTITY_PATH='/dreame-third-video/tx/mgr/dev/getIdentity';
const VIDEO_OS='android';
const VIDEO_TOKEN_OS=1;
function validateDid(did){
  if ((typeof did!=='string' && typeof did!=='number') || !String(did).trim() ||
      String(did).length>128 || /[\x00-\x1f\x7f]/.test(String(did)))
    throw new TypeError('Device ID must be a nonempty bounded scalar');
  return String(did);
}
function videoTokenBody(){ return {os:VIDEO_TOKEN_OS}; }
function videoIdentityBody(did){ return {did:validateDid(did),os:VIDEO_OS}; }
module.exports={VIDEO_TOKEN_PATH,VIDEO_IDENTITY_PATH,VIDEO_OS,VIDEO_TOKEN_OS,videoTokenBody,videoIdentityBody};

'use strict';
// Exactly one read-only HTTP request to the SDK's local FLV delegate. Do not
// expose the delegate URL: its query can contain ephemeral tokens/signatures.
const http = require('node:http');

function localDelegateUrl(payload) {
  const lines=String(payload||'').replace(/\0/g,'').trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const candidate=lines.find(s=>/^http:\/\/127\.0\.0\.1:\d+\//i.test(s));
  if(!candidate) throw new Error('delegate URL missing or not loopback');
  let url;
  try { url=new URL(candidate); } catch (_) { throw new Error('delegate URL malformed'); }
  if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || !/^[1-9]\d{0,4}$/.test(url.port) ||
     Number(url.port)>65535 || url.username || url.password || url.hash ||
     !url.pathname.endsWith('/ipc.flv') || !url.pathname.startsWith('/app.xnet/'))
    throw new Error('delegate URL outside SDK loopback FLV endpoint');
  if(url.searchParams.get('action')!=='live' || url.searchParams.get('channel')!=='0' ||
     url.searchParams.get('quality')!=='high' || url.searchParams.get('_crypto')!=='on')
    throw new Error('delegate FLV action/channel/quality/crypto mismatch');
  return url;
}

function receiveDelegatedFlv(worker, {httpModule=http, timeoutMs=15000}={}) {
  const url=localDelegateUrl(worker?.payload);
  return new Promise(resolve=>{
    let complete=false, req=null, res=null, bytes=0, head=Buffer.alloc(0), status=0;
    const finish=(ok,reason)=>{
      if(complete)return;complete=true;clearTimeout(timer);
      if(res&&!res.destroyed)res.destroy();
      if(req&&!req.destroyed)req.destroy();
      resolve({ok,status,totalBytes:bytes,first:head.subarray(0,3),first3Hex:head.length?head.toString('hex'):'none',reason});
    };
    const timer=setTimeout(()=>finish(false,'delegate_timeout'),timeoutMs);
    try {
      req=httpModule.get(url,{agent:false,headers:{Accept:'video/x-flv'}},response=>{
        res=response;status=Number(response.statusCode||0);
        // The signed local URL must not be followed to another host.
        if(status!==200)return finish(false,`delegate_http_${status}`);
        response.on('data',chunk=>{
          bytes+=chunk.length;
          if(head.length<3)head=Buffer.concat([head,chunk.subarray(0,3-head.length)]);
          if(head.length===3){
            const verified=head.equals(Buffer.from('FLV'));
            finish(verified,verified?'flv_header':'not_flv');
          }
        });
        response.on('end',()=>finish(false,'delegate_ended_no_flv'));
        response.on('error',()=>finish(false,'delegate_response_error'));
      });
      if(typeof req.setTimeout==='function')req.setTimeout(timeoutMs,()=>finish(false,'delegate_socket_timeout'));
      req.on('error',()=>finish(false,'delegate_connection_error'));
    } catch (_) { finish(false,'delegate_request_error'); }
  });
}
module.exports={localDelegateUrl,receiveDelegatedFlv};

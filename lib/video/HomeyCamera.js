'use strict';
const http=require('node:http'),crypto=require('node:crypto');
const {CameraSession}=require('./CameraSession');const {FlvH264}=require('./FlvH264');const {localDelegateUrl}=require('./LocalDelegate');
const CAMERA_OUTSIDE_REQUIRED='Livekamera ist nur außerhalb der Ladestation verfügbar. Bitte den Mäher zuerst aus der Station fahren lassen.';

class HomeyCamera {
 constructor(device,video){this.device=device;this.video=video;this.streams=new Set();this.demux=null;this.token=crypto.randomBytes(24).toString('base64url');this.server=null;this.timer=null;this.nativeReleaseTimer=null;this.failureMessage=null;this.diagnosticReleaseTimer=null;this.diagnosticHeartbeat=null;
  this.session=new CameraSession({startWorker:signal=>this.open(signal),idleMs:45000,onState:state=>{this.device.log(`[video-native] session state=${state}`);if(['off','error'].includes(state)){clearInterval(this.timer);this.timer=null;this.demux=null;for(const r of this.streams)r.end();}}});
 }
 outsideEvidence(){const d=this.device,now=Date.now(),age=now-Number(d._mowerBinaryDiagAt||0);if(age>=0&&age<=15000&&d._mowerBinaryDiag?.dockingState==='OUT_OF_STATION')return now;if(age>=0&&age<=15000&&d._mowerBinaryDiag?.dockingState==='IN_STATION')return null;const e=d._garageSafety,p=e?.pos?.(),a=now-Number(p?.ts||0);if(!p?.ts||a<0||a>30000||!e)return null;const mission=!!e.isMissionOutside?.()||!!e._lineToLawnConfirmed||e._homeState==='away'||e._homeState==='adjusting';if(!mission)return null;const dock=d._dockPos;const dockDistance=dock&&Number.isFinite(Number(dock.x))&&Number.isFinite(Number(dock.y))?Math.hypot(Number(p.x)-Number(dock.x),Number(p.y)-Number(dock.y)):null;const native=String(d._nativeMowerStatus||d.getCapabilityValue?.('mower_status')||'').toLowerCase();const stateOutside=['mowing','paused','remote_control','mapping','leaving','adjusting','positioning','returning'].includes(native);if(e._lineToLawnConfirmed||e._outbound?.dockLeftAt||e._homeState==='away'||stateOutside||(Number.isFinite(dockDistance)&&dockDistance>=1500))return now;return null;}
 async control(action,client='device_camera',options={}){if(!/^[A-Za-z0-9_-]{1,80}$/.test(client))throw Error('Ungültige Kameraansicht');this.device.log(`[video-native] control action=${action} client=${client}`);
  if(action==='stop')return this.session.release(client);
  if(action==='health')return{...this.session.status(),message:this.failureMessage};
  if(!this.device.getSetting('video_enabled'))throw Error('Live Video in den Mähereinstellungen aktivieren');
  if(action==='start'){if(!this.outsideEvidence())throw Error(CAMERA_OUTSIDE_REQUIRED);if(!this.timer){this.timer=setInterval(()=>this.session.tick().catch(()=>{}),1000);this.timer.unref?.();}return this.session.start(client,true);}
  if(action==='snapshot'){if(!this.session.leases.has(client))throw Error('Kameraansicht ist ausgeschaltet');this.session.touch(client);return{...this.session.status(),message:this.failureMessage,...(this.demux?.snapshot(Number(options.cursor)||0)||{frames:[],cursor:0,config:null})};}
  throw Error('Ungültiger Kamerabefehl');
 }
 async open(signal){this.failureMessage=null;this._firstFrameLogged=false;this.device.log('[video-native] upstream open requested');let req,res,closed=false;const close=async()=>{if(closed)return;closed=true;req?.destroy();res?.destroy();await this.video.stopNative();};
  const aborted=()=>{const e=Error('Kamerastart abgebrochen');e.code='CAMERA_ABORTED';return e;};
  try{
   const url=await this.video.openNative(signal);if(signal.aborted){await close();throw aborted();}
   this.demux=new FlvH264(tag=>{for(const client of this.streams){if(client.writableLength>512*1024){client.destroy();continue;}client.write(tag);}});
   await new Promise((resolve,reject)=>{
    const abort=()=>{req?.destroy();reject(aborted());};signal.addEventListener('abort',abort,{once:true});
    const done=()=>{clearTimeout(timeout);signal.removeEventListener('abort',abort);};
    const fail=()=>{done();this.device.error('[video-native] upstream FLV interrupted');reject(Error('Lokaler Kamerastream unterbrochen'));if(!closed)this.session.stop().catch(err=>this.device.error('[video-native] session stop after upstream interrupt failed:',err.message));};
    const timeout=setTimeout(()=>{req?.destroy();done();reject(Error('Kein Kamerabild innerhalb von 20 Sekunden'));},20000);
    req=http.get(localDelegateUrl(url),{agent:false,headers:{Accept:'video/x-flv'}},response=>{res=response;if(res.statusCode!==200){res.resume();done();reject(Error('Lokaler Kamerastream nicht bereit'));return;}
     res.on('data',chunk=>{try{this.demux?.push(chunk);if(this.demux?.frames.length){if(!this._firstFrameLogged){this._firstFrameLogged=true;this.device.log('[video-native] first video frame received');}done();resolve();}}catch(err){this.device.error('[video-native] demux error:',err.message);done();reject(Error('Kameraformat nicht unterstützt'));req.destroy();if(!closed)this.session.stop().catch(()=>{});}});
     res.on('end',fail);res.on('error',fail);
    });req.on('error',err=>{done();this.device.error('[video-native] upstream request error:',err?.message||String(err));reject(Error('Lokaler Kamerastream nicht erreichbar'));if(!closed)this.session.stop().catch(stopErr=>this.device.error('[video-native] session stop after request error failed:',stopErr.message));});
   });return{stop:close};
  }catch(error){
   const message=String(error?.message||'');
   this.failureMessage=/Identität|identity/i.test(message)?'Kameraidentität wurde von Dreame/MOVA nicht nativ bereitgestellt. Bitte das Homey-App-Log ab [video-xp2p] prüfen.':/unsupported Homey host.*x64/i.test(message)?'Kamera in dieser x64-Testlaufzeit nicht verfügbar. Bitte die App auf dem Homey Pro installieren und dort testen; die Kameralaufzeit benötigt Linux/arm64.':/unsupported Homey host|page size/i.test(message)?'Diese Homey-Laufzeit unterstützt die mitgelieferte Kamera-Binärdatei nicht.':'Kamerastart auf Homey fehlgeschlagen. Verbindung, Kameraeinstellungen und Laufzeitdiagnose prüfen.';
   await close();if(signal.aborted)throw aborted();throw error;
  }
 }
 async _ensureRelayServer(){
  if(this.server)return;
  const server=http.createServer((req,res)=>{
   const flvPath=`/t/${this.token}/camera.flv`;
   const method=String(req.method||'GET').toUpperCase();
   let pathname='';try{pathname=new URL(req.url||'/','http://homey.local').pathname;}catch(_){pathname='';}
   const route=pathname===flvPath?'flv':'unknown';
   const methodAllowed=method==='GET'||method==='HEAD';
   const active=!!this.demux&&this.session.leases.size>0;
   if(!methodAllowed||route==='unknown'||!active){const reason=!methodAllowed?'non_get_head':route==='unknown'?'path_mismatch':'no_active_lease';this.device.log(`[video-native] relay rejected route=${route} reason=${reason} method=${method}`);res.writeHead(403,{'cache-control':'no-store'});res.end();return;}
   res.writeHead(200,{'content-type':'video/x-flv','cache-control':'no-store','access-control-allow-origin':'*'});
   if(method==='HEAD'){res.end();return;}
   const initial=this.demux.initial();if(initial)res.write(initial);this.streams.add(res);this.device.log(`[video-native] player connected clients=${this.streams.size}`);clearTimeout(this.nativeReleaseTimer);this.nativeReleaseTimer=null;
   const heartbeat=setInterval(()=>{if(this.session.leases.has('device_camera'))this.session.touch('device_camera');if(this.session.leases.has('flv_diag'))this.session.touch('flv_diag');if(!this.session.leases.size)res.end();},2000);
   res.on('close',()=>{clearInterval(heartbeat);this.streams.delete(res);this.device.log(`[video-native] player disconnected clients=${this.streams.size}`);if(!this.streams.size){clearTimeout(this.nativeReleaseTimer);this.nativeReleaseTimer=setTimeout(()=>{this.nativeReleaseTimer=null;if(!this.streams.size){this.device.log('[video-native] no player connection after grace; releasing native lease');this.session.release('device_camera').catch(err=>this.device.error('[video-native] release failed:',err.message));}},30000);this.nativeReleaseTimer.unref?.();}});
  });
  this.server=server;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve);});
 }
 _relayUrl(){const host=this.video._selectRelayHost();if(!host)throw Error('Keine private Homey-LAN-Adresse gefunden');return`http://${host}:${this.server.address().port}/t/${this.token}/camera.flv`;}
 async nativeUrl(){if(this.nativePromise)return this.nativePromise;this.nativePromise=this._nativeUrl();try{return await this.nativePromise;}finally{this.nativePromise=null;}}
 async _nativeUrl(){this.device.log('[video-native] Homey requested stream URL');await this.control('start','device_camera');const heartbeat=setInterval(()=>{if(this.session.leases.has('device_camera'))this.session.touch('device_camera');},2000);try{await this.session.starting;}finally{clearInterval(heartbeat);}if(this.session.state!=='live')throw Error(this.failureMessage||'Kamera konnte auf Homey nicht gestartet werden');await this._ensureRelayServer();return{url:this._relayUrl()};}
 async diagnosticUrl(ttlMs=120000){const ttl=Math.max(30000,Math.min(300000,Number(ttlMs)||120000));await this.control('start','flv_diag');if(this.session.starting)await this.session.starting;if(this.session.state!=='live')throw Error(this.failureMessage||'Kamera konnte für den FLV-Test nicht gestartet werden');this.session.touch('flv_diag');clearTimeout(this.diagnosticReleaseTimer);clearInterval(this.diagnosticHeartbeat);this.diagnosticHeartbeat=setInterval(()=>{if(this.session.leases.has('flv_diag'))this.session.touch('flv_diag');},10000);this.diagnosticHeartbeat.unref?.();this.diagnosticReleaseTimer=setTimeout(()=>{this.diagnosticReleaseTimer=null;clearInterval(this.diagnosticHeartbeat);this.diagnosticHeartbeat=null;this.session.release('flv_diag').catch(err=>this.device.error('[video-native] FLV diagnostic lease release failed:',err.message));},ttl);this.diagnosticReleaseTimer.unref?.();await this._ensureRelayServer();return{url:this._relayUrl(),expiresInSeconds:Math.round(ttl/1000)};}
 async stop(){clearInterval(this.timer);this.timer=null;clearTimeout(this.nativeReleaseTimer);this.nativeReleaseTimer=null;clearTimeout(this.diagnosticReleaseTimer);this.diagnosticReleaseTimer=null;clearInterval(this.diagnosticHeartbeat);this.diagnosticHeartbeat=null;await this.session.stop();if(this.server){const s=this.server;this.server=null;s.closeAllConnections?.();await new Promise(r=>s.close(r));}}
}
module.exports={HomeyCamera};

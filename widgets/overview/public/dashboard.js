let H,id,client,active=false,inView=true,timer=null,mapTimer=null,frameTimer=null,offscreenTimer=null,busy=false,epoch=0,mapEditing=false;
let decoder=null,codecVersion=0,cursor=0,canvasCtx=null,canvasW=0,canvasH=0,lastOverviewStatus='unknown',lastPaintAt=0,consecutiveErrors=0,decoderErrors=0;
const $=id=>document.getElementById(id);
const labels={open:'Offen',closed:'Geschlossen',opening:'Öffnet',closing:'Schließt',unknown:'Endlage unbestätigt',mowing:'Mäht',paused:'Pausiert',returning:'Rückkehr',docked:'Gedockt',charging:'Lädt',idle:'Bereit',standby:'Bereit',garage_home:'Zuhause',garage_start_pending:'Startbefehl wird ausgeführt',garage_exiting:'Ausfahrt',garage_adjusting:'Justieren',garage_positioning:'Positionieren',garage_maintenance_transit:'Zum Wartungspunkt',garage_maintenance_reached:'Wartungspunkt erreicht'};
const activeMapStatuses=new Set(['mowing','edge_mowing','leaving','returning','paused','remote_control','mapping','garage_exiting','garage_adjusting','garage_positioning','garage_maintenance_transit']);
const api=(method,path,body={})=>H.api(method,path+(path.includes('?')?'&':'?')+'deviceId='+encodeURIComponent(id),body);
function resizeWidget(){const height=Math.ceil(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight));if(H&&height>0&&height!==resizeWidget.last){resizeWidget.last=height;H.setHeight?.(height);}}resizeWidget.last=0;
function diagnostic(stage,message=''){if(!H||!id)return;api('POST','/camera',{action:'diagnostic',client,stage,message:String(message||'').slice(0,220)}).catch(()=>{});}
function showError(e){$('error').textContent=e?.message||String(e);resizeWidget();}
function clearError(){$('error').textContent='';}
function showCameraError(e,stage='ui'){const msg=e?.message||String(e);const el=$('cameraError');if(el)el.textContent=msg;diagnostic(stage,msg);resizeWidget();}
function clearCameraError(){const el=$('cameraError');if(el)el.textContent='';}
function cameraLabel(text){$('cameraState').textContent=text;$('placeholder').textContent=text;}
function setActionStatus(text,isError=false){const el=$('actionStatus');if(!el)return;el.textContent=text||'';el.classList.toggle('error-state',!!isError);resizeWidget();}
function actionText(action,r){if(action==='mow')return'Mähen gestartet';if(action==='spot')return'Spotmähen gestartet';if(action==='pause')return r?.status==='paused'?'Mähen pausiert':(r?.status==='mowing'?'Mähen fortgesetzt':'Pause / Weiter angefordert');if(action==='stop')return'Mäher STOP angefordert';if(action==='return')return'Zurück zur Ladestation';if(action==='maintenance')return'Fahrt zum Wartungspunkt gestartet';if(action==='gate_open')return'Garagentor öffnen angefordert';if(action==='gate_close')return'Garagentor schließen angefordert';return'Befehl gesendet';}
function closeDecoder({keepCursor=false}={}){try{if(decoder&&decoder.state!=='closed')decoder.close();}catch(_){}decoder=null;codecVersion=0;if(!keepCursor)cursor=0;canvasCtx=null;canvasW=0;canvasH=0;}
const bytes=b64=>Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
function renderFrame(picture,version){try{if(version!==epoch)return;const now=performance.now();if(now-lastPaintAt<42)return;lastPaintAt=now;const canvas=$('live');const w=picture.displayWidth||picture.codedWidth,h=picture.displayHeight||picture.codedHeight;if(canvasW!==w||canvasH!==h){canvas.width=w;canvas.height=h;canvasW=w;canvasH=h;canvasCtx=null;}if(!canvasCtx)canvasCtx=canvas.getContext('2d',{alpha:false,desynchronized:true})||canvas.getContext('2d');canvasCtx.drawImage(picture,0,0,w,h);canvas.hidden=false;cameraLabel('Live');consecutiveErrors=0;}finally{picture.close();}}
async function stopVideo(reason='user'){const wasActive=active||busy;epoch++;active=false;busy=false;clearTimeout(frameTimer);clearTimeout(offscreenTimer);offscreenTimer=null;closeDecoder();$('live').hidden=true;$('cameraToggle').textContent='Kamera EIN';cameraLabel('Aus');if(wasActive)diagnostic('stop',reason);if(H&&id)try{await api('POST','/camera',{action:'stop',client});}catch(e){showCameraError(e,'stop_error');}}
async function startVideo(){if(!window.VideoDecoder){showCameraError('Dieser Browser unterstützt die Kameradecodierung nicht. Bitte die Livekamera in der Geräteansicht verwenden.','decoder_unsupported');return;}if(active||busy||!inView||document.hidden)return;busy=true;const version=++epoch;clearCameraError();cameraLabel('Startet …');diagnostic('start_requested');try{await api('POST','/camera',{action:'start',client});if(version!==epoch||document.hidden||!inView){await api('POST','/camera',{action:'stop',client});return;}active=true;busy=false;consecutiveErrors=0;decoderErrors=0;$('cameraToggle').textContent='Kamera AUS';diagnostic('start_accepted');frame(version);}catch(e){busy=false;cameraLabel('Verbindung fehlgeschlagen');showCameraError(e,'start_failed');}}
async function configureDecoder(r,version){if(!r.config)return;if(codecVersion===r.config.version&&!r.reset&&decoder)return;if(r.reset)cursor=0;closeDecoder({keepCursor:!r.reset});const config={codec:r.config.codec,description:bytes(r.config.description),optimizeForLatency:true};const supported=await VideoDecoder.isConfigSupported(config);if(version!==epoch)return;if(!supported.supported)throw Error('Videoformat wird von diesem Browser nicht unterstützt. Bitte die native Gerätekamera verwenden.');decoder=new VideoDecoder({output:picture=>renderFrame(picture,version),error:e=>{decoderErrors++;diagnostic('decoder_error',e?.message||String(e));cameraLabel('Livebild wird synchronisiert …');try{decoder?.close();}catch(_){}decoder=null;codecVersion=0;if(decoderErrors>=3)showCameraError('Kamerabild konnte wiederholt nicht decodiert werden.','decoder_repeated');}});decoder.configure(config);codecVersion=r.config.version;}
async function frame(version){if(!active||version!==epoch||document.hidden||!inView)return;let nextDelay=125;try{const r=await api('POST','/camera',{action:'snapshot',client,cursor});if(version!==epoch)return;if(r.state==='error'||r.state==='off')throw Error(r.message||'Kamerastream wurde beendet.');await configureDecoder(r,version);if(decoder){for(const f of r.frames||[]){if(decoder.decodeQueueSize>18&&!f.key)continue;decoder.decode(new EncodedVideoChunk({type:f.key?'key':'delta',timestamp:f.timestamp,data:bytes(f.data)}));}if(decoder.decodeQueueSize>28)nextDelay=220;}cursor=r.cursor||cursor;if(!decoder)cameraLabel(r.state==='starting'?'Startet …':'Warte auf Livebild …');consecutiveErrors=0;}catch(e){if(version!==epoch)return;consecutiveErrors++;diagnostic('snapshot_error_'+consecutiveErrors,e?.message||String(e));if(consecutiveErrors>=3){cameraLabel('Verbindung wird neu aufgebaut …');showCameraError(e,'snapshot_failed');await stopVideo('snapshot_failed');return;}nextDelay=350;}frameTimer=setTimeout(()=>frame(version),nextDelay);}
async function refresh(){if(!id||document.hidden)return null;try{const r=await api('GET','/overview');lastOverviewStatus=String(r.status||'unknown');$('name').textContent=r.name;$('battery').textContent=r.battery==null?'—':r.battery+' %';$('status').textContent=labels[r.status]||r.status||'Unbekannt';if($('garageSection'))$('garageSection').hidden=!r.garageEnabled;if($('door')){$('door').textContent=r.doorStopped?'STOP aktiv · '+(labels[r.door]||'Endlage unbestätigt'):((labels[r.door]||'Endlage unbestätigt')+(r.doorEstimated?' · zeitbasiert':''));$('sensor').textContent='Sensor: '+({online:'Online',offline:'Offline',unknown:'Unbekannt'}[r.sensor]||r.sensor);$('safety').textContent='Sicherheit: '+({ok:'frei',warning:'Hinweis',blocked:'gesperrt',emergency:'Notfall'}[r.safety]||'unbekannt');document.querySelectorAll('[data-action^="gate_"]').forEach(b=>b.disabled=!r.garageEnabled);$('garageNote').textContent=r.garageEnabled?(r.doorStopped?'Automatik gesperrt. Motorstopp über deinen STOP-Flow.':'Torbefehle wirken über deine verknüpften Flows.'):'Garagenmodus deaktiviert';}resizeWidget();return r;}catch(e){showError(e);return null;}finally{clearTimeout(timer);timer=setTimeout(refresh,active?4000:2200);}}
function mapDelay(){if(active)return 8000;return activeMapStatuses.has(lastOverviewStatus)?1800:8000;}
async function refreshMap(force=false){if(!id||document.hidden||!inView||mapEditing)return;const box=$('mapStatic'),refreshBtn=$('overviewMapRefresh');try{if(force&&refreshBtn){refreshBtn.classList.add('loading');refreshBtn.disabled=true;}const r=force?await api('GET','/map-snapshot?refresh=1&hard=1&_='+Date.now()):await api('GET','/map-snapshot');if(!box)return;if(r?.svg){box.innerHTML=r.svg;box.classList.remove('empty');const meta=$('overviewMapMeta');if(meta)meta.textContent='Map · '+new Date(r.updatedAt||Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}else{box.innerHTML='<div class="map-loading">Noch keine Kartendaten verfügbar.</div>';box.classList.add('empty');}resizeWidget();}catch(e){if(box)box.innerHTML='<div class="map-loading">Karte momentan nicht verfügbar.</div>';if(force)showError(e);}finally{if(force&&refreshBtn){refreshBtn.classList.remove('loading');refreshBtn.disabled=false;}clearTimeout(mapTimer);mapTimer=setTimeout(refreshMap,mapDelay());}}
function setupMapEditor(){
  const host=$('overviewMapInline'),staticMap=$('mapStatic'),footer=$('overviewMapFooter'),button=$('overviewMapEdit'),refreshBtn=$('overviewMapRefresh');
  if(!host||!staticMap||!footer||!button)return;
  let frame=null;
  function setEditorHeight(value){
    const h=Math.max(270,Math.min(620,Number(value)||300));
    host.style.height=Math.round(h)+'px';
    resizeWidget();
  }
  function closeEditor({refresh=true,notifyChild=true}={}){
    mapEditing=false;
    button.setAttribute('aria-expanded','false');
    if(frame){if(notifyChild){try{frame.contentWindow?.postMessage({channel:'mova-overview-map',type:'cancel'},'*');}catch(_){}}frame.remove();frame=null;}
    host.innerHTML='';host.hidden=true;host.style.height='300px';
    staticMap.hidden=false;footer.hidden=false;
    if(refresh)refreshMap(true).catch?.(()=>{});
    resizeWidget();
  }
  function directEditorAdapter(){
    return {
      getDeviceIds:()=>id?[id]:[],
      getSettings:()=>{
        try{return typeof H?.getSettings==='function'?H.getSettings():{};}catch(_){return{};}
      },
      on:(name,fn)=>{
        try{return typeof H?.on==='function'?H.on(name,fn):undefined;}catch(_){return undefined;}
      },
      ready:()=>{},
      setHeight:setEditorHeight,
      finishEditor:()=>closeEditor({refresh:true,notifyChild:false}),
      api:(method,path,body)=>H.api(method,path,body||{})
    };
  }
  function initializeFrame(){
    if(!frame?.contentWindow||!id)return false;
    try{
      const child=frame.contentWindow;
      if(child.__movaOverviewDirectInitialized)return true;
      const init=child.initializeOverviewEditor;
      if(typeof init!=='function')return false;
      // Direct same-origin adapter: use the parent widget's real Homey session.
      // This avoids the nested iframe postMessage API proxy that can stall in
      // the Homey iOS WebView while keeping the exact single-map editor UI.
      child.__movaOverviewAutoEdit=true;
      child.__movaOverviewDirectInitialized=true;
      init(directEditorAdapter());
      return true;
    }catch(_){
      return false;
    }
  }
  function sendLegacyInit(){
    if(!frame?.contentWindow||!id)return;
    try{frame.contentWindow.postMessage({channel:'mova-overview-map',type:'init',deviceId:id},'*');}catch(_){}
  }
  function createEditor(){
    if(frame)return;
    frame=document.createElement('iframe');
    frame.className='map-editor-frame';
    frame.title='Mähkarte bearbeiten';
    frame.addEventListener('load',()=>{
      if(initializeFrame())return;
      // Defensive fallback only for runtimes that isolate the iframe origin.
      sendLegacyInit();
      setTimeout(()=>{if(!initializeFrame())sendLegacyInit();},120);
      setTimeout(()=>{if(!initializeFrame())sendLegacyInit();},500);
    });
    frame.src='map-editor.html?_='+Date.now();
    host.appendChild(frame);
  }
  window.addEventListener('message',async event=>{
    if(!frame||event.source!==frame.contentWindow||event.data?.channel!=='mova-overview-map')return;
    const message=event.data;
    if(message.type==='bridge-ready'){
      if(!initializeFrame())sendLegacyInit();
      return;
    }
    if(message.type==='done'){closeEditor();return;}
    if(message.type==='height'){setEditorHeight(message.height);return;}
    // Legacy API proxy is retained only as a compatibility fallback. In the
    // normal 1.2.16 path initializeFrame() injects H.api directly.
    if(message.type!=='api')return;
    const route=String(message.path||'').split('?')[0];
    const valid=(message.method==='GET'&&route==='/')||
      (message.method==='PUT'&&(route==='/garage-markers'||route==='/obstacle-rule'));
    const response={channel:'mova-overview-map',type:'result',requestId:message.requestId};
    try{
      if(!valid||!id||new URLSearchParams(String(message.path).split('?')[1]||'').get('deviceId')!==String(id))throw Error('Ungültige Kartenanfrage');
      response.result=await H.api(message.method,message.path,message.body||{});
    }catch(e){response.error=e?.message||String(e);}
    try{event.source?.postMessage(response,'*');}catch(_){}
  });
  button.onclick=()=>{
    if(mapEditing)return;
    mapEditing=true;
    clearTimeout(mapTimer);mapTimer=null;
    staticMap.hidden=true;footer.hidden=true;host.hidden=false;
    button.setAttribute('aria-expanded','true');
    setEditorHeight(Math.max(300,staticMap.clientHeight+30));
    createEditor();
    resizeWidget();
  };
  if(refreshBtn)refreshBtn.onclick=()=>refreshMap(true);
}
function onHomeyReady(Homey){H=Homey;id=H.getDeviceIds()[0];client='w_'+String(H.getWidgetInstanceId()).replace(/[^A-Za-z0-9_-]/g,'').slice(0,58)+'_'+Math.random().toString(36).slice(2,8);H.ready();setupMapEditor();resizeWidget();if(!id){showError('Bitte einen Mäher im Widget auswählen.');return;}$('cameraToggle').onclick=async()=>{clearCameraError();setActionStatus(active||busy?'Kamera wird ausgeschaltet':'Kamera wird eingeschaltet');if(active||busy)await stopVideo('button');else await startVideo();};document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{b.disabled=true;clearError();setActionStatus('Befehl wird gesendet …');try{await api('POST','/command',{action:b.dataset.action});const r=await refresh();setActionStatus(actionText(b.dataset.action,r));}catch(e){setActionStatus('Aktion fehlgeschlagen',true);showError(e);}finally{b.disabled=false;}});refresh();refreshMap();}
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);clearTimeout(mapTimer);stopVideo('hidden');}else{refresh();refreshMap();}});window.addEventListener('pagehide',()=>{clearTimeout(timer);clearTimeout(mapTimer);stopVideo('pagehide');});if(window.IntersectionObserver)new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;if(!inView){clearTimeout(offscreenTimer);offscreenTimer=setTimeout(()=>{if(!inView)stopVideo('offscreen');},8000);}else{clearTimeout(offscreenTimer);offscreenTimer=null;if(H){refresh();refreshMap();}}},{threshold:0.02}).observe(document.body);if(window.ResizeObserver)new ResizeObserver(resizeWidget).observe(document.body);

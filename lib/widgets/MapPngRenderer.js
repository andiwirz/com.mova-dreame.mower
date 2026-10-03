'use strict';

const zlib = require('node:zlib');

// Render at 2× the old native-media resolution. Homey/iOS downscales this PNG,
// which gives the native media view much smoother edges without native modules.
const W = 1440;
const H = 1040;
const BG = [8, 38, 21, 255];

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rgba(hex, alpha = 255) {
  const s = hex.replace('#', '');
  return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16), alpha];
}
function blend(buf, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const a = c[3] / 255, ia = 1 - a;
  buf[i] = Math.round(c[0] * a + buf[i] * ia);
  buf[i+1] = Math.round(c[1] * a + buf[i+1] * ia);
  buf[i+2] = Math.round(c[2] * a + buf[i+2] * ia);
  buf[i+3] = 255;
}
function circle(buf, cx, cy, r, c) {
  const rr = Math.max(1, Math.round(r));
  const x0 = Math.max(0, Math.floor(cx - rr)), x1 = Math.min(W - 1, Math.ceil(cx + rr));
  const y0 = Math.max(0, Math.floor(cy - rr)), y1 = Math.min(H - 1, Math.ceil(cy + rr));
  const r2 = rr * rr;
  for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) if ((x-cx)*(x-cx)+(y-cy)*(y-cy)<=r2) blend(buf,x,y,c);
}
function line(buf, x1, y1, x2, y2, width, c) {
  const dx=x2-x1, dy=y2-y1, steps=Math.max(1,Math.ceil(Math.hypot(dx,dy)));
  const r=Math.max(1,width/2);
  for(let i=0;i<=steps;i++){const t=i/steps;circle(buf,x1+dx*t,y1+dy*t,r,c);}
}
function polygon(buf, pts, c) {
  if (!Array.isArray(pts) || pts.length < 3) return;
  let minY=Infinity,maxY=-Infinity;
  for(const p of pts){minY=Math.min(minY,p[1]);maxY=Math.max(maxY,p[1]);}
  const y0=clamp(Math.floor(minY),0,H-1), y1=clamp(Math.ceil(maxY),0,H-1);
  for(let y=y0;y<=y1;y++){
    const xs=[];
    for(let i=0,j=pts.length-1;i<pts.length;j=i++){
      const a=pts[i],b=pts[j];
      if ((a[1]>y)!==(b[1]>y)) xs.push((b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]);
    }
    xs.sort((a,b)=>a-b);
    for(let k=0;k+1<xs.length;k+=2){
      const xa=clamp(Math.ceil(xs[k]),0,W-1), xb=clamp(Math.floor(xs[k+1]),0,W-1);
      for(let x=xa;x<=xb;x++) blend(buf,x,y,c);
    }
  }
}
function polyline(buf, pts, width, c) { for(let i=1;i<pts.length;i++) line(buf,pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1],width,c); }
function ring(buf,cx,cy,r,width,c){
  const n=Math.max(48,Math.round(r*1.25)); let prev=null;
  for(let i=0;i<=n;i++){const a=i/n*Math.PI*2,p=[cx+Math.cos(a)*r,cy+Math.sin(a)*r];if(prev)line(buf,prev[0],prev[1],p[0],p[1],width,c);prev=p;}
}
function dashedRing(buf,cx,cy,r,width,c){
  const n=80;
  for(let i=0;i<n;i+=2){const a=i/n*Math.PI*2,b=(i+1)/n*Math.PI*2;line(buf,cx+Math.cos(a)*r,cy+Math.sin(a)*r,cx+Math.cos(b)*r,cy+Math.sin(b)*r,width,c);}
}
function warningMarker(buf,cx,cy,r){
  const pts=[[cx,cy-r],[cx-r*0.86,cy+r*0.72],[cx+r*0.86,cy+r*0.72]];
  polygon(buf,pts,rgba('#ff9800',245));polyline(buf,[...pts,pts[0]],Math.max(2,r*.16),rgba('#ffffff',250));
  line(buf,cx,cy-r*.32,cx,cy+r*.20,Math.max(2,r*.14),rgba('#ffffff',255));circle(buf,cx,cy+r*.45,Math.max(2,r*.09),rgba('#ffffff',255));
}
function badge(buf,cx,cy,r,label){
  circle(buf,cx,cy,r,rgba('#ff5b2f',255));ring(buf,cx,cy,r,Math.max(2,r*.14),rgba('#ffffff',250));
  // Compact block letters are enough for the A/B safety-line labels.
  const c=rgba('#ffffff',255), w=Math.max(2,r*.16), h=r*.75;
  if(label==='A'){
    line(buf,cx-r*.36,cy+h*.45,cx,cy-h*.45,w,c);line(buf,cx,cy-h*.45,cx+r*.36,cy+h*.45,w,c);line(buf,cx-r*.20,cy+h*.05,cx+r*.20,cy+h*.05,w,c);
  } else {
    line(buf,cx-r*.28,cy-h*.46,cx-r*.28,cy+h*.46,w,c);line(buf,cx-r*.28,cy-h*.46,cx+r*.10,cy-h*.46,w,c);line(buf,cx-r*.28,cy,cx+r*.15,cy,w,c);line(buf,cx-r*.28,cy+h*.46,cx+r*.10,cy+h*.46,w,c);ring(buf,cx+r*.02,cy-h*.23,r*.23,w,c);ring(buf,cx+r*.02,cy+h*.23,r*.23,w,c);
  }
}
function normalizePoint(v){
  if(!v)return null;
  if(Array.isArray(v)&&Number.isFinite(Number(v[0]))&&Number.isFinite(Number(v[1])))return{x:Number(v[0]),y:Number(v[1])};
  if(typeof v==='object'&&Number.isFinite(Number(v.x))&&Number.isFinite(Number(v.y)))return{x:Number(v.x),y:Number(v.y)};
  return null;
}
function areaObject(v){return Array.isArray(v)&&v.length===2&&v[1]&&typeof v[1]==='object'?v[1]:v;}
function areaPath(v){const obj=areaObject(v),p=obj?.path||obj?.points||obj?.polygon||obj;if(!Array.isArray(p))return[];return p.map(normalizePoint).filter(Boolean);}
function crc32(buf){let c=0xffffffff;for(const byte of buf){c^=byte;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type,'ascii'),out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length,0);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([t,data])),8+data.length);return out;}
function encodePng(buf){const raw=Buffer.alloc((W*4+1)*H);for(let y=0;y<H;y++){const o=y*(W*4+1);raw[o]=0;buf.copy(raw,o+1,y*W*4,(y+1)*W*4);}const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:6})),chunk('IEND',Buffer.alloc(0))]);}
function validRoutePoint(pt){return Array.isArray(pt)&&pt.length>=2&&pt[0]!==32767&&Number.isFinite(Number(pt[0]))&&Number.isFinite(Number(pt[1]));}
function median(values){if(!values.length)return null;const s=values.slice().sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function mowingPattern(path,finalMode=false){
  if(!Array.isArray(path)||path.length<2)return[];
  const segments=[];let previous=null,sumCos2=0,sumSin2=0,totalWeight=0;
  for(const pt of path){if(!validRoutePoint(pt)){previous=null;continue;}if(previous){const dx=Number(pt[0])-Number(previous[0]),dy=Number(pt[1])-Number(previous[1]),length=Math.hypot(dx,dy);if(length>.001&&length<=3000){const angle=Math.atan2(dy,dx),weight=Math.min(length,3000);sumCos2+=Math.cos(angle*2)*weight;sumSin2+=Math.sin(angle*2)*weight;totalWeight+=weight;segments.push({a:[+previous[0],+previous[1]],b:[+pt[0],+pt[1]],dx,dy,length});}}previous=pt;}
  if(!segments.length||!totalWeight)return[];
  const axis=Math.atan2(sumSin2,sumCos2)/2,ux=Math.cos(axis),uy=Math.sin(axis),crossOf=(x,y)=>-x*uy+y*ux,alongOf=(x,y)=>x*ux+y*uy;
  const aligned=segments.map(seg=>({seg,along:Math.abs(seg.dx*ux+seg.dy*uy),across:Math.abs(-seg.dx*uy+seg.dy*ux),cross:crossOf((seg.a[0]+seg.b[0])/2,(seg.a[1]+seg.b[1])/2)})).filter(x=>x.along/x.seg.length>=.70);
  if(!aligned.length)return[];
  const connector=segments.map(seg=>({seg,along:Math.abs(seg.dx*ux+seg.dy*uy),across:Math.abs(-seg.dx*uy+seg.dy*ux)})).filter(x=>x.along/x.seg.length<.35&&x.across>=120&&x.across<=800).map(x=>x.across);
  const crosses=aligned.filter(x=>x.seg.length>=80).map(x=>x.cross).sort((a,b)=>a-b),clusters=[];
  for(const value of crosses){const last=clusters.at(-1);if(!last||Math.abs(value-last.mean)>95)clusters.push({sum:value,count:1,mean:value});else{last.sum+=value;last.count++;last.mean=last.sum/last.count;}}
  const centre=[];for(let i=1;i<clusters.length;i++){const d=clusters[i].mean-clusters[i-1].mean;if(d>=120&&d<=800)centre.push(d);}
  const pitch=Math.max(120,Math.min(800,median(connector.length?connector:centre)||250)),origin=clusters.length?clusters[0].mean:Math.min(...aligned.map(x=>x.cross));
  const out=[];
  if(finalMode){const lanes=new Map();for(const item of aligned){if(item.seg.length<45)continue;const index=Math.round((item.cross-origin)/pitch),a=alongOf(...item.seg.a),b=alongOf(...item.seg.b),lo=Math.min(a,b),hi=Math.max(a,b);if(hi-lo<20)continue;let lane=lanes.get(index);if(!lane){lane={intervals:[],crossSum:0,weight:0};lanes.set(index,lane);}lane.intervals.push([lo,hi]);lane.crossSum+=item.cross*item.seg.length;lane.weight+=item.seg.length;}const maxGap=Math.max(650,pitch*2.25);for(const [index,lane] of [...lanes].sort((a,b)=>a[0]-b[0])){lane.intervals.sort((a,b)=>a[0]-b[0]);const merged=[];for(const interval of lane.intervals){const last=merged.at(-1);if(!last||interval[0]-last[1]>maxGap)merged.push(interval.slice());else last[1]=Math.max(last[1],interval[1]);}const observed=lane.weight?lane.crossSum/lane.weight:origin+index*pitch,regular=origin+index*pitch,cross=regular*.78+observed*.22;for(const [lo,hi] of merged){if(hi-lo<120)continue;out.push({a:[lo*ux-cross*uy,lo*uy+cross*ux],b:[hi*ux-cross*uy,hi*uy+cross*ux],light:Math.abs(index)%2===0,pitch});}}}
  else for(const item of aligned){const index=Math.round((item.cross-origin)/pitch);out.push({a:item.seg.a,b:item.seg.b,light:Math.abs(index)%2===0,pitch});}
  return out;
}

function renderMapPng(data){
  if(!data?.boundary)return null;
  const b=data.boundary;let minX=Number(b.x1),maxX=Number(b.x2),minY=Number(b.y1),maxY=Number(b.y2);
  if(![minX,maxX,minY,maxY].every(Number.isFinite)||maxX<=minX||maxY<=minY)return null;
  const go={...(data.garageOverlay||{})};go.lineA=normalizePoint(go.lineA)||normalizePoint(data.safetyLineA);go.lineB=normalizePoint(go.lineB)||normalizePoint(data.safetyLineB);go.dangerCenter=normalizePoint(go.dangerCenter)||normalizePoint(data.dangerCenter);go.maintenancePoint=normalizePoint(go.maintenancePoint)||normalizePoint(data.maintenancePoint);
  const paths=[...(data.mowingAreas||[]),...(data.forbiddenAreas||[]),...(data.spotAreas||[])].map(areaPath).filter(x=>x.length);
  // Match the dashboard renderer: use zones for a tight view, but keep a zone-less
  // fallback on the full official boundary.
  if(paths.length){for(const path of paths)for(const p of path){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}}
  const garageMode=!!data.overlayVisibility?.garageMode;
  const showGarageOverlay=garageMode&&data.overlayVisibility?.showGarageOverlay!==false;
  const showMaintenancePoint=data.overlayVisibility?.showMaintenancePoint!==false;
  const extra=[
    ...(showGarageOverlay?[go.lineA,go.lineB,go.dangerCenter,normalizePoint(data.chargerPos)]:[]),
    ...(showMaintenancePoint?[go.maintenancePoint]:[]),
    normalizePoint(data.robotPos),normalizePoint(data.livePosition),
  ].filter(Boolean);
  for(const p of extra){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
  if(showGarageOverlay&&go.dangerCenter){const r=Math.max(Number(go.cautionRadius||data.cautionRadius||0),Number(go.dangerRadius||data.dangerRadius||0));if(Number.isFinite(r)&&r>0){minX=Math.min(minX,go.dangerCenter.x-r);maxX=Math.max(maxX,go.dangerCenter.x+r);minY=Math.min(minY,go.dangerCenter.y-r);maxY=Math.max(maxY,go.dangerCenter.y+r);}}
  const dx=maxX-minX,dy=maxY-minY,pad=Math.max(dx,dy)*.06+120;minX-=pad;maxX+=pad;minY-=pad;maxY+=pad;
  const scale=Math.min((W-56)/(maxX-minX),(H-56)/(maxY-minY)),ox=(W-(maxX-minX)*scale)/2,oy=(H-(maxY-minY)*scale)/2,T=p=>[ox+(p.x-minX)*scale,oy+(maxY-p.y)*scale];
  const buf=Buffer.alloc(W*H*4);for(let i=0;i<W*H;i++){buf[i*4]=BG[0];buf[i*4+1]=BG[1];buf[i*4+2]=BG[2];buf[i*4+3]=255;}
  // LiDAR contours sit below the actual zones, just like the dashboard map.
  for(const entry of data.contours||[]){const pts=areaPath(entry).map(T);if(pts.length>=3){polygon(buf,pts,rgba('#374f2d',120));polyline(buf,[...pts,pts[0]],2.5,rgba('#607d4e',170));}}
  (data.mowingAreas||[]).forEach((a,idx)=>{const pts=areaPath(a).map(T);if(pts.length>=3){polygon(buf,pts,rgba(idx%2?'#4b965a':'#43a653',110));polyline(buf,[...pts,pts[0]],5,rgba('#4CAF50',245));}});
  (data.forbiddenAreas||[]).forEach(a=>{const pts=areaPath(a).map(T);if(pts.length>=3){polygon(buf,pts,rgba('#dc503c',70));polyline(buf,[...pts,pts[0]],3,rgba('#dc503c',230));}});
  (data.spotAreas||[]).forEach(a=>{const pts=areaPath(a).map(T);if(pts.length>=3){polygon(buf,pts,rgba('#ffb74d',75));polyline(buf,[...pts,pts[0]],3,rgba('#ffb74d',225));}});
  // Complete driven route + stable light/dark mowing overlay.
  const path=[];for(const p of data.livePath||[]){if(!validRoutePoint(p)){path.push(null);continue;}path.push(T({x:+p[0],y:+p[1]}));}let seg=[];for(const p of path){if(!p){if(seg.length>1)polyline(buf,seg,4,rgba('#ffffff',45));seg=[];}else seg.push(p);}if(seg.length>1)polyline(buf,seg,4,rgba('#ffffff',45));
  for(const lane of mowingPattern(data.livePath||[],data.routeRenderMode==='final')){const a=T({x:lane.a[0],y:lane.a[1]}),bb=T({x:lane.b[0],y:lane.b[1]}),width=Math.max(7,Math.min(32,lane.pitch*scale*(data.routeRenderMode==='final'?.86:.55)));line(buf,a[0],a[1],bb[0],bb[1],width,rgba(lane.light?'#a4cd89':'#508949',225));}
  // Additional OBS polygons when available.
  try{const raw=data.obstacles?.obs?.data,obsData=typeof raw==='string'?JSON.parse(raw):raw;if(Array.isArray(obsData))for(const ob of obsData){if(!Array.isArray(ob?.data)||ob.data.length<2)continue;const pts=ob.data.map(p=>T({x:Number(p[0])*10,y:Number(p[1])*10}));polygon(buf,pts,rgba('#ff9800',70));polyline(buf,[...pts,pts[0]],3,rgba('#ff9800',220));}}catch(_){ }
  if(showGarageOverlay){
    if(go.dangerCenter){const c=T(go.dangerCenter),dr=Number(go.dangerRadius||data.dangerRadius||1200)*scale,cr=Number(go.cautionRadius||data.cautionRadius||1800)*scale;dashedRing(buf,c[0],c[1],cr,4,rgba('#e8b707',235));ring(buf,c[0],c[1],dr,6,rgba('#f0463b',245));}
    if(go.lineA&&go.lineB){const a=T(go.lineA),bb=T(go.lineB);line(buf,a[0],a[1],bb[0],bb[1],14,rgba('#ffffff',240));line(buf,a[0],a[1],bb[0],bb[1],8,rgba('#ff5b2f',255));badge(buf,a[0],a[1],14,'A');badge(buf,bb[0],bb[1],14,'B');}
  }
  if(showMaintenancePoint&&go.maintenancePoint){const m=T(go.maintenancePoint);dashedRing(buf,m[0],m[1],28,4,rgba('#c561dd',230));ring(buf,m[0],m[1],19,6,rgba('#a63dc4',255));circle(buf,m[0],m[1],7,rgba('#ffffff',255));}
  const charger=normalizePoint(data.chargerPos);if(showGarageOverlay&&charger){const c=T(charger);circle(buf,c[0],c[1],27,rgba('#2166c3',255));ring(buf,c[0],c[1],30,6,rgba('#ffffff',245));circle(buf,c[0],c[1],11,rgba('#ffffff',245));}
  const robot=normalizePoint(data.robotPos)||normalizePoint(data.livePosition);if(robot){const r=T(robot);circle(buf,r[0],r[1],20,rgba('#22a4ff',255));ring(buf,r[0],r[1],24,6,rgba('#ffffff',245));}
  const obstaclePoints=[];for(const ob of data.mapObstacles||[]){const p=normalizePoint(ob)||normalizePoint(ob?.position);if(p)obstaclePoints.push({p,pending:false});}for(const ob of data.obstaclePylons||[]){const p=normalizePoint(ob)||normalizePoint(ob?.position);if(p)obstaclePoints.push({p,pending:!!ob?.rule?.pending});}for(const item of obstaclePoints){const o=T(item.p);dashedRing(buf,o[0],o[1],31,item.pending?5:3,rgba(item.pending?'#42a5f5':'#dc9000',item.pending?245:210));warningMarker(buf,o[0],o[1],16);}
  return encodePng(buf);
}

module.exports={renderMapPng};

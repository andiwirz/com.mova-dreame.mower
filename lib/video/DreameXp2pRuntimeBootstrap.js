'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = '/userdata/dreame-xp2p';
const MANIFEST = 'runtime-manifest.json';
const WORKER_SHA256 = '197f0fe96d2e752d435a0ee4cfd9f1b02c4ecf358fc722564cef869ef90c9236';
const TENCENT_AAR_URL = 'https://repo.maven.apache.org/maven2/com/tencent/iot/thirdparty/android/xp2p-sdk/2.4.50/xp2p-sdk-2.4.50.aar';
const TENCENT_AAR_SHA256 = '7cbbacdb08861a16d5d9f1db71f2b04d7b9d01e8c71b20e51612100c2098dc37';
const TENCENT_LIB_SHA256 = '30fafc9f7b15a29a64622200817248c636133e06affc40479084ca3d8d188649';
const AOSP_RUNTIME_APEX_URL = 'https://android.googlesource.com/platform/prebuilts/runtime/+/070571b455076f77a01c7b07154a15e545d2b428/mainline/runtime/apex/com.android.runtime-arm64.apex?format=TEXT';
const AOSP_RUNTIME_APEX_SHA256 = '83bf0dce249728dae48149b80d28b48115c54adad95a352120d58a6ac669d1fc';
const VNDK_BASE = 'https://android.googlesource.com/platform/prebuilts/vndk/v31/+/1a059a5a203352d3e0c2fd3ccff5719cc37fc340/arm64/arch-arm64-armv8-a/shared';

const AOSP_FILES = {
  'bin/linker64': ['bin/linker64', 'dc36b5feed26752e8f0758cff8d6dcdd63b1434c03d6692b58ba5c09399b1d16', 0o755],
  'lib64/bionic/libc.so': ['lib/bionic/libc.so', '9f1f93bbd186af5c40a93f6ca4425bfdce82b7f3b9c730e59bb5c7fa598593cf', 0o644],
  'lib64/bionic/libm.so': ['lib/bionic/libm.so', '74ec94e6aecf17ab8d56d2da151dd0756e21e8f53e567815cbf43c5266224c5b', 0o644],
  'lib64/bionic/libdl.so': ['lib/bionic/libdl.so', '7e215e0e68372d779492438d1a8e0e53e63154812d506af830e6c3dbcaeb0607', 0o644],
  'lib64/ld-android.so': ['lib/ld-android.so', '00dc38b8ce57d92b74c404fb40c37c50527fc558dd497bb484a950e926d63bff', 0o644],
  'lib64/libc++.so': ['lib/libstdc++.so', 'ae87fa079200affdb3c534c794bcb213397e75120c5e126202b4644acad09629', 0o644],
};

const VNDK_FILES = {
  'lib/liblog.so': [`${VNDK_BASE}/llndk-stub/liblog.so?format=TEXT`, 'e0099f476029f7443ba1829daa7100becd03ae08a3e3cd957034add9003c6eae'],
  'lib/libz.so': [`${VNDK_BASE}/vndk-sp/libz.so?format=TEXT`, '68056ee2e644754f7693eb903b6fa51819b6655ff8a82a0c58e56aff3ff48e31'],
};

const TENCENT_DIAG_EXPORTS = [
  'startService', 'stopService', 'setDeviceXp2pInfo', 'postCommandRequestSync',
  'startAvRecvService', 'stopAvRecvService', 'delegateHttpFlv', 'getStreamLinkMode',
  'runSendService', 'stopSendService', 'recordStream', 'getStreamBufSize', 'dataSend',
  'startLanService', 'getLanUrl', 'getLanProxyPort', 'getVersion', 'getUserID',
  'setUserCallbackToXp2p', 'setCrossStunTurn', 'setStunServerToXp2p', 'setQcloudApiCred',
  'prepare', 'prepareService', 'preparePlay', 'startPlay', 'startPlayback', 'startLive'
];

// NOTE: the libdl hash in the pinned upstream file is required at runtime. The
// manifest validates every asset; if Homey's download differs we stop before
// executing anything and emit a precise [video-xp2p-runtime] stage error.

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function requireHash(buf, expected, label) {
  const actual = sha256(buf);
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label}: SHA-256 mismatch expected=${expected.slice(0,12)} actual=${actual.slice(0,12)}`);
}
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeVerified(root, rel, buf, hash, mode = 0o644) {
  requireHash(buf, hash, rel);
  const p = path.join(root, rel); mkdirp(path.dirname(p)); fs.writeFileSync(p, buf); fs.chmodSync(p, mode); return p;
}
function download(url, timeoutMs = 60000, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Homey-Dreame-XP2P/1.0', Accept: '*/*' } }, (res) => {
      const code = Number(res.statusCode || 0);
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume(); return resolve(download(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code} for ${new URL(url).host}`)); }
      const chunks = []; let size = 0; const max = 128 * 1024 * 1024;
      res.on('data', (c) => { size += c.length; if (size > max) { req.destroy(new Error('download exceeds 128 MiB')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`download timeout ${Math.round(timeoutMs/1000)}s`)));
    req.on('error', reject);
  });
}
function decodeGitiles(buf) { return Buffer.from(buf.toString('ascii').replace(/\s+/g, ''), 'base64'); }

function zipEntry(zip, wanted) {
  let eocd = -1;
  for (let i = Math.max(0, zip.length - 0x10000 - 22); i <= zip.length - 22; i++) if (zip.readUInt32LE(i) === 0x06054b50) eocd = i;
  if (eocd < 0) throw new Error('ZIP EOCD not found');
  const count = zip.readUInt16LE(eocd + 10); const cdOffset = zip.readUInt32LE(eocd + 16);
  let off = cdOffset;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP central directory malformed');
    const method = zip.readUInt16LE(off + 10); const compressed = zip.readUInt32LE(off + 20); const uncompressed = zip.readUInt32LE(off + 24);
    const nameLen = zip.readUInt16LE(off + 28); const extraLen = zip.readUInt16LE(off + 30); const commentLen = zip.readUInt16LE(off + 32); const local = zip.readUInt32LE(off + 42);
    const name = zip.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    if (name === wanted) {
      if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`ZIP local header malformed: ${wanted}`);
      const ln = zip.readUInt16LE(local + 26), le = zip.readUInt16LE(local + 28); const start = local + 30 + ln + le;
      const data = zip.subarray(start, start + compressed);
      let out; if (method === 0) out = Buffer.from(data); else if (method === 8) out = zlib.inflateRawSync(data); else throw new Error(`ZIP method ${method} unsupported for ${wanted}`);
      if (out.length !== uncompressed) throw new Error(`ZIP size mismatch for ${wanted}`); return out;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP entry missing: ${wanted}`);
}

class ExtFilesystem {
  constructor(image) {
    this.image = image; if (image.length < 2048) throw new Error('ext image truncated');
    const s = image.subarray(1024, 2048); if (s.readUInt16LE(56) !== 0xEF53) throw new Error('payload is not ext filesystem');
    this.blockSize = 1024 << s.readUInt32LE(24); this.inodesPerGroup = s.readUInt32LE(40); this.firstDataBlock = s.readUInt32LE(20);
    this.inodeSize = s.readUInt16LE(88) || 128; this.descriptorSize = Math.max(s.readUInt16LE(254), 32); this.descriptorTable = (this.firstDataBlock + 1) * this.blockSize;
  }
  inode(num) {
    const idx = num - 1, group = Math.floor(idx / this.inodesPerGroup), gi = idx % this.inodesPerGroup;
    const d = this.descriptorTable + group * this.descriptorSize; const low = this.image.readUInt32LE(d + 8); const high = this.descriptorSize >= 64 ? this.image.readUInt32LE(d + 40) : 0;
    const block = low + high * 0x100000000; const off = block * this.blockSize + gi * this.inodeSize; return this.image.subarray(off, off + this.inodeSize);
  }
  extents(node) {
    const magic = node.readUInt16LE(0), entries = node.readUInt16LE(2), max = node.readUInt16LE(4), depth = node.readUInt16LE(6); if (magic !== 0xF30A || entries > max) throw new Error('invalid ext extent tree');
    const out = [];
    if (depth === 0) { for (let i=0;i<entries;i++) { const o=12+i*12, logical=node.readUInt32LE(o), len=node.readUInt16LE(o+4)&0x7fff, hi=node.readUInt16LE(o+6), lo=node.readUInt32LE(o+8); out.push([logical, lo + hi*0x100000000, len]); } return out; }
    for (let i=0;i<entries;i++) { const o=12+i*12, lo=node.readUInt32LE(o+4), hi=node.readUInt16LE(o+8), leaf=lo+hi*0x100000000, st=leaf*this.blockSize; out.push(...this.extents(this.image.subarray(st, st+this.blockSize))); } return out;
  }
  inodeData(inode) {
    let size = inode.readUInt32LE(4); if (inode.length >= 112) size += inode.readUInt32LE(108) * 0x100000000; if (!(inode.readUInt32LE(32) & 0x00080000)) throw new Error('non-extent ext storage unsupported');
    const result = Buffer.alloc(size); for (const [logical, physical, blocks] of this.extents(inode.subarray(40,100))) { const src=physical*this.blockSize, dst=logical*this.blockSize, len=Math.min(blocks*this.blockSize, Math.max(size-dst,0)); if (len>0 && src+len<=this.image.length) this.image.copy(result,dst,src,src+len); } return result;
  }
  dirEntries(num) { const data=this.inodeData(this.inode(num)), out={}; let o=0; while(o+8<=data.length){ const child=data.readUInt32LE(o), rec=data.readUInt16LE(o+4), nl=data[o+6]; if(rec<8||o+rec>data.length)break; if(child&&nl<=rec-8)out[data.subarray(o+8,o+8+nl).toString('utf8')]=child; o+=rec;} return out; }
  readFile(p) { let ino=2; for(const part of String(p).split('/').filter(Boolean)){ const e=this.dirEntries(ino); if(!e[part])throw new Error(`APEX missing ${p}`); ino=e[part]; } const inode=this.inode(ino); if((inode.readUInt16LE(0)&0xF000)!==0x8000)throw new Error(`APEX path not regular file ${p}`); return this.inodeData(inode); }
}

class DreameXp2pRuntimeBootstrap {
  constructor(device) { this.device=device; this._installPromise=null; }
  log(msg, obj=null){ this.device.log(`[video-xp2p-runtime] ${msg}${obj ? ` ${JSON.stringify(obj)}` : ''}`); }
  pageSize(){ try { return Number(String(execFileSync('getconf',['PAGESIZE'],{timeout:2000})).trim()) || 4096; } catch(_){ return 4096; } }
  _hasExactCString(buf, symbol){
    const token=Buffer.from(`\0${symbol}\0`,'utf8');
    if(buf.indexOf(token)>=0)return true;
    const tail=Buffer.from(`${symbol}\0`,'utf8');
    return buf.subarray(0,tail.length).equals(tail);
  }
  _elfDynSymbols(buf){
    // ELF64 little-endian AArch64 parser. We intentionally inspect metadata only;
    // no unknown Tencent function is invoked here.
    if(buf.length<64 || buf[0]!==0x7f || buf[1]!==0x45 || buf[2]!==0x4c || buf[3]!==0x46)throw new Error('Tencent library is not ELF');
    if(buf[4]!==2 || buf[5]!==1)throw new Error(`unsupported Tencent ELF class/data ${buf[4]}/${buf[5]}`);
    const u64=(off)=>{ const v=buf.readBigUInt64LE(off); if(v>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('ELF offset exceeds JS safe integer'); return Number(v); };
    const shoff=u64(0x28), shentsize=buf.readUInt16LE(0x3a), shnum=buf.readUInt16LE(0x3c);
    if(!shoff || shentsize<64 || !shnum || shoff+shentsize*shnum>buf.length)throw new Error('ELF section table invalid');
    const section=(idx)=>{
      if(idx<0 || idx>=shnum)throw new Error(`ELF section index ${idx} invalid`);
      const o=shoff+idx*shentsize;
      return {type:buf.readUInt32LE(o+4),offset:u64(o+24),size:u64(o+32),link:buf.readUInt32LE(o+40),entsize:u64(o+56)};
    };
    const readCString=(table,nameOff)=>{
      if(nameOff<0 || nameOff>=table.length)return '';
      let end=nameOff; while(end<table.length && table[end]!==0)end++;
      return table.subarray(nameOff,end).toString('utf8');
    };
    const defined=new Set(), undefinedSymbols=new Set();
    for(let i=0;i<shnum;i++){
      const sym=section(i); if(sym.type!==11 || !sym.entsize)continue; // SHT_DYNSYM
      const str=section(sym.link);
      if(sym.offset+sym.size>buf.length || str.offset+str.size>buf.length)throw new Error('ELF dynsym/dynstr outside file');
      const strings=buf.subarray(str.offset,str.offset+str.size);
      const count=Math.floor(sym.size/sym.entsize);
      for(let n=0;n<count;n++){
        const o=sym.offset+n*sym.entsize; if(o+24>buf.length)break;
        const name=readCString(strings,buf.readUInt32LE(o)); if(!name)continue;
        const info=buf[o+4], bind=info>>4, shndx=buf.readUInt16LE(o+6);
        if(bind!==1 && bind!==2)continue; // global / weak
        if(shndx===0)undefinedSymbols.add(name); else defined.add(name);
      }
    }
    return {defined,undefined:undefinedSymbols};
  }
  _inspectTencentExports(root=ROOT){
    try{
      const p=path.join(root,'lib','libiot_video_demo.so');
      const bytes=fs.readFileSync(p);
      const stringsPresent=[], stringsAbsent=[];
      for(const symbol of TENCENT_DIAG_EXPORTS){
        (this._hasExactCString(bytes,symbol)?stringsPresent:stringsAbsent).push(symbol);
      }
      const dyn=this._elfDynSymbols(bytes);
      const exported=TENCENT_DIAG_EXPORTS.filter(x=>dyn.defined.has(x));
      const imported=TENCENT_DIAG_EXPORTS.filter(x=>!dyn.defined.has(x) && dyn.undefined.has(x));
      const groups={
        core:['startService','stopService','setDeviceXp2pInfo','postCommandRequestSync','delegateHttpFlv'],
        receive:['startAvRecvService','stopAvRecvService','getStreamLinkMode'],
        send:['runSendService','stopSendService','dataSend','getStreamBufSize','recordStream'],
        lan:['startLanService','getLanUrl','getLanProxyPort'],
        prepare:['prepare','prepareService','preparePlay','startPlay','startPlayback','startLive']
      };
      const summary={};
      for(const [name,list] of Object.entries(groups))summary[name]=Object.fromEntries(list.map(x=>[x,{exported:dyn.defined.has(x),string:stringsPresent.includes(x),imported:dyn.undefined.has(x)}]));
      this.log('Tencent 2.4.50 ELF dynsym inspector',summary);
      const prepareExported=groups.prepare.filter(x=>dyn.defined.has(x));
      const prepareStringOnly=groups.prepare.filter(x=>stringsPresent.includes(x) && !dyn.defined.has(x));
      this.log('Tencent prepare/play ELF result',{exported:prepareExported,stringOnly:prepareStringOnly,reason:'ELF SHT_DYNSYM defined-symbol check; no unknown ABI invoked'});
      return {exported,imported,stringsPresent,stringsAbsent,summary};
    }catch(err){
      this.log('Tencent ELF export inspector failed',{message:err.message});
      return null;
    }
  }
  expected(){ return {
    'bin/dreame-xp2p-host-runner': WORKER_SHA256,
    'lib/libiot_video_demo.so': TENCENT_LIB_SHA256,
    'lib/libnodelab_dnsfix.so': 'b5adacdf2ad72511ed32dcdb88243971338f285713be356cb48fdd68c8656348',
    'lib/libnodelab_xnettrace.so': 'bf9ebdfcb2d0f3efcdcc00a613cf7cb4e1282365b4afc69efe0e05cafa566cd0',
    ...Object.fromEntries(Object.values(AOSP_FILES).map(([rel,h])=>[rel,h])),
    ...Object.fromEntries(Object.entries(VNDK_FILES).map(([rel,[,h]])=>[rel,h])),
  }; }
  validate(root=ROOT){ try { const m=JSON.parse(fs.readFileSync(path.join(root,MANIFEST),'utf8')); if(m.version!==1||m.arch!==process.arch)return false; for(const [rel,h] of Object.entries(this.expected())){ const p=path.join(root,rel); if(!fs.statSync(p).isFile()||sha256(fs.readFileSync(p))!==h)return false; } return true; } catch(_){ return false; } }
  async ensureInstalled(){
    if(this.validate()) { this.log('runtime already verified'); this._inspectTencentExports(ROOT); return ROOT; }
    if(this._installPromise)return this._installPromise;
    this._installPromise=this._install().then((root)=>{ this._inspectTencentExports(root); return root; }).finally(()=>{this._installPromise=null;});
    return this._installPromise;
  }
  async _install(){
    const pageSize=this.pageSize(); this.log('bootstrap start',{platform:process.platform,arch:process.arch,pageSize});
    if(process.platform!=='linux'||process.arch!=='arm64')throw new Error(`unsupported Homey host ${process.platform}/${process.arch}`);
    if(pageSize>4096)throw new Error(`Homey page size ${pageSize} requires Tencent 2.4.71 large-page runtime; this build safely stops instead of installing incompatible binaries`);
    const stage=`${ROOT}.install-${Date.now()}`; try{ fs.rmSync(stage,{recursive:true,force:true}); mkdirp(stage);
      const bundled=path.join(this.device.homey?.app?.getPath?.()||process.cwd(),'native','xp2p','runtime');
      this.log('stage 1/5 bundled open-source worker');
      const copyBundled=(rel,hash,mode=0o644)=>{const source=path.join(bundled,rel);const bytes=fs.readFileSync(source);return writeVerified(stage,rel,bytes,hash,mode);};
      copyBundled('bin/dreame-xp2p-host-runner',WORKER_SHA256,0o755);
      for (const rel of ['lib/libnodelab_dnsfix.so','lib/libnodelab_xnettrace.so']) copyBundled(rel,this.expected()[rel]);
      this.log('stage 2/5 Tencent SDK download'); const aar=await download(TENCENT_AAR_URL,60000); requireHash(aar,TENCENT_AAR_SHA256,'Tencent XP2P AAR'); const lib=zipEntry(aar,'jni/arm64-v8a/libiot_video_demo.so'); writeVerified(stage,'lib/libiot_video_demo.so',lib,TENCENT_LIB_SHA256);
      this.log('stage 3/5 bundled AOSP Bionic runtime'); for(const [, [rel,h,mode]] of Object.entries(AOSP_FILES))copyBundled(rel,h,mode);
      this.log('stage 4/5 bundled AOSP VNDK libraries'); for(const [rel,[,h]] of Object.entries(VNDK_FILES))copyBundled(rel,h);
      this.log('stage 5/5 final verification'); fs.writeFileSync(path.join(stage,MANIFEST),JSON.stringify({version:1,arch:process.arch,pageSize,source:'Bundled Homey XP2P reference worker / Tencent XP2P 2.4.50',files:this.expected()},null,2)); if(!this.validate(stage))throw new Error('installed runtime failed final hash validation');
      fs.rmSync(ROOT,{recursive:true,force:true}); fs.renameSync(stage,ROOT); this.log('runtime install complete',{root:ROOT}); return ROOT;
    }catch(err){ fs.rmSync(stage,{recursive:true,force:true}); this.log('bootstrap failed',{message:err.message}); throw err; }
  }
}
module.exports=DreameXp2pRuntimeBootstrap;

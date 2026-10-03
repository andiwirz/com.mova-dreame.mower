/* NodeLab v8.55 - single-delegate XP2P Bionic AArch64 host runner.
 * Based on the documented Tencent 2.4.50 ABI / DXP1-DXR1 wire contract.
 * Strict status confirmation for all normal commands. An explicit outdoor-test
 * sentinel permits one UNCONFIRMED delegate to be returned for a bounded,
 * separately labelled diagnostic GET. No stream GET in C or internal AV start.
 */
typedef unsigned long usize;
typedef unsigned long long u64;
typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;
typedef long ssize;
#define NULL ((void*)0)
#define RTLD_NOW 2
#define RTLD_GLOBAL 0x100
#define MAX_FIELD 1048576U
extern ssize read(int,void*,usize);
extern ssize write(int,const void*,usize);
extern int dup(int);
extern int dup2(int,int);
extern void *malloc(usize);
extern void free(void*);
extern void *memcpy(void*,const void*,usize);
extern void *memset(void*,int,usize);
extern int memcmp(const void*,const void*,usize);
extern usize strlen(const char*);
extern int strcmp(const char*,const char*);
extern char *strstr(const char*,const char*);
extern int usleep(unsigned int);
extern int snprintf(char*,usize,const char*,...);
extern void *dlopen(const char*,int);
extern void *dlsym(void*,const char*);
extern int dlclose(void*);
static int result_fd=1;
static volatile int ready_event=0;
static void msg(const char*s){write(2,s,strlen(s));write(2,"\n",1);}
static int rd(void*p,usize n){u8*b=p;while(n){ssize z=read(0,b,n);if(z<=0)return -1;b+=z;n-=z;}return 0;}
static int wr(const void*p,usize n){const u8*b=p;while(n){ssize z=write(result_fd,b,n);if(z<=0)return -1;b+=z;n-=z;}return 0;}
static u32 from32(const u8*b){return ((u32)b[0]<<24)|((u32)b[1]<<16)|((u32)b[2]<<8)|b[3];}
static void to32(u8*b,u32 v){b[0]=v>>24;b[1]=v>>16;b[2]=v>>8;b[3]=v;}
static int ru32(u32*v){u8 b[4];if(rd(b,4))return -1;*v=from32(b);return 0;}
static int ru64(u64*v){u8 b[8];if(rd(b,8))return -1;*v=0;for(int i=0;i<8;i++)*v=(*v<<8)|b[i];return 0;}
static int respond(u32 code,const char*data){u8 h[12]={'D','X','R','1'};usize n=data?strlen(data):0;to32(h+4,code);to32(h+8,(u32)n);return wr(h,12)|| (n&&wr(data,n));}
static u32 to_uint(const char*s,u32 fallback){if(!s||!*s)return fallback;u32 v=0;for(;*s;s++){if(*s<'0'||*s>'9')return fallback;v=v*10+(*s-'0');}return v;}
static int json_status(const u8*b,usize n,int*out){const char key[]="\"status\"";if(!b||n<8)return -1;for(usize i=0;i+8<=n;i++){if(memcmp(b+i,key,8))continue;usize p=i+8;while(p<n&&(b[p]==' '||b[p]=='\n'||b[p]=='\r'||b[p]=='\t'||b[p]==':'))p++;if(p<n&&b[p]=='\"')p++;int sign=1;if(p<n&&b[p]=='-'){sign=-1;p++;}if(p>=n||b[p]<'0'||b[p]>'9')return -1;int v=0;while(p<n&&b[p]>='0'&&b[p]<='9'){v=v*10+(b[p]-'0');p++;}*out=v*sign;return 0;}return -1;}
static char*add_path(const char*base,const char*path){if(!base||!path||!base[0])return NULL;usize a=strlen(base),b=strlen(path);if(a>8192||b>2048)return NULL;if(strstr(base,"ipc.flv")){char*r=malloc(a+1);if(r)memcpy(r,base,a+1);return r;}usize skip=0;while(path[skip]=='/')skip++;int slash=(base[a-1]!='/');char*r=malloc(a+slash+b-skip+1);if(!r)return NULL;memcpy(r,base,a);if(slash)r[a++]='/';memcpy(r+a,path+skip,b-skip+1);return r;}
enum { LIB,STUN,SERVICE,DELEGATE,PRODUCT,DEVICE,P2P,SID,SKEY,FLV,STATUS,LIVE,SERVER,IP,PORT,PROTOCOL,CROSS,TRANSPORT,LANIP,LANPORT,FIELD_COUNT };
static char*field[FIELD_COUNT];
static void wipe(char*p){if(p){volatile u8*b=(volatile u8*)p;while(*b)*b++=0;}}
static void cleanup(void){wipe(field[P2P]);wipe(field[SID]);wipe(field[SKEY]);for(int i=0;i<FIELD_COUNT;i++){free(field[i]);field[i]=NULL;}}
static int parse(u64*timeout,u32*attempts,u32*delay,u32*delegates,u32*delegate_delay){u8 magic[4];u32 count;if(rd(magic,4)||memcmp(magic,"DXP1",4)||ru32(&count)||count!=FIELD_COUNT)return -1;for(int i=0;i<FIELD_COUNT;i++){u32 n;if(ru32(&n)||n>MAX_FIELD)return -1;field[i]=malloc((usize)n+1);if(!field[i]||(n&&rd(field[i],n)))return -1;field[i][n]=0;}if(ru64(timeout)||ru32(attempts)||ru32(delay)||ru32(delegates)||ru32(delegate_delay))return -1;return !field[LIB][0]||!field[SERVICE][0]||!field[DELEGATE][0]||!field[PRODUCT][0]||!field[DEVICE][0]||!field[P2P][0]||!field[STATUS][0]||!field[FLV][0]||strcmp(field[TRANSPORT],"cloud")? -1:0;}
static void status_trace(u32 attempt,u32 total,int native,usize length,int parsed,int status){
 char b[192];int n=snprintf(b,sizeof(b),"XP2P_STATUS_RESULT attempt=%u/%u native=%d length=%lu parsed=%d status=%d",attempt,total,native,(unsigned long)length,parsed,status);
 if(n>0 && (usize)n<sizeof(b))msg(b);
}
static void recv_cb(const char*a,u8*b,usize n){(void)a;(void)b;(void)n;}
static const char*msg_cb(const char*a,int type,const char*b){(void)a;(void)b;if(type==1004){ready_event=1004;msg("XP2P_REFERENCE_READY_EVENT=1004");}else if(type==1005){ready_event=1005;msg("XP2P_REFERENCE_DETECT_ERROR=1005");}return "";}
static char*dev_cb(const char*a,u8*b,usize n){(void)a;(void)b;(void)n;static char r[]="app reply to device";return r;}
typedef void (*callback_fn)(void(*)(const char*,u8*,usize),const char*(*)(const char*,int,const char*),char*(*)(const char*,u8*,usize));
typedef int (*start_fn)(const char*,const char*,const char*,int);
typedef int (*info_fn)(const char*,const char*);
typedef int (*command_fn)(const char*,const u8*,usize,u8**,usize*,u64);
typedef const char*(*delegate_fn)(const char*);
typedef void (*stop_fn)(const char*);
typedef int (*qcred_fn)(const char*,const char*);
typedef void (*stun_fn)(const char*,u16);
typedef int (*link_fn)(const char*);
static int run(void){u64 timeout=0;u32 attempts=0,delay=0,delegates=0,delegate_delay=0,code=0;const char*error="";void*lib=NULL;int started=0;char*url=NULL;char*reply=NULL;
 if(parse(&timeout,&attempts,&delay,&delegates,&delegate_delay)){respond(1,"Invalid DXP1 request");cleanup();return 1;}
 result_fd=dup(1);if(result_fd<0||dup2(2,1)<0){respond(1,"Worker output setup failed");cleanup();return 1;}
 lib=dlopen(field[LIB],RTLD_NOW|RTLD_GLOBAL);if(!lib){code=2;error="XP2P runtime load failed";goto done;}
 start_fn start=(start_fn)dlsym(lib,"startService");info_fn info=(info_fn)dlsym(lib,"setDeviceXp2pInfo");command_fn command=(command_fn)dlsym(lib,"postCommandRequestSync");delegate_fn delegate=(delegate_fn)dlsym(lib,"delegateHttpFlv");callback_fn callbacks=(callback_fn)dlsym(lib,"setUserCallbackToXp2p");stop_fn stop=(stop_fn)dlsym(lib,"stopService");stun_fn stun=(stun_fn)dlsym(lib,"setStunServerToXp2p");qcred_fn qcred=(qcred_fn)dlsym(lib,"setQcloudApiCred");link_fn link=(link_fn)dlsym(lib,"getStreamLinkMode");
 if(!start||!info||!command||!delegate||!callbacks){code=3;error="XP2P mandatory symbol absent";goto done;}
 callbacks(recv_cb,msg_cb,dev_cb);
 if(stun&&field[STUN][0])stun(field[STUN],(u16)to_uint(field[PORT],20002));
 if(qcred&&field[SID][0]&&field[SKEY][0]&&qcred(field[SID],field[SKEY])){code=10;error="XP2P QCloud credentials rejected";goto done;}
 /* Pinned 2.4.50 legacy ABI: fourth argument is protocol int, not config ptr. */
 int protocol=(int)to_uint(field[PROTOCOL],2);if(protocol!=2){code=11;error="XP2P protocol must be reference TCP mode 2";goto done;}
 msg("XP2P_REFERENCE_PATH mode=tcp2 sdk_internal_av=0 http_requests_in_worker=0");
 if(start(field[SERVICE],field[PRODUCT],field[DEVICE],protocol)){code=11;error="XP2P startService failed";goto done;}started=1;
 if(info(field[SERVICE],field[P2P])){code=12;error="XP2P setDeviceXp2pInfo failed";goto done;}
 if(!attempts)attempts=8;if(attempts>12)attempts=12;if(delay>2000)delay=2000;
 for(u32 i=0;i<attempts&&ready_event!=1004&&ready_event!=1005;i++)usleep(delay*1000);
 if(ready_event!=1004){code=17;error="XP2P no ready event";goto done;}
 /* LIVE is otherwise unused by this host runner. The exact sentinel is set
  * only by the operator-attested outdoor-test command, never config.json. */
 int diagnostic_one_shot=strcmp(field[LIVE],"nodelab-outdoor-unconfirmed-delegate-once")==0;
 int accepted=0;for(u32 i=0;i<attempts;i++){u8*response=NULL;usize length=0;int stat=-1;int rc=command(field[DELEGATE],(const u8*)field[STATUS],strlen(field[STATUS]),&response,&length,timeout);
 int parsed=(rc==0 && length<=MAX_FIELD && json_status(response,length,&stat)==0);
 status_trace(i+1,attempts,rc,length,parsed,stat);
 if(rc==0&&parsed&&stat==0){msg("XP2P_STATUS_CONFIRMED status=0");accepted=1;break;}
 if(rc==0&&length==0)msg("XP2P_STATUS_EMPTY no_fallback=1");else msg("XP2P_STATUS_UNCONFIRMED no_fallback=1");
 if(i+1<attempts)usleep(delay*1000);
 }
 if(!accepted){
  /* One availability check. Never imply that a successful delegate lookup
   * confirms the device status. Normal video/xp2p still fail closed. */
  const char*maybe=delegate(field[DELEGATE]);
  msg(maybe&&maybe[0] ? "XP2P_DELEGATE_PROBE status_confirmed=0 available=1 flv_get=0 url_redacted=1" :
      "XP2P_DELEGATE_PROBE status_confirmed=0 available=0 flv_get=0 url_redacted=1");
  if(!diagnostic_one_shot){code=14;error="XP2P status not confirmed 0; FLV forbidden";goto done;}
  if(!maybe||!maybe[0]){code=14;error="XP2P status not confirmed; delegate unavailable";goto done;}
  url=add_path(maybe,field[FLV]);
  msg("XP2P_UNCONFIRMED_DELEGATE status_confirmed=0 outdoor_only=1 native_get=0 url_redacted=1");
 }else{
  if(!delegates)delegates=8;if(delegates>12)delegates=12;if(delegate_delay>2000)delegate_delay=2000;
  for(u32 i=0;i<delegates;i++){const char*prefix=delegate(field[DELEGATE]);if(prefix&&prefix[0]){url=add_path(prefix,field[FLV]);if(url)break;}if(i+1<delegates)usleep(delegate_delay*1000);}
 }
 if(!url){code=16;error="XP2P delegateHttpFlv unavailable";goto done;}
 if(strlen(url)>16384){code=16;error="XP2P delegate URL too long";goto done;}
 {const char*mode="0\n";const char*state=accepted?"C\n":"U\n";if(link){int val=link(field[SERVICE]);if(val==62)mode="62\n";else if(val==63)mode="63\n";}usize s=strlen(state),m=strlen(mode),n=strlen(url);reply=malloc(s+m+n+1);if(!reply){code=16;error="XP2P response allocation failed";goto done;}memcpy(reply,state,s);memcpy(reply+s,mode,m);memcpy(reply+s+m,url,n+1);}
 msg(accepted?"XP2P_DELEGATE_READY internal_av=0 status_confirmed=1 url_redacted=1":
              "XP2P_DELEGATE_READY internal_av=0 status_confirmed=0 outdoor_only=1 url_redacted=1");
 done:respond(code,code?error:reply);if(code==0){u8 x;while(read(0,&x,1)==1){if(x=='Q')continue;break;}}
 if(started&&stop)stop(field[SERVICE]);free(url);free(reply);/* SDK worker threads can outlive stopService; process exit unloads safely. */cleanup();return code==0?0:(int)code;
}
__attribute__((noreturn))void _start(void){int rc=run();__asm__ volatile("mov x0, %0\nmov x8, #93\nsvc #0"::"r"((long)rc):"x0","x8");__builtin_unreachable();}

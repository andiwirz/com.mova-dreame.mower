#include "candidate_packet.h"
typedef unsigned long size_t;
typedef __builtin_va_list va_list;
extern long write(int,const void*,size_t);
extern void *dlsym(void*, const char*);
#define RTLD_NEXT ((void*)-1L)
typedef void *(*mem_fn)(void*,const void*,size_t);
typedef int (*vsn_fn)(char*,size_t,const char*,va_list);
struct dl_info { const char *dli_fname; void *dli_fbase; const char *dli_sname; void *dli_saddr; };
typedef int (*dladdr_fn)(const void*, struct dl_info*);
typedef long ssize_t;
typedef unsigned int socklen_t;
struct sockaddr { unsigned short sa_family; char sa_data[14]; };
struct sockaddr_in { unsigned short sin_family; unsigned short sin_port; unsigned int sin_addr; unsigned char sin_zero[8]; };
typedef ssize_t (*sendto_fn)(int,const void*,size_t,int,const struct sockaddr*,socklen_t);
typedef ssize_t (*recvfrom_fn)(int,void*,size_t,int,struct sockaddr*,socklen_t*);
typedef ssize_t (*recv_fn)(int,void*,size_t,int);
typedef ssize_t (*read_fn)(int,void*,size_t);
typedef int (*connect_fn)(int,const struct sockaddr*,socklen_t);
typedef ssize_t (*send_fn)(int,const void*,size_t,int);
struct iovec { void *iov_base; size_t iov_len; };
struct msghdr { void *msg_name; socklen_t msg_namelen; struct iovec *msg_iov; size_t msg_iovlen; void *msg_control; size_t msg_controllen; int msg_flags; };
typedef ssize_t (*sendmsg_fn)(int,const struct msghdr*,int);
typedef ssize_t (*writev_fn)(int,const struct iovec*,int);
typedef int (*memcmp_fn)(const void*,const void*,size_t);
typedef ssize_t (*recvmsg_fn)(int,struct msghdr*,int);
typedef int (*getpeername_fn)(int,struct sockaddr*,socklen_t*);
typedef int (*getsockname_fn)(int,struct sockaddr*,socklen_t*);
typedef int (*getsockopt_fn)(int,int,int,void*,socklen_t*);
static getsockname_fn real_getsockname;
static getsockopt_fn real_getsockopt;
static unsigned char a2_exact_fds[1024];
static unsigned a2_rx_events=0;
static mem_fn real_memcpy, real_memmove;
static dladdr_fn real_dladdr;
static vsn_fn real_vsnprintf;
static memcmp_fn real_memcmp;
static sendto_fn real_sendto; static recvfrom_fn real_recvfrom; static recv_fn real_recv; static read_fn real_read; static connect_fn real_connect; static send_fn real_send; static sendmsg_fn real_sendmsg; static writev_fn real_writev; static recvmsg_fn real_recvmsg; static getpeername_fn real_getpeername; static ssize_t (*real_write_next)(int,const void*,size_t);
static int guard=0,hits=0,repairs=0,flv_reported=0,net_hits=0,pkt134_hits=0,consumer_hits=0,worker_diag_hits=0,forward_dispatch_hits=0,forward_handler_hits=0; static unsigned long flv_bytes=0;
/* v8.49: observe the original candidate TLV without altering local or remote
   endpoints. Keep the parser trace bounded to avoid unrelated SDK log churn. */
static int a2_trace_window=0,a2_trace_events=0,a2_parser_seen=0;
static unsigned long a2_last_character=0,a2_last_peer=0;
static const char needle[]=".xnet/ipc.p2p.com/ipc.flv";
static const char peerkey[]="&_peername=";
static size_t slen(const char*s){size_t n=0;if(!s)return 0;while(s[n])n++;return n;}
static void emit(const char*s){write(2,s,slen(s));}
static int findbytes(const unsigned char*p,size_t n,const char*q,size_t m,size_t*pos){if(!p||n<m)return 0;for(size_t i=0;i+m<=n;i++){size_t j=0;for(;j<m;j++)if(p[i+j]!=(unsigned char)q[j])break;if(j==m){if(pos)*pos=i;return 1;}}return 0;}
static int hasneedle(const unsigned char*p,size_t n,size_t*pos){return findbytes(p,n,needle,sizeof(needle)-1,pos);}
static char hx(unsigned v){return (char)(v<10?'0'+v:'a'+v-10);}
static void emit_hexul(char*b,size_t*k,unsigned long x){int started=0;for(int sh=(int)(sizeof(unsigned long)*8)-4;sh>=0;sh-=4){unsigned v=(unsigned)((x>>sh)&15);if(v||started||sh==0){started=1;b[(*k)++]=hx(v);}}}
static int contains_text(const char*s,size_t n,const char*q){size_t p=0;return findbytes((const unsigned char*)s,n,q,slen(q),&p);}
static void trace_callsite(const char*event,const void*caller){if(!caller)return;struct dl_info di={0};if(!real_dladdr)real_dladdr=(dladdr_fn)dlsym(RTLD_NEXT,"dladdr");char b[520];size_t k=0;const char*a="XNETCALLSITE event=";for(size_t i=0;a[i];i++)b[k++]=a[i];for(size_t i=0;event[i];i++)b[k++]=event[i];a=" caller=0x";for(size_t i=0;a[i];i++)b[k++]=a[i];emit_hexul(b,&k,(unsigned long)caller);if(real_dladdr&&real_dladdr(caller,&di)&&di.dli_fbase){a=" base=0x";for(size_t i=0;a[i];i++)b[k++]=a[i];emit_hexul(b,&k,(unsigned long)di.dli_fbase);a=" offset=0x";for(size_t i=0;a[i];i++)b[k++]=a[i];emit_hexul(b,&k,(unsigned long)caller-(unsigned long)di.dli_fbase);if(di.dli_fname){a=" module=";for(size_t i=0;a[i];i++)b[k++]=a[i];for(size_t i=0;di.dli_fname[i]&&k+2<sizeof(b);i++)b[k++]=di.dli_fname[i];}}b[k++]='\n';write(2,b,k);}



static void a2_decision_backtrace(const char*event);
static void emit_u(char*b,size_t*k,unsigned long x);
static unsigned long parse_hex_after(const char*s,size_t n,const char*key){
  size_t pos=0,kl=slen(key);if(!findbytes((const unsigned char*)s,n,key,kl,&pos))return 0;pos+=kl;
  unsigned long v=0;int any=0;for(;pos<n;pos++){unsigned char c=(unsigned char)s[pos];unsigned d;if(c>='0'&&c<='9')d=c-'0';else if(c>='a'&&c<='f')d=c-'a'+10;else if(c>='A'&&c<='F')d=c-'A'+10;else break;v=(v<<4)|d;any=1;}return any?v:0;
}
static void a2_capture_object_ids(const char*text,size_t n){
  if(!text||!n)return;unsigned long v;
  v=parse_hex_after(text,n,"peer 0x");if(v)a2_last_peer=v;
  v=parse_hex_after(text,n,"new character:0x");if(v){a2_last_character=v;char b[220];size_t k=0;const char*p="XNET_A2_CHARACTER_CAPTURE source=new ptr=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,v);b[k++]='\n';write(2,b,k);}
  v=parse_hex_after(text,n,"delete character:0x");if(v){a2_last_character=v;char b[220];size_t k=0;const char*p="XNET_A2_CHARACTER_CAPTURE source=delete ptr=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,v);b[k++]='\n';write(2,b,k);}
}
static void a2_dump_object(const char*event,const char*name,unsigned long ptr){
  if(ptr<0x10000UL)return;const unsigned char*m=(const unsigned char*)ptr;char d[900];size_t z=0;const char*h="XNET_A2_OBJECT_SNAPSHOT event=";
  for(size_t i=0;h[i];i++)d[z++]=h[i];for(size_t i=0;event[i];i++)d[z++]=event[i];h=" object=";for(size_t i=0;h[i];i++)d[z++]=h[i];for(size_t i=0;name[i];i++)d[z++]=name[i];h=" ptr=0x";for(size_t i=0;h[i];i++)d[z++]=h[i];emit_hexul(d,&z,ptr);h=" bytes96=";for(size_t i=0;h[i];i++)d[z++]=h[i];
  for(size_t i=0;i<96&&z+2<sizeof(d);i++){unsigned char v=m[i];d[z++]=hx(v>>4);d[z++]=hx(v&15);}d[z++]='\n';write(2,d,z);
}

static void a2_dump_character_state(const char*text,size_t n){
  if(!text||!n||!contains_text(text,n,"new character level")||a2_last_character<0x10000UL)return;
  char b[1300];size_t k=0;const char*p="XNET_CHARACTER_STATE ptr=0x";
  for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,a2_last_character);p=" text=\"";for(size_t i=0;p[i];i++)b[k++]=p[i];
  for(size_t i=0;i<n&&k+3<sizeof(b);i++){char c=text[i];if(c=='\n'||c=='\r')c=' ';if(c=='\"')c='\'';b[k++]=c;}b[k++]='\"';b[k++]='\n';write(2,b,k);
  a2_dump_object("character_state","character_logptr",a2_last_character);
}

static void a2_dump_peer_selected(const char*event){
  if(a2_last_peer<0x10000UL)return;
  /* Static v8.23 finding: the candidate-selection routine stores its retained
     character pointer at peer + 0xa0 (instruction 0x187530). Read-only dump. */
  unsigned long selected=*(const unsigned long*)(a2_last_peer+0xa0UL);
  char b[300];size_t k=0;const char*p="XNET_A2_SELECTED_SLOT event=";
  for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;event[i];i++)b[k++]=event[i];
  p=" peer=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,a2_last_peer);
  p=" peer_plus_a0=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,selected);b[k++]='\n';write(2,b,k);
  a2_dump_object(event,"peer_plus_a0_selected",selected);
}

static void a2_trace_retained_consumer(const char*text,size_t n,const void*caller){
  if(!a2_trace_window||!text||!n||a2_last_peer<0x10000UL||consumer_hits>=48)return;
  unsigned long selected=*(const unsigned long*)(a2_last_peer+0xa0UL);
  if(selected<0x10000UL)return;
  const unsigned char*m=(const unsigned char*)selected;
  if(!(m[8]==0x02&&m[9]==0x00&&m[10]==0xdf&&m[11]==0x1c&&m[12]==192&&m[13]==0&&m[14]==2&&m[15]==69))return;
  /* Static v8.25 anchor: 0x1876bc stores a selected Character into peer+0xa0,
     then 0x1876c0 loads vtable+0x40 and 0x1876c8 invokes it.  We do not hook
     or alter that callback.  Instead, correlate the subsequent SDK log
     callsites while the retained slot is the exact A2 LAN Character. */
  if(!real_dladdr)real_dladdr=(dladdr_fn)dlsym(RTLD_NEXT,"dladdr");
  char b[1300];size_t k=0;const char*p="XNET_A2_RETAINED_CONSUMER seq=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,(unsigned long)(++consumer_hits));
  p=" selected=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,selected);p=" caller=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,(unsigned long)caller);
  struct dl_info di={0};
  if(caller&&real_dladdr&&real_dladdr(caller,&di)&&di.dli_fbase){p=" offset=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,(unsigned long)caller-(unsigned long)di.dli_fbase);}
  p=" text=\"";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;i<n&&k+3<sizeof(b);i++){char c=text[i];if(c=='\n'||c=='\r')c=' ';if(c=='"')c='\'';b[k++]=c;}b[k++]='"';b[k++]='\n';write(2,b,k);
  a2_dump_peer_selected("retained_consumer");
}

static void a2_trace_forward_dispatch(const char*text,size_t n){
  if(!text||!n||forward_dispatch_hits>=12||!contains_text(text,n," forward "))return;
  unsigned long worker=parse_hex_after(text,n,"worker 0x");
  if(worker<0x10000UL)return;
  /* Exact v8.30 static path from this runtime:
     0x19622c -> 0x19f9e4, where x0 is the worker-like object.
     0x19fa08 computes worker+0x78; 0x19faa0 loads [worker+0x78],
     then 0x19faa8 loads that object's vtable and 0x19faac loads vtable+0x18;
     0x19fab0 invokes it with x0=dispatch object, x1=forward packet.
     Read-only observation only: never invoke or replace the target. */
  unsigned long dispatch=*(const unsigned long*)(worker+0x78UL);
  unsigned long vtable=0,target=0;
  if(dispatch>=0x10000UL)vtable=*(const unsigned long*)dispatch;
  if(vtable>=0x10000UL)target=*(const unsigned long*)(vtable+0x18UL);
  char b[760];size_t k=0;const char*p="XNET_A2_FORWARD_DISPATCH seq=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,(unsigned long)(++forward_dispatch_hits));
  p=" worker=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,worker);
  p=" dispatch=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,dispatch);
  p=" vtable=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,vtable);
  p=" target=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,target);
  if(target&&real_dladdr){struct dl_info di={0};if(real_dladdr((const void*)target,&di)&&di.dli_fbase){p=" target_offset=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,target-(unsigned long)di.dli_fbase);if(di.dli_fname){p=" module=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;di.dli_fname[i]&&k+2<sizeof(b);i++)b[k++]=di.dli_fname[i];}}}
  p=" static_callsite=0x19fab0 vtable_slot=0x18";for(size_t i=0;p[i]&&k+2<sizeof(b);i++)b[k++]=p[i];b[k++]='\n';write(2,b,k);
  if(dispatch>=0x10000UL)a2_dump_object("forward_dispatch","worker_plus_78_dispatch",dispatch);
  /* v8.31: the resolved handler is 0x19d92c. Static disassembly shows its
     actual downstream virtual call at 0x19d9f8: x0=dispatch, x1=forward
     packet, w2=global mode/state, target=[vtable+0x20]. Observe that target
     and nearby dispatch state only; do not invoke or modify it. */
  if(dispatch>=0x10000UL && vtable>=0x10000UL && target){
    unsigned long h2=*(const unsigned long*)(vtable+0x20UL);
    unsigned long state170=*(const unsigned long*)(dispatch+0x170UL);
    unsigned long state88=*(const unsigned long*)(dispatch+0x88UL);
    char c[820];size_t z=0;const char*q="XNET_A2_FORWARD_HANDLER seq=";for(size_t i=0;q[i];i++)c[z++]=q[i];emit_u(c,&z,(unsigned long)(++forward_handler_hits));
    q=" dispatch=0x";for(size_t i=0;q[i];i++)c[z++]=q[i];emit_hexul(c,&z,dispatch);
    q=" handler=0x";for(size_t i=0;q[i];i++)c[z++]=q[i];emit_hexul(c,&z,target);
    q=" downstream=0x";for(size_t i=0;q[i];i++)c[z++]=q[i];emit_hexul(c,&z,h2);
    if(h2&&real_dladdr){struct dl_info dj={0};if(real_dladdr((const void*)h2,&dj)&&dj.dli_fbase){q=" downstream_offset=0x";for(size_t i=0;q[i];i++)c[z++]=q[i];emit_hexul(c,&z,h2-(unsigned long)dj.dli_fbase);}}
    q=" state88=0x";for(size_t i=0;q[i];i++)c[z++]=q[i];emit_hexul(c,&z,state88);
    q=" state170=0x";for(size_t i=0;q[i];i++)c[z++]=q[i];emit_hexul(c,&z,state170);
    q=" static_handler=0x19d92c downstream_callsite=0x19d9f8 vtable_slot=0x20";for(size_t i=0;q[i]&&z+2<sizeof(c);i++)c[z++]=q[i];c[z++]='\n';write(2,c,z);

    /* v8.32: exact static disassembly of downstream 0x178e9c shows this is a
       forwarding thunk, not the final transport routine:
         ldr x9,[x0,#8] ; x2=x0+0x10 ; w3=w2 ; x0=x9 ; target=[vtable+0x28] ; br target
       Resolve the inner object and its +0x28 virtual target read-only. */
    if(h2 && real_dladdr){
      struct dl_info hk={0};
      if(real_dladdr((const void*)h2,&hk)&&hk.dli_fbase&&
         (h2-(unsigned long)hk.dli_fbase)==0x178e9cUL){
        unsigned long inner=*(const unsigned long*)(dispatch+0x8UL);
        unsigned long inner_vtable=0,inner_target=0;
        if(inner>=0x10000UL)inner_vtable=*(const unsigned long*)inner;
        if(inner_vtable>=0x10000UL)inner_target=*(const unsigned long*)(inner_vtable+0x28UL);
        char d[900];size_t y=0;const char*r="XNET_A2_FORWARD_INNER seq=";for(size_t i=0;r[i];i++)d[y++]=r[i];emit_u(d,&y,(unsigned long)forward_handler_hits);
        r=" dispatch=0x";for(size_t i=0;r[i];i++)d[y++]=r[i];emit_hexul(d,&y,dispatch);
        r=" inner=0x";for(size_t i=0;r[i];i++)d[y++]=r[i];emit_hexul(d,&y,inner);
        r=" inner_vtable=0x";for(size_t i=0;r[i];i++)d[y++]=r[i];emit_hexul(d,&y,inner_vtable);
        r=" inner_target=0x";for(size_t i=0;r[i];i++)d[y++]=r[i];emit_hexul(d,&y,inner_target);
        if(inner_target&&real_dladdr){struct dl_info hm={0};if(real_dladdr((const void*)inner_target,&hm)&&hm.dli_fbase){r=" inner_target_offset=0x";for(size_t i=0;r[i];i++)d[y++]=r[i];emit_hexul(d,&y,inner_target-(unsigned long)hm.dli_fbase);if(hm.dli_fname){r=" module=";for(size_t i=0;r[i];i++)d[y++]=r[i];for(size_t i=0;hm.dli_fname[i]&&y+2<sizeof(d);i++)d[y++]=hm.dli_fname[i];}}}
        r=" thunk=0x178e9c inner_vtable_slot=0x28 packet_view=dispatch_plus_0x10";for(size_t i=0;r[i]&&y+2<sizeof(d);i++)d[y++]=r[i];d[y++]='\n';write(2,d,y);
        if(inner>=0x10000UL)a2_dump_object("forward_inner","dispatch_plus_8_inner",inner);

        /* v8.33: static disassembly of the resolved inner handler 0x18eb64
           shows that it prepares packet metadata and then tail-dispatches via
           the SAME inner object's vtable slot +0x30 at 0x18ebf0 (br x5).
           Resolve that tail target read-only. No function is invoked and no
           packet/address/state is modified. */
        if(inner_target&&real_dladdr){
          struct dl_info hn={0};
          if(real_dladdr((const void*)inner_target,&hn)&&hn.dli_fbase&&
             (inner_target-(unsigned long)hn.dli_fbase)==0x18eb64UL){
            unsigned long tail_target=0;
            if(inner_vtable>=0x10000UL)tail_target=*(const unsigned long*)(inner_vtable+0x30UL);
            char e[900];size_t w=0;const char*t="XNET_A2_FORWARD_TAIL seq=";for(size_t i=0;t[i];i++)e[w++]=t[i];emit_u(e,&w,(unsigned long)forward_handler_hits);
            t=" inner=0x";for(size_t i=0;t[i];i++)e[w++]=t[i];emit_hexul(e,&w,inner);
            t=" inner_vtable=0x";for(size_t i=0;t[i];i++)e[w++]=t[i];emit_hexul(e,&w,inner_vtable);
            t=" tail_target=0x";for(size_t i=0;t[i];i++)e[w++]=t[i];emit_hexul(e,&w,tail_target);
            if(tail_target&&real_dladdr){struct dl_info ho={0};if(real_dladdr((const void*)tail_target,&ho)&&ho.dli_fbase){t=" tail_target_offset=0x";for(size_t i=0;t[i];i++)e[w++]=t[i];emit_hexul(e,&w,tail_target-(unsigned long)ho.dli_fbase);if(ho.dli_fname){t=" module=";for(size_t i=0;t[i];i++)e[w++]=t[i];for(size_t i=0;ho.dli_fname[i]&&w+2<sizeof(e);i++)e[w++]=ho.dli_fname[i];}}}
            t=" inner_handler=0x18eb64 tail_callsite=0x18ebf0 inner_vtable_slot=0x30";for(size_t i=0;t[i]&&w+2<sizeof(e);i++)e[w++]=t[i];e[w++]='\n';write(2,e,w);
          }
        }
      }
    }
  }
}

static void a2_trace_worker_progress(const char*text,size_t n,const void*caller){
  if(!text||!n||worker_diag_hits>=24||a2_last_peer<0x10000UL)return;
  const char*event=0;
  if(contains_text(text,n,"timeout occur"))event="worker_timeout";
  else if(contains_text(text,n,"timeout, resend packets"))event="worker_resend";
  else if(contains_text(text,n," forward "))event="worker_forward";
  else if(contains_text(text,n," State ")&&contains_text(text,n,"listen"))event="worker_listen";
  if(!event)return;
  worker_diag_hits++;
  unsigned long selected=*(const unsigned long*)(a2_last_peer+0xa0UL);
  int selected_is_lan=0;if(selected>=0x10000UL){const unsigned char*m=(const unsigned char*)selected;selected_is_lan=(m[8]==2&&m[9]==0&&m[10]==0xdf&&m[11]==0x1c&&m[12]==0xc0&&m[13]==0xa8&&m[14]==0xb2&&m[15]==0x45);}
  char b[640];size_t k=0;const char*p="XNET_A2_WORKER_PROGRESS event=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;event[i];i++)b[k++]=event[i];
  p=" seq=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,(unsigned long)worker_diag_hits);
  p=" caller=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,(unsigned long)caller);
  if(caller&&real_dladdr){struct dl_info di={0};if(real_dladdr(caller,&di)&&di.dli_fbase){p=" offset=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,(unsigned long)caller-(unsigned long)di.dli_fbase);}}
  p=" peer=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,a2_last_peer);p=" selected=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,selected);p=" selected_is_lan=";for(size_t i=0;p[i];i++)b[k++]=p[i];b[k++]=selected_is_lan?'1':'0';b[k++]='\n';write(2,b,k);
  a2_dump_object(event,"peer_plus_a0_selected",selected);
  a2_decision_backtrace(event);
}

static void a2_branch_boundary(const char*path,unsigned long character,int callback_expected);
/* v8.41: sample SDK stack at the existing callback-adjacent log boundary.
   This is positive-only stack evidence, NOT an entry/return breakpoint. */
static unsigned a2_callback_stack_samples=0;
static void a2_callback_stack_probe(const char*phase){
  if(a2_callback_stack_samples++>=16)return;
  if(!real_dladdr)real_dladdr=(dladdr_fn)dlsym(RTLD_NEXT,"dladdr");
  char b[260];size_t k=0;const char*p="XNET_A2_CALLBACK_STACK_PROBE phase=";
  for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;phase[i];i++)b[k++]=phase[i];
  p=" seq=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,a2_callback_stack_samples);
  p=" callback_offset=0x188600 method=unwind_sample entry_or_return_hook=0 payload=redacted\n";
  for(size_t i=0;p[i];i++)b[k++]=p[i];write(2,b,k);
  a2_decision_backtrace(phase);
}

static void a2_trace_selection_callback(const char*text,size_t n){
  if(!text||!n||a2_last_peer<0x10000UL||!contains_text(text,n,"insert character"))return;
  unsigned long inserted=parse_hex_after(text,n,"insert character 0x");
  if(inserted<0x10000UL)return;
  const unsigned char*c=(const unsigned char*)inserted;
  /* Only correlate the exact corrected A2 LAN Character. sockaddr +8: AF_INET, port df1c, 192.0.2.69. */
  if(!(c[8]==0x02&&c[9]==0x00&&c[10]==0xdf&&c[11]==0x1c&&c[12]==0xc0&&c[13]==0x00&&c[14]==0x02&&c[15]==0x45))return;
  unsigned long vtable=*(const unsigned long*)a2_last_peer;
  unsigned long target=0;if(vtable>0x10000UL)target=*(const unsigned long*)(vtable+0x40UL);
  char b[700];size_t k=0;const char*p="XNET_A2_SELECTION_CALLBACK_PRE seq=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,(unsigned long)(++consumer_hits));
  p=" peer=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,a2_last_peer);
  p=" inserted=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,inserted);
  p=" vtable=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,vtable);
  p=" target=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,target);
  if(target&&real_dladdr){struct dl_info di={0};if(real_dladdr((const void*)target,&di)&&di.dli_fbase){unsigned long off=target-(unsigned long)di.dli_fbase;p=" target_offset=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,off);}}
  p=" static_callsite=0x1876c8 reason=new_character";for(size_t i=0;p[i]&&k+2<sizeof(b);i++)b[k++]=p[i];b[k++]='\n';write(2,b,k);
  a2_dump_object("selection_callback_pre","inserted_lan_character",inserted);
  a2_branch_boundary("new_character_before_callback",inserted,1);
  a2_callback_stack_probe("callback_adjacent_insert");
}

/* v8.40: observe the two existing selection branches at their SDK log
   boundaries. These markers are correlations, NOT instruction-level hooks:
   the replacement copy precedes its delete log, while the new-character
   callback follows its insert log. Never call the vtable or alter memory. */
/* v8.45: uncapped, metadata-only transport accounting. Unlike ALL_TX (320)
   and LAN_HANDOFF (180), these counters cover the whole SDK run. They do not
   read payloads, dereference peer objects, send packets, or change routing. */
static unsigned long a2_tx_total=0,a2_tx_lan=0,a2_tx_tencent=0,a2_tx_dns=0,a2_tx_other=0,a2_tx_unspecified=0,a2_tx_failed=0;
static unsigned long a2_connect_total=0,a2_connect_lan=0,a2_connect_failed=0,a2_tx_after_selection=0;
static unsigned long a2_selected_observations=0;
static int a2_transport_class(const struct sockaddr*sa,socklen_t len){
  if(!sa||len<8)return 0;
  const unsigned char*a=(const unsigned char*)sa;const unsigned char*ip=0;
  if(sa->sa_family==2){ip=a+4;}
  else if(sa->sa_family==10&&len>=28){
    int mapped=1;for(int i=8;i<18;i++)if(a[i])mapped=0;
    if(a[18]!=255||a[19]!=255)mapped=0;
    if(mapped)ip=a+20;
  }
  if(!ip)return 4;
  unsigned port=((unsigned)a[2]<<8)|a[3];
  if(ip[0]==192&&ip[1]==168&&ip[2]==178&&ip[3]==69&&port==57116)return 1;
  if(ip[0]==43&&ip[1]==158&&ip[2]==113&&ip[3]==38&&port==20002)return 2;
  if(ip[0]==114&&ip[1]==114&&ip[2]==114&&ip[3]==114&&port==53)return 3;
  return 4;
}
/* v8.46: read-only state snapshot at the actual selection-log boundary.
   Static anchors: 0x187530 writes peer+0xa0; 0x1877b8 writes peer+0xc0,
   0x1877b4 reads peer+0x78. These are observations, not transport proofs. */
static void a2_selection_state_snapshot(const char*phase){
  if(a2_last_peer<0x10000UL)return;
  const unsigned char*peer=(const unsigned char*)a2_last_peer;
  unsigned long selected=*(const unsigned long*)(peer+0xa0);
  unsigned long tree78=*(const unsigned long*)(peer+0x78);
  unsigned long map28=*(const unsigned long*)(peer+0x28);
  unsigned long tree70=*(const unsigned long*)(peer+0x70);
  unsigned char state_c0=peer[0xc0];
  int selected_lan=0;
  if(selected>=0x10000UL){const unsigned char*c=(const unsigned char*)selected;
    selected_lan=c[8]==2&&c[9]==0&&c[10]==0xdf&&c[11]==0x1c&&
      c[12]==192&&c[13]==168&&c[14]==178&&c[15]==69;}
  char b[420];size_t k=0;const char*t="XNET_A2_SELECTION_STATE phase=";
  for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;phase[i];i++)b[k++]=phase[i];
  t=" selected_is_lan=";for(size_t i=0;t[i];i++)b[k++]=t[i];b[k++]=selected_lan?'1':'0';
  t=" state_c0=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,state_c0);
  t=" tree78_present=";for(size_t i=0;t[i];i++)b[k++]=t[i];b[k++]=tree78?'1':'0';
  t=" tree70_present=";for(size_t i=0;t[i];i++)b[k++]=t[i];b[k++]=tree70?'1':'0';
  t=" map28_present=";for(size_t i=0;t[i];i++)b[k++]=t[i];b[k++]=map28?'1':'0';
  t=" static_selected_store=0x187530 static_state_write=0x1877b8 static_tree78_read=0x1877b4 meaning=unverified payload=redacted\n";
  for(size_t i=0;t[i]&&k+2<sizeof(b);i++)b[k++]=t[i];write(2,b,k);
}
static void a2_transport_summary(const char*phase){
  char b[580];size_t k=0;const char*t="XNET_A2_TRANSPORT_SUMMARY phase=";
  for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;phase[i];i++)b[k++]=phase[i];
#define A2_SUM(field,value) do{t=field;for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)(value));}while(0)
  A2_SUM(" sdk_tx_total=",a2_tx_total);A2_SUM(" lan_tx=",a2_tx_lan);
  A2_SUM(" tencent_tx=",a2_tx_tencent);A2_SUM(" dns_tx=",a2_tx_dns);
  A2_SUM(" other_tx=",a2_tx_other);A2_SUM(" unspecified_tx=",a2_tx_unspecified);
  A2_SUM(" failed_tx=",a2_tx_failed);A2_SUM(" sdk_connect=",a2_connect_total);
  A2_SUM(" lan_connect=",a2_connect_lan);A2_SUM(" failed_connect=",a2_connect_failed);
  A2_SUM(" tx_after_selected_observation=",a2_tx_after_selection);
  A2_SUM(" selected_observations=",a2_selected_observations);
#undef A2_SUM
  t=" scope=interposed_sdk_libc_calls_no_raw_syscalls payload=redacted\n";
  for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);
}
static void a2_transport_account(int fd_for_account,const void*caller,const struct sockaddr*dest,socklen_t len,long result,int is_connect){
  if(!caller)return;
  if(!real_dladdr)real_dladdr=(dladdr_fn)dlsym(RTLD_NEXT,"dladdr");
  struct dl_info di={0};if(!real_dladdr||!real_dladdr(caller,&di)||!di.dli_fname||
     !contains_text(di.dli_fname,slen(di.dli_fname),"libiot_video_demo.so"))return;
  /* v8.47: a connected socket can have a destination even when the API call
     supplies no sockaddr (send/sendmsg/writev). Query only its existing peer;
     never connect, transmit, or change the supplied destination. */
  struct sockaddr_in6_opaque { unsigned char bytes[128]; } peerbuf;
  const struct sockaddr *effective=dest;
  socklen_t effective_len=len;
  if(!is_connect && (!dest || len<2) && real_getpeername){
    socklen_t plen=(socklen_t)sizeof(peerbuf);
    if(real_getpeername(fd_for_account,(struct sockaddr*)&peerbuf,&plen)==0){
      effective=(const struct sockaddr*)&peerbuf;effective_len=plen;
    }
  }
  int cls=a2_transport_class(effective,effective_len);
  if(is_connect){a2_connect_total++;if(cls==1)a2_connect_lan++;if(result<0)a2_connect_failed++;return;}
  a2_tx_total++;if(cls==1)a2_tx_lan++;else if(cls==2)a2_tx_tencent++;
  else if(cls==3)a2_tx_dns++;else if(cls==4)a2_tx_other++;else a2_tx_unspecified++;
  if(result<0)a2_tx_failed++;
  if(a2_selected_observations)a2_tx_after_selection++;
  if(a2_tx_total==100||a2_tx_total==320||a2_tx_total==640||a2_tx_total==1280)a2_transport_summary("tx_milestone");
}

static unsigned a2_branch_observations=0;
static void a2_branch_boundary(const char*path,unsigned long character,int callback_expected){
  if(a2_branch_observations>=24||a2_last_peer<0x10000UL||character<0x10000UL)return;
  const unsigned char*c=(const unsigned char*)character;
  if(!(c[8]==2&&c[9]==0&&c[10]==0xdf&&c[11]==0x1c&&c[12]==192&&c[13]==168&&c[14]==178&&c[15]==69))return;
  unsigned long selected=*(const unsigned long*)(a2_last_peer+0xa0UL);
  unsigned long vt=*(const unsigned long*)a2_last_peer;
  unsigned long target=vt>0x10000UL?*(const unsigned long*)(vt+0x40UL):0;
  char b[650];size_t k=0;const char*t="XNET_A2_BRANCH_BOUNDARY seq=";
  for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,++a2_branch_observations);
  t=" path=";for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;path[i];i++)b[k++]=path[i];
  t=" peer=0x";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_hexul(b,&k,a2_last_peer);
  t=" character=0x";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_hexul(b,&k,character);
  t=" selected=0x";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_hexul(b,&k,selected);
  t=" selected_matches_character=";for(size_t i=0;t[i];i++)b[k++]=t[i];b[k++]=selected==character?'1':'0';
  t=" callback_target=0x";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_hexul(b,&k,target);
  if(target&&real_dladdr){struct dl_info di={0};if(real_dladdr((const void*)target,&di)&&di.dli_fbase){t=" callback_target_offset=0x";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_hexul(b,&k,target-(unsigned long)di.dli_fbase);}}
  t=" static_copy=0x187510 static_callback=0x1876c8 callback_expected_on_path=";for(size_t i=0;t[i];i++)b[k++]=t[i];b[k++]=callback_expected?'1':'0';
  t=" observed_at=sdk_log_boundary callback_invocation_observed=0 payload=redacted\n";for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);
  /* v8.43: read-only inspection of the callback's first virtual gate.
     Static 0x188630 loads peer vtable and 0x188634 reads slot +0x38;
     0x188638 calls it, 0x18863c tests bit 0 of the return value.
     Never invoke this target or claim to know its return value. */
  if(vt>0x10000UL){
    unsigned long gate=*(const unsigned long*)(vt+0x38UL);
    unsigned long map_root=*(const unsigned long*)(a2_last_peer+0x28UL);
    char g[440];size_t j=0;const char*u="XNET_A2_CALLBACK_GATE_STATIC path=";
    for(size_t i=0;u[i];i++)g[j++]=u[i];for(size_t i=0;path[i]&&j+2<sizeof(g);i++)g[j++]=path[i];
    u=" gate_target=0x";for(size_t i=0;u[i];i++)g[j++]=u[i];emit_hexul(g,&j,gate);
    if(gate&&real_dladdr){struct dl_info di={0};if(real_dladdr((const void*)gate,&di)&&di.dli_fbase){u=" gate_offset=0x";for(size_t i=0;u[i];i++)g[j++]=u[i];emit_hexul(g,&j,gate-(unsigned long)di.dli_fbase);}}
    u=" callback_target_offset_expected=0x188600 map_root_present=";for(size_t i=0;u[i];i++)g[j++]=u[i];g[j++]=map_root?'1':'0';
    u=" gate_called=0 gate_result=unknown static_gate_callsite=0x188638 static_gate_test=0x18863c payload=redacted\n";
    for(size_t i=0;u[i]&&j+2<sizeof(g);i++)g[j++]=u[i];write(2,g,j);
  }
  /* v8.44: bounded, read-only map inspection at existing SDK log boundary.
     Exact SDK rodata at 0x44dce4 is the public reason "new_character".
     Root and immediate children only; no SDK calls, tree walk, or key bytes in log.
     This is a snapshot, NOT a measurement of callback execution/gate return. */
  if(vt>0x10000UL){
    unsigned long root=*(const unsigned long*)(a2_last_peer+0x28UL);
    const char*expected="new_character";
    unsigned long nodes[3]={root,0,0};
    if(root>=0x10000UL){nodes[1]=*(const unsigned long*)(root+0x10UL);nodes[2]=*(const unsigned long*)(root+0x18UL);}
    char d[450];size_t z=0;const char*u="XNET_A2_CALLBACK_KEY_SNAPSHOT path=";
    for(size_t i=0;u[i];i++)d[z++]=u[i];for(size_t i=0;path[i]&&z+2<sizeof(d);i++)d[z++]=path[i];
    u=" static_reason_offset=0x44dce4 reason=new_character node_scope=root_and_immediate_children";
    for(size_t i=0;u[i];i++)d[z++]=u[i];
    for(unsigned q=0;q<3;q++){
      u=q==0?" root_present=":q==1?" left_present=":" right_present=";
      for(size_t i=0;u[i];i++)d[z++]=u[i];d[z++]=nodes[q]>=0x10000UL?'1':'0';
      u=q==0?" root_key_match=":q==1?" left_key_match=":" right_key_match=";
      for(size_t i=0;u[i];i++)d[z++]=u[i];
      char match='?';
      if(nodes[q]>=0x10000UL){
        unsigned long kp=*(const unsigned long*)(nodes[q]+0x20UL);
        if(kp>=0x10000UL){const unsigned char*k=(const unsigned char*)kp;match='1';
          for(size_t i=0;i<14;i++){if(k[i]!=(unsigned char)expected[i]){match='0';break;}if(expected[i]==0)break;}
        }
      }
      d[z++]=match;
    }
    u=" map_complete=0 gate_called=0 callback_called=0 payload=redacted\n";
    for(size_t i=0;u[i]&&z+2<sizeof(d);i++)d[z++]=u[i];write(2,d,z);
  }
  a2_decision_backtrace(path);
}
static void a2_trace_selection_branch(const char*text,size_t n){
  if(!text||!n||a2_last_peer<0x10000UL||!contains_text(text,n,"delete character"))return;
  unsigned long deleted=parse_hex_after(text,n,"delete character:0x");
  if(deleted<0x10000UL)return;
  const unsigned char*c=(const unsigned char*)deleted;
  if(!(c[8]==0x02&&c[9]==0x00&&c[10]==0xdf&&c[11]==0x1c&&c[12]==0xc0&&c[13]==0x00&&c[14]==0x02&&c[15]==0x45))return;
  unsigned long selected=*(const unsigned long*)(a2_last_peer+0xa0UL);
  int selected_is_lan=0;
  if(selected>=0x10000UL){const unsigned char*m=(const unsigned char*)selected;selected_is_lan=(m[8]==0x02&&m[9]==0x00&&m[10]==0xdf&&m[11]==0x1c&&m[12]==0xc0&&m[13]==0xa8&&m[14]==0xb2&&m[15]==0x45);}
  char b[760];size_t k=0;const char*p="XNET_A2_SELECTION_BRANCH path=replacement_delete";for(size_t i=0;p[i];i++)b[k++]=p[i];
  p=" peer=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,a2_last_peer);
  p=" deleted=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,deleted);
  p=" selected=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,selected);
  p=" selected_is_lan=";for(size_t i=0;p[i];i++)b[k++]=p[i];b[k++]=selected_is_lan?'1':'0';
  p=" deleted_rank_2c=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,c[0x2c]);
  p=" deleted_key_2d=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,c[0x2d]);
  p=" deleted_level_2e=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,c[0x2e]);
  if(selected>=0x10000UL){const unsigned char*m=(const unsigned char*)selected;p=" selected_rank_2c=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,m[0x2c]);p=" selected_key_2d=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,m[0x2d]);p=" selected_level_2e=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,m[0x2e]);}
  p=" static_replacement_copy=0x187510 static_delete_log=0x187550 static_callback=0x1876c8 callback_on_replacement_path=0";for(size_t i=0;p[i]&&k+2<sizeof(b);i++)b[k++]=p[i];b[k++]='\n';write(2,b,k);
  if(selected_is_lan){a2_selected_observations++;if(a2_selected_observations==1||a2_selected_observations==32||a2_selected_observations==128){a2_selection_state_snapshot("selected_lan_milestone");a2_transport_summary("selected_lan_milestone");}}
  a2_dump_object("selection_branch_deleted","deleted_lan_character",deleted);
  a2_dump_object("selection_branch_selected","peer_plus_a0_after_replacement",selected);
  a2_branch_boundary("replacement_after_copy",deleted,0);
  a2_callback_stack_probe("replacement_after_copy");
}

static void a2_register_snapshot(const char*event){
#if defined(__aarch64__)
  unsigned long r[13];
  __asm__ volatile(
    "mov %0, x19\n\t" "mov %1, x20\n\t" "mov %2, x21\n\t" "mov %3, x22\n\t"
    "mov %4, x23\n\t" "mov %5, x24\n\t" "mov %6, x25\n\t" "mov %7, x26\n\t"
    "mov %8, x27\n\t" "mov %9, x28\n\t" "mov %10, x29\n\t" "mov %11, x30\n\t" "mov %12, sp\n\t"
    : "=r"(r[0]),"=r"(r[1]),"=r"(r[2]),"=r"(r[3]),"=r"(r[4]),"=r"(r[5]),"=r"(r[6]),"=r"(r[7]),"=r"(r[8]),"=r"(r[9]),"=r"(r[10]),"=r"(r[11]),"=r"(r[12]));
  char b[900]; size_t k=0; const char*p="XNET_A2_DECISION_REGS event=";
  for(size_t i=0;p[i];i++)b[k++]=p[i]; for(size_t i=0;event[i];i++)b[k++]=event[i];
  const char*names[13]={" x19=0x"," x20=0x"," x21=0x"," x22=0x"," x23=0x"," x24=0x"," x25=0x"," x26=0x"," x27=0x"," x28=0x"," fp=0x"," lr=0x"," sp=0x"};
  for(int j=0;j<13;j++){for(size_t i=0;names[j][i];i++)b[k++]=names[j][i];emit_hexul(b,&k,r[j]);}b[k++]='\n';write(2,b,k);
  /* v8.21: do not infer C++ object identity from registers.  Snapshot only
     heap pointers parsed from XNET's own peer/character log messages. */
  a2_dump_object(event,"character_logptr",a2_last_character);
  a2_dump_object(event,"peer_logptr",a2_last_peer);
  a2_dump_peer_selected(event);
#else
  (void)event;
#endif
}
static int is_a2_or_wsl_text(const char*s,size_t n){return contains_text(s,n,"192.0.2.69")||contains_text(s,n,"198.51.100.255");}
static void a2_trace_close(const char*reason){if(!a2_trace_window)return;char b[180];size_t k=0;const char*p="XNET_A2_TRACE_WINDOW_CLOSE reason=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;reason[i]&&k+2<sizeof(b);i++)b[k++]=reason[i];b[k++]='\n';write(2,b,k);a2_trace_window=0;}
static void a2_trace_event(const char*event,const char*text,size_t n,const void*caller){
  if(!a2_trace_window||!text||!is_a2_or_wsl_text(text,n))return;
  struct dl_info di={0};if(!real_dladdr)real_dladdr=(dladdr_fn)dlsym(RTLD_NEXT,"dladdr");
  char b[1100];size_t k=0;const char*p="XNET_A2_TRACE event=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;event[i];i++)b[k++]=event[i];
  p=" caller=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,(unsigned long)caller);
  if(caller&&real_dladdr&&real_dladdr(caller,&di)&&di.dli_fbase){p=" offset=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,(unsigned long)caller-(unsigned long)di.dli_fbase);if(di.dli_fname){p=" module=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;di.dli_fname[i]&&k+2<sizeof(b);i++)b[k++]=di.dli_fname[i];}}
  p=" text=\"";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;i<n&&k+3<sizeof(b);i++){char c=text[i];if(c=='\n'||c=='\r')c=' ';if(c=='\"')c='\'';b[k++]=c;}b[k++]='\"';b[k++]='\n';write(2,b,k);
  a2_trace_events++;if(contains_text(text,n,"new character level")){a2_parser_seen=1;emit("XNET_A2_PARSER_CANDIDATE_SEEN=1\n");if(contains_text(text,n,"192.0.2.69:57116")){a2_register_snapshot("new_character");a2_decision_backtrace("new_character");}}
  if(a2_parser_seen&&contains_text(text,n,"delete character")){if(contains_text(text,n,"192.0.2.69:57116")){a2_register_snapshot("delete_character");a2_decision_backtrace("delete_character");}a2_trace_close("parser_delete_observed");}else if(a2_trace_events>=24)a2_trace_close("event_budget");
}

static unsigned short bswap16(unsigned short x){return (unsigned short)((x>>8)|(x<<8));}
static void emit_u(char*b,size_t*k,unsigned long x){char n[32];int q=0;do{n[q++]=(char)('0'+x%10);x/=10;}while(x&&q<32);while(q)b[(*k)++]=n[--q];}

/* v8.20 decision trace: unwind only inside the already-bounded A2 parser
   window.  This is diagnostic-only: it does not change level, netType,
   character lifetime or socket routing. */
typedef unsigned long uintptr_t;
typedef int (*unwind_cb_fn)(void*,void*);
typedef int (*unwind_backtrace_fn)(unwind_cb_fn,void*);
typedef uintptr_t (*unwind_getip_fn)(void*);
static unwind_backtrace_fn real_unwind_backtrace;
static unwind_getip_fn real_unwind_getip;
struct decision_ctx { const char* event; unsigned frames; };
static int decision_unwind_cb(void*ctxp,void*arg){
  struct decision_ctx*c=(struct decision_ctx*)arg;if(!c||c->frames>=16||!real_unwind_getip)return 5;
  uintptr_t ip=real_unwind_getip(ctxp);if(!ip)return 0;
  struct dl_info di={0};if(!real_dladdr)real_dladdr=(dladdr_fn)dlsym(RTLD_NEXT,"dladdr");
  if(real_dladdr&&real_dladdr((const void*)ip,&di)&&di.dli_fbase&&di.dli_fname&&contains_text(di.dli_fname,slen(di.dli_fname),"libiot_video_demo.so")){
    char b[620];size_t k=0;const char*p="XNET_A2_DECISION_FRAME event=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;c->event[i];i++)b[k++]=c->event[i];
    p=" frame=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,c->frames);p=" ip=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,(unsigned long)ip);
    p=" offset=0x";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_hexul(b,&k,(unsigned long)ip-(unsigned long)di.dli_fbase);p=" module=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;di.dli_fname[i]&&k+2<sizeof(b);i++)b[k++]=di.dli_fname[i];b[k++]='\n';write(2,b,k);c->frames++;
  }
  return 0;
}
static void a2_decision_backtrace(const char*event){
  if(!real_unwind_backtrace)real_unwind_backtrace=(unwind_backtrace_fn)dlsym(RTLD_NEXT,"_Unwind_Backtrace");if(!real_unwind_getip)real_unwind_getip=(unwind_getip_fn)dlsym(RTLD_NEXT,"_Unwind_GetIP");
  if(!real_unwind_backtrace||!real_unwind_getip){emit("XNET_A2_DECISION_BACKTRACE_UNAVAILABLE=1\n");return;}
  char b[160];size_t k=0;const char*p="XNET_A2_DECISION_BACKTRACE_BEGIN event=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;event[i];i++)b[k++]=event[i];b[k++]='\n';write(2,b,k);
  struct decision_ctx c={event,0};real_unwind_backtrace(decision_unwind_cb,&c);k=0;p="XNET_A2_DECISION_BACKTRACE_END event=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;event[i];i++)b[k++]=event[i];p=" frames=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,c.frames);b[k++]='\n';write(2,b,k);
}
static void a2_append_signed(char*b,size_t*k,long v);
/* v8.54: all observations are metadata-only, and real socket type is
 * queried via SOL_SOCKET/SO_TYPE. A connected UDP socket is not TCP. */
static const char *diag_peer_class(const struct sockaddr *sa,socklen_t len){
  if(!sa||len<sizeof(struct sockaddr_in)||sa->sa_family!=2)return "unknown";
  const unsigned char *v=(const unsigned char*)&((const struct sockaddr_in*)sa)->sin_addr;
  if(v[0]==127)return "loopback";
  if(v[0]==43&&v[1]==158&&v[2]==113&&v[3]==38)return "tencent";
  if(v[0]==192&&v[1]==168&&v[2]==178&&v[3]==69)return "mower";
  if(v[0]==114&&v[1]==114&&v[2]==114&&v[3]==114)return "dns";
  return "other";
}
static const char *diag_socktype(int fd){
  typedef int*(*errno_fn)(void);static errno_fn get_errno=0;
  if(!get_errno)get_errno=(errno_fn)dlsym(RTLD_NEXT,"__errno");
  int saved=get_errno?*get_errno():0;
  if(!real_getsockopt)real_getsockopt=(getsockopt_fn)dlsym(RTLD_NEXT,"getsockopt");
  int type=0;socklen_t n=sizeof(type);
  int rc=real_getsockopt?real_getsockopt(fd,1,3,&type,&n):-1;
  if(get_errno)*get_errno()=saved;
  if(rc!=0||n!=sizeof(type))return "unknown";
  return type==1?"tcp":type==2?"udp":"other";
}
static unsigned diag_socket_count=0,diag_http_count=0;
static void diag_socket_event(const char*op,int fd,const struct sockaddr*source,socklen_t source_len,long result){
  if(diag_socket_count>=120)return;
  typedef int*(*errno_fn)(void);static errno_fn get_errno=0;
  if(!get_errno)get_errno=(errno_fn)dlsym(RTLD_NEXT,"__errno");int saved=get_errno?*get_errno():0;
  if(!real_getpeername)real_getpeername=(getpeername_fn)dlsym(RTLD_NEXT,"getpeername");
  struct sockaddr_in peer={0};socklen_t len=sizeof(peer);
  const struct sockaddr *address=source; socklen_t address_len=source_len;
  if((!address||address_len<sizeof(struct sockaddr_in))&&real_getpeername&&real_getpeername(fd,(struct sockaddr*)&peer,&len)==0){address=(const struct sockaddr*)&peer;address_len=len;}
  const char*cls=diag_peer_class(address,address_len);
  /* DNS/loopback chatter must not exhaust the bounded stream evidence budget. */
  if(cls[0]=='d'||cls[0]=='u'||(cls[0]=='l'&&op[0]!='c')){
    if(get_errno)*get_errno()=saved;return;
  }
  const char*kind=diag_socktype(fd);
  char b[240];size_t k=0;const char*t="XNET_SOCKET_KIND op=";
  for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;op[i]&&k+2<sizeof(b);i++)b[k++]=op[i];
  t=" fd=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)fd);
  t=" type=";for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;kind[i];i++)b[k++]=kind[i];
  t=" peer=";for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;cls[i];i++)b[k++]=cls[i];
  t=" result=";for(size_t i=0;t[i];i++)b[k++]=t[i];a2_append_signed(b,&k,result);
  t=" payload=redacted\n";for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);
  diag_socket_count++;
  if(get_errno)*get_errno()=saved;
}
/* Only classify fixed HTTP method, allowlisted path and numeric status.
 * Do not log arbitrary request line/path, queries, headers, tokens, or body. */
static void diag_local_http(const char*direction,int fd,const unsigned char*p,size_t n){
  if(!p||n<8||diag_http_count>=48)return;
  typedef int*(*errno_fn)(void);static errno_fn get_errno=0;
  if(!get_errno)get_errno=(errno_fn)dlsym(RTLD_NEXT,"__errno");int saved=get_errno?*get_errno():0;
  if(!real_getpeername)real_getpeername=(getpeername_fn)dlsym(RTLD_NEXT,"getpeername");
  struct sockaddr_in peer={0};socklen_t len=sizeof(peer);
  int is_local=real_getpeername&&real_getpeername(fd,(struct sockaddr*)&peer,&len)==0&&
    diag_peer_class((const struct sockaddr*)&peer,len)[0]=='l';
  if(!is_local){if(get_errno)*get_errno()=saved;return;}
  const char*event=0,*detail=0;unsigned status=0;
  if(n>=9&&p[0]=='H'&&p[1]=='T'&&p[2]=='T'&&p[3]=='P'&&p[4]=='/'&&p[5]=='1'&&p[6]=='.'){
    event="response"; if(n>=12&&p[8]==' '&&p[9]>='0'&&p[9]<='9'&&p[10]>='0'&&p[10]<='9'&&p[11]>='0'&&p[11]<='9')status=(p[9]-'0')*100+(p[10]-'0')*10+(p[11]-'0');
    detail="status";
  }else if(n>=5&&p[0]=='P'&&p[1]=='O'&&p[2]=='S'&&p[3]=='T'&&p[4]==' '){event="request";detail="POST";}
  else if(n>=4&&p[0]=='G'&&p[1]=='E'&&p[2]=='T'&&p[3]==' '){event="request";detail="GET";}
  if(event){
    size_t line=0;while(line<n&&line<512&&p[line]!='\r'&&p[line]!='\n'&&p[line]!='?')line++;
    const char*route="unknown_redacted",*safe_path="redacted";
    if(contains_text((const char*)p,line,"/app.xnet/ipc.p2p.com/ipc.flv")){
      route="flv";safe_path="/app.xnet/ipc.p2p.com/ipc.flv";
    }else if(contains_text((const char*)p,line,"/app.xnet/ipc.p2p.com/keepalive")){
      route="keepalive";safe_path="/app.xnet/ipc.p2p.com/keepalive";
    }else if(contains_text((const char*)p,line,"/app.xnet/ipc.p2p.com/command")){
      route="command";safe_path="/app.xnet/ipc.p2p.com/command";
    }else if(contains_text((const char*)p,line,"/app.xnet/ipc.p2p.com/"))route="other_p2p";
    char b[230];size_t k=0;const char*t="XNET_LOCAL_HTTP event=";
    for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;event[i];i++)b[k++]=event[i];
    t=" direction=";for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;direction[i];i++)b[k++]=direction[i];
    t=" fd=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)fd);
    t=" method=";for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;detail[i];i++)b[k++]=detail[i];
    t=" route=";for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;route[i];i++)b[k++]=route[i];
    t=" status=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,status);
    t=" path=";for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;safe_path[i];i++)b[k++]=safe_path[i];
    t=" query=redacted headers=redacted body=redacted\n";for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);
    diag_http_count++;
  }
  if(get_errno)*get_errno()=saved;
}
static void emit_ipv4(const char*kind,int fd,const struct sockaddr*sa,socklen_t sl,size_t bytes,const unsigned char*payload){
  if(!sa||sl<sizeof(struct sockaddr_in)||sa->sa_family!=2||net_hits++>180)return;
  const struct sockaddr_in*a=(const struct sockaddr_in*)sa; unsigned ip=a->sin_addr; unsigned char*c=(unsigned char*)&ip;
  char b[420];size_t k=0;const char*p="XNETNET kind=";for(size_t i=0;p[i];i++)b[k++]=p[i];for(size_t i=0;kind[i];i++)b[k++]=kind[i];
  p=" fd=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,(unsigned long)fd);p=" addr=";for(size_t i=0;p[i];i++)b[k++]=p[i];
  for(int i=0;i<4;i++){emit_u(b,&k,c[i]);if(i<3)b[k++]='.';}b[k++]=':';emit_u(b,&k,bswap16(a->sin_port));
  p=" bytes=";for(size_t i=0;p[i];i++)b[k++]=p[i];emit_u(b,&k,(unsigned long)bytes);
  if(payload&&bytes){p=" first=";for(size_t i=0;p[i];i++)b[k++]=p[i];size_t z=bytes<24?bytes:24;for(size_t i=0;i<z&&k+2<sizeof(b);i++){b[k++]=hx(payload[i]>>4);b[k++]=hx(payload[i]&15);}}
  b[k++]='\n';write(2,b,k);
}


/* v8.49: inspect the original 134-byte candidate message without mutating it.
   The previous v8.13 path overwrote the address advertised in this message
   with the MOWER address. That manufactured an apparent selected LAN endpoint
   without establishing a valid host endpoint or changing Windows/WSL routing.
   Only a candidate's IP and port are logged; the packet is never dumped. */
static void trace_character_packet(const char*source,unsigned char*p,size_t n){
  if(!p||n<5||pkt134_hits>=16)return;
  size_t off=(size_t)-1;
  for(size_t i=0;i+5<=n;i++)if(p[i]==0x04&&p[i+1]==0xff&&p[i+2]==0x00&&p[i+3]==0x82&&p[i+4]==0x04){off=i;break;}
  if(off==(size_t)-1)return;
  size_t avail=n-off;if(avail>134)avail=134;
  if(avail!=134)return; /* ignore partial copies, never inspect beyond n */
  unsigned long relative=0;unsigned port=0;unsigned char ip[4]={0};
  int found=nodelab_candidate_tlv(p+off,avail,&relative,&port,ip);
  pkt134_hits++;
  char b[390];size_t k=0;const char*t="XNETPKT134_UNMODIFIED source=";
  for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;source[i]&&k+2<sizeof(b);i++)b[k++]=source[i];
  t=" bytes=134 candidate_tlv=";for(size_t i=0;t[i];i++)b[k++]=t[i];b[k++]=found?'1':'0';
  if(found){
    t=" tlv_offset=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,relative);
    t=" candidate=";for(size_t i=0;t[i];i++)b[k++]=t[i];
    for(int i=0;i<4;i++){emit_u(b,&k,ip[i]);if(i<3)b[k++]='.';}b[k++]=':';emit_u(b,&k,port);
  }
  t=" mutation=0 payload=redacted\n";for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);
  if(found&&!a2_trace_window){
    a2_trace_window=1;a2_trace_events=0;a2_parser_seen=0;
    emit("XNET_A2_TRACE_WINDOW_OPEN mode=original_candidate_unmodified\n");
    a2_transport_summary("candidate_unmodified");
  }
}
static void scan_flv(const unsigned char*p,size_t n){
  if(!p||n<3)return;
  size_t pos=0; int found=0;
  for(size_t i=0;i+2<n;i++) if(p[i]==0x46&&p[i+1]==0x4c&&p[i+2]==0x56){pos=i;found=1;break;}
  if(!found)return;
  flv_bytes += (unsigned long)(n-pos);
  if(!flv_reported){
    flv_reported=1; emit("XNET_INTERNAL_FLV_HEADER=1\n");
    char b[160]; size_t k=0; const char*a="XNET_INTERNAL_FLV_FIRST="; for(size_t i=0;a[i];i++)b[k++]=a[i];
    size_t z=(n-pos<32?n-pos:32); for(size_t i=0;i<z;i++){b[k++]=hx(p[pos+i]>>4);b[k++]=hx(p[pos+i]&15);} b[k++]='\n'; write(2,b,k);
  }
  char b[96]; size_t k=0; const char*a="XNET_INTERNAL_FLV_BYTES="; for(size_t i=0;a[i];i++)b[k++]=a[i];
  unsigned long x=flv_bytes; char num[32]; int q=0; do{num[q++]=(char)('0'+x%10);x/=10;}while(x&&q<32); while(q)b[k++]=num[--q]; b[k++]='\n'; write(2,b,k);
}
static int has_sensitive_flv_query(const unsigned char*p,size_t n){
  return p&&n&&(contains_text((const char*)p,n,"_peername=")||contains_text((const char*)p,n,"_sig=")||contains_text((const char*)p,n,"req_id="));
}
static void dump(const char*kind,const unsigned char*p,size_t n,size_t pos){
  if(has_sensitive_flv_query(p,n)){
    if(hits++<70){char b[220];size_t k=0;const char*pre="XNETTRACE_REDACTED kind=";for(size_t i=0;pre[i];i++)b[k++]=pre[i];for(size_t i=0;kind[i];i++)b[k++]=kind[i];pre=" reason=sensitive_flv_query\n";for(size_t i=0;pre[i];i++)b[k++]=pre[i];write(2,b,k);}
    return;
  }
  if(hits++>=70)return;char b[1400];size_t k=0;const char*pre="XNETTRACE kind=";for(size_t i=0;pre[i]&&k<sizeof(b)-1;i++)b[k++]=pre[i];for(size_t i=0;kind[i]&&k<sizeof(b)-1;i++)b[k++]=kind[i];const char*mid=" pos=";for(size_t i=0;mid[i]&&k<sizeof(b)-1;i++)b[k++]=mid[i];unsigned x=(unsigned)pos;char num[16];int q=0;do{num[q++]=(char)('0'+x%10);x/=10;}while(x&&q<16);while(q&&k<sizeof(b)-1)b[k++]=num[--q];const char*mid2=" hex=";for(size_t i=0;mid2[i]&&k<sizeof(b)-1;i++)b[k++]=mid2[i];size_t a=pos>40?pos-40:0,z=n<pos+180?n:pos+180;for(size_t i=a;i<z&&k+2<sizeof(b);i++){b[k++]=hx(p[i]>>4);b[k++]=hx(p[i]&15);}b[k++]='\n';write(2,b,k);
}
static int hostrange(const unsigned char*p,size_t n,size_t dot,size_t*h,size_t*len){if(dot<=7||n<dot+sizeof(needle)-1)return 0;size_t s=dot;while(s>0&&p[s-1]!='/'&&p[s-1]!=' '&&p[s-1]!='\n'&&p[s-1]!='\r')s--;if(s<7||p[s-7]!='h'||p[s-6]!='t'||p[s-5]!='t'||p[s-4]!='p'||p[s-3]!=':'||p[s-2]!='/'||p[s-1]!='/')return 0;*h=s;*len=dot-s;return 1;}
static int peer_from_buffer(const unsigned char*p,size_t n,size_t*ps,size_t*pl){size_t k=0;if(!findbytes(p,n,peerkey,sizeof(peerkey)-1,&k))return 0;size_t s=k+sizeof(peerkey)-1,e=s;while(e<n&&p[e]&&p[e]!='&'&&p[e]!=' '&&p[e]!='\r'&&p[e]!='\n'&&e-s<64)e++;if(e<=s)return 0;*ps=s;*pl=e-s;return 1;}
static void emit_peer(const unsigned char*p,size_t n){(void)p;(void)n;emit("XNETPEER_DYNAMIC_PRESENT=1\n");}
static void repair(void*d,size_t n){unsigned char*p=(unsigned char*)d;size_t dot=0,h=0,hl=0,ps=0,pl=0;if(!hasneedle(p,n,&dot)||!hostrange(p,n,dot,&h,&hl))return;if(hl==3&&p[h]=='a'&&p[h+1]=='p'&&p[h+2]=='p')return;int nonascii=0;for(size_t i=h;i<dot;i++)if(p[i]<0x21||p[i]>0x7e){nonascii=1;break;}if(!nonascii||hl<4||hl>64)return;if(!peer_from_buffer(p,n,&ps,&pl)){if(repairs<8)emit("XNETPEER_WAIT=no_peername_in_buffer\n");return;}if(pl!=hl){if(repairs<8)emit("XNETPEER_SKIP=length_mismatch\n");return;}if(repairs++<8){dump("pre_peer_repair",p,n,dot);emit_peer(p+ps,pl);}for(size_t i=0;i<hl;i++)p[h+i]=p[ps+i];if(repairs<=8){emit("XNETPEER_REPAIR_APPLIED=dynamic_peername\n");size_t np=0;if(hasneedle(p,n,&np))dump("post_peer_repair",p,n,np);}}

__attribute__((constructor)) static void init(void){emit("XNETTRACE_LOADED=1\nXNETREPAIR_MODE=dynamic-peername+internal-flv-observer+xnet-packet134-original-candidate-no-mutation+a2-ipv6-mapped-endpoints+all-sdk-tx-metadata+lan-handoff-correlation+callback-stack-samples+callback-gate-static-read+uncapped-transport-summary+rx-source+strict-secret-redaction\n");real_memcpy=(mem_fn)dlsym(RTLD_NEXT,"memcpy");real_dladdr=(dladdr_fn)dlsym(RTLD_NEXT,"dladdr");real_memcmp=(memcmp_fn)dlsym(RTLD_NEXT,"memcmp");real_memmove=(mem_fn)dlsym(RTLD_NEXT,"memmove");real_vsnprintf=(vsn_fn)dlsym(RTLD_NEXT,"vsnprintf");real_sendto=(sendto_fn)dlsym(RTLD_NEXT,"sendto");real_recvfrom=(recvfrom_fn)dlsym(RTLD_NEXT,"recvfrom");real_recv=(recv_fn)dlsym(RTLD_NEXT,"recv");real_read=(read_fn)dlsym(RTLD_NEXT,"read");real_connect=(connect_fn)dlsym(RTLD_NEXT,"connect");real_send=(send_fn)dlsym(RTLD_NEXT,"send");real_sendmsg=(sendmsg_fn)dlsym(RTLD_NEXT,"sendmsg");real_writev=(writev_fn)dlsym(RTLD_NEXT,"writev");real_recvmsg=(recvmsg_fn)dlsym(RTLD_NEXT,"recvmsg");real_getpeername=(getpeername_fn)dlsym(RTLD_NEXT,"getpeername");real_getsockname=(getsockname_fn)dlsym(RTLD_NEXT,"getsockname");real_getsockopt=(getsockopt_fn)dlsym(RTLD_NEXT,"getsockopt");}
void *memcpy(void*d,const void*s,size_t n){if(!real_memcpy)real_memcpy=(mem_fn)dlsym(RTLD_NEXT,"memcpy");real_dladdr=(dladdr_fn)dlsym(RTLD_NEXT,"dladdr");real_memcmp=(memcmp_fn)dlsym(RTLD_NEXT,"memcmp");if(!real_memcpy)return d;void*r=real_memcpy(d,s,n);if(!guard&&n<=1048576){trace_character_packet("memcpy",(unsigned char*)d,n);scan_flv((const unsigned char*)d,n);guard=1;size_t p;if(hasneedle((const unsigned char*)d,n,&p)){dump("memcpy",(const unsigned char*)d,n,p);repair(d,n);}guard=0;}return r;}
void *memmove(void*d,const void*s,size_t n){if(!real_memmove)real_memmove=(mem_fn)dlsym(RTLD_NEXT,"memmove");if(!real_memmove)return d;void*r=real_memmove(d,s,n);if(!guard&&n<=1048576){trace_character_packet("memmove",(unsigned char*)d,n);scan_flv((const unsigned char*)d,n);guard=1;size_t p;if(hasneedle((const unsigned char*)d,n,&p)){dump("memmove",(const unsigned char*)d,n,p);repair(d,n);}guard=0;}return r;}
int vsnprintf(char*out,size_t n,const char*fmt,va_list ap){void*caller=__builtin_return_address(0);if(!real_vsnprintf)real_vsnprintf=(vsn_fn)dlsym(RTLD_NEXT,"vsnprintf");if(!real_vsnprintf)return -1;int r=real_vsnprintf(out,n,fmt,ap);if(!guard&&out&&n){guard=1;size_t lim=(r>=0&&(size_t)r<n)?(size_t)r:n-1,p;if(hasneedle((const unsigned char*)out,lim,&p)){dump("vsnprintf",(const unsigned char*)out,lim,p);repair(out,lim+1);}/* v8.26: removed text-based retained-consumer heuristic; 0x1cfd4c proved to be vsnprintf wrapper. */const char*ev=0;if(contains_text(out,lim,"delete character"))ev="delete_character";else if(contains_text(out,lim,"new character"))ev="new_character";else if(contains_text(out,lim,"set character"))ev="set_character";else if(contains_text(out,lim,"addAddr"))ev="addAddr";else if(contains_text(out,lim,"insert character"))ev="insert_character";if(ev){a2_capture_object_ids(out,lim);if(contains_text(out,lim,"insert character"))a2_trace_selection_callback(out,lim);if(contains_text(out,lim,"delete character"))a2_trace_selection_branch(out,lim);if(contains_text(out,lim,"new character level"))a2_dump_character_state(out,lim);a2_trace_event(ev,out,lim,caller);}a2_trace_forward_dispatch(out,lim);a2_trace_worker_progress(out,lim,caller);guard=0;}return r;}

/* v8.36: read-only socket endpoint diagnostics. Never read packet bytes. */
static void a2_append_signed(char*b,size_t*k,long v){if(v<0){b[(*k)++]='-';emit_u(b,k,(unsigned long)(-v));}else emit_u(b,k,(unsigned long)v);}
static void a2_append_endpoint(char*b,size_t*k,const char*label,const struct sockaddr*sa,socklen_t len,int rc,int err){
  const char*t=label;for(size_t i=0;t[i];i++)b[(*k)++]=t[i];
  t="rc=";for(size_t i=0;t[i];i++)b[(*k)++]=t[i];a2_append_signed(b,k,rc);
  t=" errno=";for(size_t i=0;t[i];i++)b[(*k)++]=t[i];emit_u(b,k,(unsigned long)(rc<0?err:0));
  t=" len=";for(size_t i=0;t[i];i++)b[(*k)++]=t[i];emit_u(b,k,(unsigned long)len);
  t=" family=";for(size_t i=0;t[i];i++)b[(*k)++]=t[i];emit_u(b,k,(unsigned long)(rc==0&&len>=2&&sa?sa->sa_family:0));
  if(rc==0&&sa&&len>=sizeof(struct sockaddr_in)&&sa->sa_family==2){
    const struct sockaddr_in*a=(const struct sockaddr_in*)sa;const unsigned char*c=(const unsigned char*)&a->sin_addr;
    t=" ipv4=";for(size_t i=0;t[i];i++)b[(*k)++]=t[i];for(int i=0;i<4;i++){emit_u(b,k,c[i]);if(i<3)b[(*k)++]='.';}b[(*k)++]=':';emit_u(b,k,bswap16(a->sin_port));
  }else if(rc==0&&sa&&len>=28&&sa->sa_family==10){
    /* Linux/Bionic sockaddr_in6: family[0:2], port[2:4], flowinfo[4:8], address[8:24], scope[24:28]. */
    const unsigned char*a=(const unsigned char*)sa;const unsigned char*c=a+8;
    int mapped=1;for(int i=0;i<10;i++)if(c[i])mapped=0;if(c[10]!=255||c[11]!=255)mapped=0;
    if(mapped){t=" ipv4_mapped=";for(size_t i=0;t[i];i++)b[(*k)++]=t[i];for(int i=12;i<16;i++){emit_u(b,k,c[i]);if(i<15)b[(*k)++]='.';}b[(*k)++]=':';emit_u(b,k,((unsigned long)a[2]<<8)|a[3]);}
    else{t=" ipv6=[";for(size_t i=0;t[i];i++)b[(*k)++]=t[i];for(int i=0;i<8;i++){unsigned v=((unsigned)c[2*i]<<8)|c[2*i+1];emit_hexul(b,k,v);if(i<7)b[(*k)++]=':';}b[(*k)++]=']';b[(*k)++]=':';emit_u(b,k,((unsigned long)a[2]<<8)|a[3]);}
    unsigned long scope=(unsigned long)a[24]|((unsigned long)a[25]<<8)|((unsigned long)a[26]<<16)|((unsigned long)a[27]<<24);
    if(scope){t=" scope_id=";for(size_t i=0;t[i];i++)b[(*k)++]=t[i];emit_u(b,k,scope);}
  }
}
static void a2_socket_details(const char*kind,int fd,const struct sockaddr*source,socklen_t source_len,int source_valid){
  if(fd<0||fd>=1024||!a2_exact_fds[fd])return;
  typedef int*(*errno_fn)(void);static errno_fn ef=0;if(!ef)ef=(errno_fn)dlsym(RTLD_NEXT,"__errno");int saved=ef?*ef():0;
  if(!real_getpeername)real_getpeername=(getpeername_fn)dlsym(RTLD_NEXT,"getpeername");
  if(!real_getsockname)real_getsockname=(getsockname_fn)dlsym(RTLD_NEXT,"getsockname");
  union {struct sockaddr sa;unsigned char raw[128];} peer={0},local={0};socklen_t pl=sizeof(peer),ll=sizeof(local);
  int pr=real_getpeername?real_getpeername(fd,&peer.sa,&pl):-1;int pe=ef?*ef():0;
  int lr=real_getsockname?real_getsockname(fd,&local.sa,&ll):-1;int le=ef?*ef():0;
  char b[1000];size_t k=0;const char*t="XNET_A2_SOCKET_DETAIL kind=";for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;kind[i];i++)b[k++]=kind[i];t=" fd=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)fd);
  a2_append_endpoint(b,&k," peer_",&peer.sa,pl,pr,pe);a2_append_endpoint(b,&k," local_",&local.sa,ll,lr,le);
  if(source_valid)a2_append_endpoint(b,&k," source_",source,source_len,0,0);
  t=" payload=redacted\n";for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);if(ef)*ef()=saved;
}
/* Log the SDK-provided per-datagram destination, including AF_INET6 and IPv4-mapped IPv6. */
static void a2_sendto_target(int fd,const struct sockaddr*to,socklen_t sl){
  char b[400];size_t k=0;const char*t="XNET_A2_SENDTO_TARGET fd=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)fd);
  a2_append_endpoint(b,&k," target_",to,sl,to?0:-1,0);
  t=" payload=redacted\n";for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);
}
/* v8.39: correlate the retained LAN Character with the real SDK transport
   boundary. Only addresses, descriptor, return values and stable pointer
   identities are observed; no packet bytes, callback invocation or mutation. */
static unsigned a2_handoff_count=0;
static void a2_handoff(const char*event,int fd,const void*caller,const struct sockaddr*dest,socklen_t len,long result){
  if(a2_handoff_count>=180||a2_last_peer<0x10000UL)return;
  unsigned long selected=*(const unsigned long*)(a2_last_peer+0xa0UL);
  if(selected<0x10000UL)return;
  const unsigned char*m=(const unsigned char*)selected;
  if(!(m[8]==2&&m[9]==0&&m[10]==0xdf&&m[11]==0x1c&&m[12]==192&&m[13]==0&&m[14]==2&&m[15]==69))return;
  char b[850];size_t k=0;const char*t="XNET_A2_LAN_HANDOFF seq=";
  for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,++a2_handoff_count);
  t=" event=";for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;event[i];i++)b[k++]=event[i];
  t=" fd=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)fd);
  t=" selected=0x";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_hexul(b,&k,selected);
  t=" selected_addr=192.0.2.69:57116";for(size_t i=0;t[i];i++)b[k++]=t[i];
  t=" result=";for(size_t i=0;t[i];i++)b[k++]=t[i];a2_append_signed(b,&k,result);
  if(caller&&real_dladdr){struct dl_info di={0};if(real_dladdr(caller,&di)&&di.dli_fbase&&di.dli_fname&&contains_text(di.dli_fname,slen(di.dli_fname),"libiot_video_demo.so")){
    t=" sdk_caller_offset=0x";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_hexul(b,&k,(unsigned long)caller-(unsigned long)di.dli_fbase);
  }}
  if(dest&&len>=2)a2_append_endpoint(b,&k," actual_dest_",dest,len,0,0);
  else {t=" actual_dest=connected_or_unspecified";for(size_t i=0;t[i];i++)b[k++]=t[i];}
  t=" payload=redacted\n";for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);
}
/* v8.38: bounded, metadata-only observation of ALL SDK UDP send primitives.
   No packet reads, no extra sends, no address changes. */
static unsigned a2_all_tx_count=0;
static void a2_all_tx(const char*kind,int fd,const void*caller,const struct sockaddr*dest,socklen_t len,ssize_t result,int saved_errno){
  a2_transport_account(fd,caller,dest,len,(long)result,0);
  if(a2_all_tx_count>=320||!caller)return;
  if(!real_dladdr)real_dladdr=(dladdr_fn)dlsym(RTLD_NEXT,"dladdr");
  struct dl_info di={0};if(!real_dladdr||!real_dladdr(caller,&di)||!di.dli_fname||
    !contains_text(di.dli_fname,slen(di.dli_fname),"libiot_video_demo.so"))return;
  a2_all_tx_count++;
  a2_handoff(kind,fd,caller,dest,len,(long)result);
  char b[600];size_t k=0;const char*t="XNET_A2_ALL_TX kind=";
  for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;kind[i];i++)b[k++]=kind[i];
  t=" fd=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)fd);
  t=" caller_offset=0x";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_hexul(b,&k,(unsigned long)caller-(unsigned long)di.dli_fbase);
  t=" result=";for(size_t i=0;t[i];i++)b[k++]=t[i];a2_append_signed(b,&k,result);
  t=" errno=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)(result<0?saved_errno:0));
  if(dest&&len>=2)a2_append_endpoint(b,&k," dest_",dest,len,0,0);
  else {t=" dest=not_supplied";for(size_t i=0;t[i];i++)b[k++]=t[i];}
  t=" payload=redacted\n";for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);
}
/* v8.34: exact runtime 0x18ebf4 calls sendto@plt at 0x18edc4.
   Observe the REAL libc result at return address 0x18edc8, without any
   packet payload, state mutation, extra send, or change to errno. */
ssize_t sendto(int fd,const void*buf,size_t n,int flags,const struct sockaddr*to,socklen_t sl){
  const void*caller=__builtin_return_address(0);
  int exact=0;
  if(real_dladdr&&caller){struct dl_info di={0};if(real_dladdr(caller,&di)&&di.dli_fbase&&
      (unsigned long)caller-(unsigned long)di.dli_fbase==0x18edc8UL&&
      di.dli_fname&&contains_text(di.dli_fname,slen(di.dli_fname),"libiot_video_demo.so"))exact=1;}
  if(!real_sendto)real_sendto=(sendto_fn)dlsym(RTLD_NEXT,"sendto");
  if(!real_sendto)return -1;
  if(!exact)emit_ipv4("sendto",fd,to,sl,n,(const unsigned char*)buf);
  ssize_t result=real_sendto(fd,buf,n,flags,to,sl);
  typedef int*(*a2_errno_fn)(void);static a2_errno_fn tx_errno=0;if(!tx_errno)tx_errno=(a2_errno_fn)dlsym(RTLD_NEXT,"__errno");
  int tx_saved=tx_errno?*tx_errno():0;
  a2_all_tx("sendto",fd,caller,to,sl,result,tx_saved);
  diag_socket_event("sendto",fd,to,sl,result);
  if(tx_errno)*tx_errno()=tx_saved;
  if(exact){
    typedef int*(*errno_fn)(void);
    static errno_fn errno_location=0;
    if(!errno_location)errno_location=(errno_fn)dlsym(RTLD_NEXT,"__errno");
    int saved_errno=errno_location?*errno_location():0;
    char b[420];size_t k=0;const char*t="XNET_A2_EXACT_SENDTO callsite=0x18edc4 return_offset=0x18edc8 fd=";
    for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)fd);
    t=" requested=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)n);
    t=" result=";for(size_t i=0;t[i];i++)b[k++]=t[i];
    if(result<0){b[k++]='-';emit_u(b,&k,(unsigned long)(-result));}else emit_u(b,&k,(unsigned long)result);
    t=" errno=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)(result<0?saved_errno:0));
    t=" target=";for(size_t i=0;t[i];i++)b[k++]=t[i];
    if(to&&sl>=8&&to->sa_family==2){const unsigned char*a=(const unsigned char*)to;
      for(int i=0;i<4;i++){emit_u(b,&k,a[4+i]);if(i!=3)b[k++]='.';}
      b[k++]=':';emit_u(b,&k,((unsigned long)a[2]<<8)|a[3]);
    }else{t="non_ipv4_or_null";for(size_t i=0;t[i];i++)b[k++]=t[i];}
    if(fd>=0&&fd<1024)a2_exact_fds[fd]=1;
    if(!real_getpeername)real_getpeername=(getpeername_fn)dlsym(RTLD_NEXT,"getpeername");
    if(!real_getsockname)real_getsockname=(getsockname_fn)dlsym(RTLD_NEXT,"getsockname");
    struct sockaddr_in peer={0},local={0};socklen_t peerlen=sizeof(peer),locallen=sizeof(local);
    int peer_ok=real_getpeername&&real_getpeername(fd,(struct sockaddr*)&peer,&peerlen)==0;
    int local_ok=real_getsockname&&real_getsockname(fd,(struct sockaddr*)&local,&locallen)==0;
    t=" connected_peer=";for(size_t i=0;t[i];i++)b[k++]=t[i];
    if(peer_ok&&peerlen>=sizeof(peer)&&peer.sin_family==2){const unsigned char*a=(const unsigned char*)&peer.sin_addr;
      for(int i=0;i<4;i++){emit_u(b,&k,a[i]);if(i<3)b[k++]='.';}b[k++]=':';emit_u(b,&k,bswap16(peer.sin_port));
    }else{t="unavailable_or_non_ipv4";for(size_t i=0;t[i];i++)b[k++]=t[i];}
    t=" local_socket=";for(size_t i=0;t[i];i++)b[k++]=t[i];
    if(local_ok&&locallen>=sizeof(local)&&local.sin_family==2){const unsigned char*a=(const unsigned char*)&local.sin_addr;
      for(int i=0;i<4;i++){emit_u(b,&k,a[i]);if(i<3)b[k++]='.';}b[k++]=':';emit_u(b,&k,bswap16(local.sin_port));
    }else{t="unavailable_or_non_ipv4";for(size_t i=0;t[i];i++)b[k++]=t[i];}
    t=" packet_payload=redacted";for(size_t i=0;t[i];i++)b[k++]=t[i];b[k++]='\n';write(2,b,k);
    a2_socket_details("sendto",fd,0,0,0);
    /* The destination is supplied per datagram: getpeername() can legitimately return ENOTCONN. */
    a2_sendto_target(fd,to,sl);
    if(errno_location)*errno_location()=saved_errno;
  }
  return result;
}
static void a2_receive_observation(const char*kind,int fd,ssize_t r,const struct sockaddr*source,socklen_t source_len,int source_valid){
  if(fd<0||fd>=1024||!a2_exact_fds[fd]||a2_rx_events++>=80)return;
  char b[160];size_t k=0;const char*t="XNET_A2_SOCKET_RX kind=";
  for(size_t i=0;t[i];i++)b[k++]=t[i];for(size_t i=0;kind[i];i++)b[k++]=kind[i];
  t=" fd=";for(size_t i=0;t[i];i++)b[k++]=t[i];emit_u(b,&k,(unsigned long)fd);
  t=" result=";for(size_t i=0;t[i];i++)b[k++]=t[i];if(r<0){b[k++]='-';emit_u(b,&k,(unsigned long)(-r));}else emit_u(b,&k,(unsigned long)r);
  t=" payload=redacted\n";for(size_t i=0;t[i];i++)b[k++]=t[i];write(2,b,k);
  a2_socket_details(kind,fd,source,source_len,source_valid);
}
ssize_t recvfrom(int fd,void*buf,size_t n,int flags,struct sockaddr*from,socklen_t*sl){if(!real_recvfrom)real_recvfrom=(recvfrom_fn)dlsym(RTLD_NEXT,"recvfrom");if(!real_recvfrom)return -1;ssize_t r=real_recvfrom(fd,buf,n,flags,from,sl);a2_receive_observation("recvfrom",fd,r,from,sl?*sl:0,r>=0&&from&&sl);if(r>0)diag_socket_event("recvfrom",fd,from,sl?*sl:0,r);if(r>0){if(from&&sl)emit_ipv4("recvfrom",fd,from,*sl,(size_t)r,(const unsigned char*)buf);trace_character_packet("recvfrom",(unsigned char*)buf,(size_t)r);scan_flv((const unsigned char*)buf,(size_t)r);}return r;}
ssize_t recv(int fd,void*buf,size_t n,int flags){if(!real_recv)real_recv=(recv_fn)dlsym(RTLD_NEXT,"recv");if(!real_recv)return -1;ssize_t r=real_recv(fd,buf,n,flags);a2_receive_observation("recv",fd,r,0,0,0);if(r>0){diag_socket_event("recv",fd,0,0,r);diag_local_http("rx",fd,(const unsigned char*)buf,(size_t)r);}if(r>0){trace_character_packet("recv",(unsigned char*)buf,(size_t)r);scan_flv((const unsigned char*)buf,(size_t)r);}return r;}
ssize_t read(int fd,void*buf,size_t n){if(!real_read)real_read=(read_fn)dlsym(RTLD_NEXT,"read");if(!real_read)return -1;ssize_t r=real_read(fd,buf,n);a2_receive_observation("read",fd,r,0,0,0);if(r>0){diag_socket_event("read",fd,0,0,r);diag_local_http("rx",fd,(const unsigned char*)buf,(size_t)r);}if(r>0){trace_character_packet("read",(unsigned char*)buf,(size_t)r);scan_flv((const unsigned char*)buf,(size_t)r);}return r;}
int connect(int fd,const struct sockaddr*sa,socklen_t sl){if(!real_connect)real_connect=(connect_fn)dlsym(RTLD_NEXT,"connect");if(!real_connect)return -1;emit_ipv4("connect",fd,sa,sl,0,0);const void*caller=__builtin_return_address(0);int r=real_connect(fd,sa,sl);a2_handoff("connect",fd,caller,sa,sl,(long)r);typedef int*(*a2_efn)(void);static a2_efn a2_connect_errno=0;
  if(!a2_connect_errno)a2_connect_errno=(a2_efn)dlsym(RTLD_NEXT,"__errno");
  int saved=a2_connect_errno?*a2_connect_errno():0;
  a2_transport_account(fd,caller,sa,sl,(long)r,1);
  diag_socket_event("connect",fd,sa,sl,r);
  if(a2_connect_errno)*a2_connect_errno()=saved;
  return r;}


static void trace_connected_peer(const char*kind,int fd,size_t n,const unsigned char*payload){
  if(!real_getpeername)real_getpeername=(getpeername_fn)dlsym(RTLD_NEXT,"getpeername");
  if(!real_getpeername)return; struct sockaddr_in a; socklen_t sl=sizeof(a);
  if(real_getpeername(fd,(struct sockaddr*)&a,&sl)==0)emit_ipv4(kind,fd,(struct sockaddr*)&a,sl,n,payload);
}
ssize_t send(int fd,const void*buf,size_t n,int flags){
  if(!real_send)real_send=(send_fn)dlsym(RTLD_NEXT,"send"); if(!real_send)return -1;
  const void*caller=__builtin_return_address(0);trace_connected_peer("send_peer",fd,n,(const unsigned char*)buf);
  ssize_t r=real_send(fd,buf,n,flags);typedef int*(*efn)(void);static efn ef=0;if(!ef)ef=(efn)dlsym(RTLD_NEXT,"__errno");int e=ef?*ef():0;
  a2_all_tx("send",fd,caller,0,0,r,e);diag_socket_event("send",fd,0,0,r);diag_local_http("tx",fd,(const unsigned char*)buf,n);if(ef)*ef()=e;return r;
}
ssize_t sendmsg(int fd,const struct msghdr*m,int flags){
  if(!real_sendmsg)real_sendmsg=(sendmsg_fn)dlsym(RTLD_NEXT,"sendmsg"); if(!real_sendmsg)return -1;
  size_t first_len=0; const unsigned char*payload=0; if(m&&m->msg_iov&&m->msg_iovlen){payload=(const unsigned char*)m->msg_iov[0].iov_base;first_len=m->msg_iov[0].iov_len;}
  if(m&&m->msg_name&&m->msg_namelen>=sizeof(struct sockaddr_in))emit_ipv4("sendmsg",fd,(const struct sockaddr*)m->msg_name,m->msg_namelen,first_len,payload); else trace_connected_peer("sendmsg_peer",fd,first_len,payload);
  const void*caller=__builtin_return_address(0);ssize_t r=real_sendmsg(fd,m,flags);typedef int*(*efn)(void);static efn ef=0;if(!ef)ef=(efn)dlsym(RTLD_NEXT,"__errno");int e=ef?*ef():0;
  a2_all_tx("sendmsg",fd,caller,m?(const struct sockaddr*)m->msg_name:0,m?m->msg_namelen:0,r,e);diag_socket_event("sendmsg",fd,m?(const struct sockaddr*)m->msg_name:0,m?m->msg_namelen:0,r);diag_local_http("tx",fd,payload,first_len);if(ef)*ef()=e;return r;
}
ssize_t writev(int fd,const struct iovec*iov,int iovcnt){
  if(!real_writev)real_writev=(writev_fn)dlsym(RTLD_NEXT,"writev"); if(!real_writev)return -1;
  size_t first_len=0; const unsigned char*payload=0; if(iov&&iovcnt>0){payload=(const unsigned char*)iov[0].iov_base;first_len=iov[0].iov_len;}
  /* v8.24: XNET may use writev on an already-connected UDP socket. This was
     the remaining imported transport primitive not covered by v8.14-v8.23.
     Read-only observation: resolve the connected peer and never reroute. */
  trace_connected_peer("writev_peer",fd,first_len,payload);
  const void*caller=__builtin_return_address(0);ssize_t r=real_writev(fd,iov,iovcnt);typedef int*(*efn)(void);static efn ef=0;if(!ef)ef=(efn)dlsym(RTLD_NEXT,"__errno");int e=ef?*ef():0;
  a2_all_tx("writev",fd,caller,0,0,r,e);diag_socket_event("writev",fd,0,0,r);diag_local_http("tx",fd,payload,first_len);if(ef)*ef()=e;return r;
}
ssize_t recvmsg(int fd,struct msghdr*m,int flags){
  if(!real_recvmsg)real_recvmsg=(recvmsg_fn)dlsym(RTLD_NEXT,"recvmsg"); if(!real_recvmsg)return -1; ssize_t r=real_recvmsg(fd,m,flags);a2_receive_observation("recvmsg",fd,r,m?(const struct sockaddr*)m->msg_name:0,m?m->msg_namelen:0,r>=0&&m&&m->msg_name&&m->msg_namelen>=2);if(r>0)diag_socket_event("recvmsg",fd,m?(const struct sockaddr*)m->msg_name:0,m?m->msg_namelen:0,r);
  if(r>0&&m){const unsigned char*payload=(m->msg_iov&&m->msg_iovlen)?(const unsigned char*)m->msg_iov[0].iov_base:0;size_t first_len=payload?m->msg_iov[0].iov_len:0;if(first_len>(size_t)r)first_len=(size_t)r;if(m->msg_name&&m->msg_namelen>=sizeof(struct sockaddr_in))emit_ipv4("recvmsg",fd,(const struct sockaddr*)m->msg_name,m->msg_namelen,first_len,payload);if(payload){diag_local_http("rx",fd,payload,first_len);trace_character_packet("recvmsg",(unsigned char*)payload,first_len);scan_flv(payload,first_len);}}
  return r;
}


static int contains_a2(const unsigned char*p,size_t n){
  if(!p||n<4)return 0; for(size_t i=0;i+4<=n;i++)if(p[i]==192&&p[i+1]==168&&p[i+2]==178&&p[i+3]==69)return 1; return 0;
}
static int contains_wsl(const unsigned char*p,size_t n){
  if(!p||n<4)return 0; for(size_t i=0;i+4<=n;i++)if(p[i]==172&&p[i+1]==28&&p[i+2]==101&&p[i+3]==255)return 1; return 0;
}
static void emit_select_cmp(const void*a,const void*b,size_t n,int r){
  static unsigned count=0; if(count++>200)return;
  char z[360];size_t q=0;const char*t="XNETSELECT_MEMCMP n=";for(size_t i=0;t[i];i++)z[q++]=t[i];emit_u(z,&q,n);
  t=" result=";for(size_t i=0;t[i];i++)z[q++]=t[i]; if(r<0){z[q++]='-';emit_u(z,&q,(unsigned long)(-r));}else emit_u(z,&q,(unsigned long)r);
  t=" a2_a=";for(size_t i=0;t[i];i++)z[q++]=t[i];emit_u(z,&q,contains_a2((const unsigned char*)a,n));
  t=" a2_b=";for(size_t i=0;t[i];i++)z[q++]=t[i];emit_u(z,&q,contains_a2((const unsigned char*)b,n));
  t=" wsl_a=";for(size_t i=0;t[i];i++)z[q++]=t[i];emit_u(z,&q,contains_wsl((const unsigned char*)a,n));
  t=" wsl_b=";for(size_t i=0;t[i];i++)z[q++]=t[i];emit_u(z,&q,contains_wsl((const unsigned char*)b,n));
  t=" firstA=";for(size_t i=0;t[i];i++)z[q++]=t[i];size_t lim=n<16?n:16;const unsigned char*pa=(const unsigned char*)a;for(size_t i=0;i<lim&&q+2<sizeof(z);i++){z[q++]=hx(pa[i]>>4);z[q++]=hx(pa[i]&15);} 
  t=" firstB=";for(size_t i=0;t[i];i++)z[q++]=t[i];const unsigned char*pb=(const unsigned char*)b;for(size_t i=0;i<lim&&q+2<sizeof(z);i++){z[q++]=hx(pb[i]>>4);z[q++]=hx(pb[i]&15);}z[q++]='\n';write(2,z,q);
}
int memcmp(const void*a,const void*b,size_t n){
  if(!real_memcmp)real_memcmp=(memcmp_fn)dlsym(RTLD_NEXT,"memcmp"); if(!real_memcmp)return 0;
  int r=real_memcmp(a,b,n); if(!guard&&n>0&&n<=256&&(contains_a2((const unsigned char*)a,n)||contains_a2((const unsigned char*)b,n)||contains_wsl((const unsigned char*)a,n)||contains_wsl((const unsigned char*)b,n))){guard=1;emit_select_cmp(a,b,n,r);guard=0;} return r;
}


/* v8.29: exact runtime imports write@LIBC. Previous transport coverage included
   send/sendto/sendmsg/writev/connect but not write. The v8.28 trace proves the
   selected LAN Character reaches timeout/resend (0x197474/0x1974d0). Observe
   write() destinations read-only to close that remaining libc transport gap.
   fd=2 is our own diagnostic sink and bypasses tracing to avoid recursion. */
long write(int fd,const void*buf,size_t n){
  if(!real_write_next)real_write_next=(ssize_t(*)(int,const void*,size_t))dlsym(RTLD_NEXT,"write");
  if(!real_write_next)return -1;
  if(fd==2||guard)return real_write_next(fd,buf,n);
  if(!real_getpeername)real_getpeername=(getpeername_fn)dlsym(RTLD_NEXT,"getpeername");
  if(real_getpeername){struct sockaddr sa; socklen_t sl=(socklen_t)sizeof(sa);if(real_getpeername(fd,&sa,&sl)==0)emit_ipv4("write_peer",fd,&sa,sl,n,(const unsigned char*)buf);}
  diag_local_http("tx",fd,(const unsigned char*)buf,n);
  return real_write_next(fd,buf,n);
}

__attribute__((destructor)) static void a2_transport_exit(void){a2_transport_summary("process_exit");}

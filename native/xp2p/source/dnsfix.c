typedef unsigned int socklen_t; typedef unsigned long size_t;
struct sockaddr { unsigned short sa_family; char sa_data[14]; };
struct addrinfo { int ai_flags, ai_family, ai_socktype, ai_protocol; socklen_t ai_addrlen; struct sockaddr *ai_addr; char *ai_canonname; struct addrinfo *ai_next; };
extern long write(int,const void*,size_t); extern int strcmp(const char*,const char*); extern void *dlsym(void*, const char*);
#define EAI_NONAME 8
#define RTLD_NEXT ((void*)-1L)
#define FIXED_IP "43.158.113.38"
typedef int (*gai_fn)(const char*,const char*,const struct addrinfo*,struct addrinfo**);
typedef int (*agafn_fn)(const char*,const char*,const struct addrinfo*,unsigned,unsigned,struct addrinfo**);
static void emit_mark(const char *s){ size_t n=0; while(s[n]) n++; write(2,s,n); }
__attribute__((constructor)) static void dnsfix_init(void){ emit_mark("DNSFIX_LOADED=1\n"); emit_mark("DNSFIX_MODE=bionic-numeric-delegation\n"); }
static int is_target(const char *n){ return n && (!strcmp(n,"stun.iotcloud.tencentdevices.com") || !strcmp(n,"stun.iotcloud.tencentiotcloud.com")); }
int getaddrinfo(const char *node,const char *service,const struct addrinfo *hints,struct addrinfo **res){
  gai_fn real=(gai_fn)dlsym(RTLD_NEXT,"getaddrinfo");
  if(!real) return EAI_NONAME;
  if(is_target(node)){
    emit_mark("DNSFIX_TENCENT_HIT=getaddrinfo\n");
    emit_mark("DNSFIX_DELEGATE=bionic_getaddrinfo_numeric\n");
    return real(FIXED_IP,service,hints,res);
  }
  return real(node,service,hints,res);
}
int android_getaddrinfofornet(const char *node,const char *service,const struct addrinfo *hints,unsigned netid,unsigned mark,struct addrinfo **res){
  agafn_fn real=(agafn_fn)dlsym(RTLD_NEXT,"android_getaddrinfofornet");
  if(!real) return EAI_NONAME;
  if(is_target(node)){
    emit_mark("DNSFIX_TENCENT_HIT=android_getaddrinfofornet\n");
    emit_mark("DNSFIX_DELEGATE=bionic_android_getaddrinfofornet_numeric\n");
    return real(FIXED_IP,service,hints,netid,mark,res);
  }
  return real(node,service,hints,netid,mark,res);
}

#import "NHDevUpdates.h"
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
#import <CommonCrypto/CommonDigest.h>
#import <TargetConditionals.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

NSString *NHDevelopmentRoot(void) {
  NSString *home=NSHomeDirectory().stringByResolvingSymlinksInPath;
#if TARGET_OS_SIMULATOR
  return home;
#else
  return [home stringByAppendingPathComponent:@"Documents"];
#endif
}

namespace {
constexpr size_t kFrameLimit = NH_DEV_PATCH_MAX_BYTES * 2 + 16384;
using Clock = std::chrono::steady_clock;
NSString *Root() { return NHDevelopmentRoot(); }
NSString *ResponseError(NSString *code, NSString *message) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"id":NSNull.null,@"error":@{@"code":code,@"message":message}} options:0 error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
void Require(bool condition, const char *message) {
  if (!condition) throw std::runtime_error(message);
}
bool Hex(NSString *value, NSUInteger size) {
  return [value isKindOfClass:NSString.class] && value.length == size &&
    [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location == NSNotFound;
}
uint64_t Number(NSString *value) {
  Require([value isKindOfClass:NSString.class] && value.length > 0 && value.length <= 20, "Invalid decimal integer");
  std::string text(value.UTF8String);
  Require(text.size() == 1 || text.front() != '0', "Noncanonical decimal integer");
  uint64_t n = 0;
  for (char c : text) {
    Require(c >= '0' && c <= '9' && n <= (UINT64_MAX - (c-'0'))/10, "Invalid decimal integer");
    n = n*10 + (c-'0');
  }
  return n;
}
bool Revision(NSString *value) {
  return [value isKindOfClass:NSString.class] && value.length > 0 && value.length <= 64 &&
    [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"] invertedSet]].location == NSNotFound;
}
// Deliberately narrow flat JSON. Reject duplicate keys, escapes, nested values,
// booleans, floats and trailing input before Foundation can normalize them.
NSDictionary *Flat(NSData *data, bool configuration) {
  const char *bytes = static_cast<const char *>(data.bytes);
  size_t at = 0;
  auto space = [&] { while (at < data.length && (bytes[at]==' ' || bytes[at]=='\n' || bytes[at]=='\r' || bytes[at]=='\t')) ++at; };
  auto take = [&](char c) { space(); Require(at < data.length && bytes[at++] == c, "Invalid flat JSON"); };
  auto string = [&]() -> NSString * {
    take('"'); size_t start = at;
    while (at < data.length && bytes[at] != '"') {
      unsigned char c = bytes[at++];
      Require(c >= 32 && c <= 126 && c != '\\', "Control strings must be unescaped ASCII");
    }
    Require(at < data.length, "Unterminated control string");
    NSString *value = [[NSString alloc] initWithBytes:bytes+start length:at-start encoding:NSASCIIStringEncoding];
    ++at; return value;
  };
  NSMutableDictionary *result = [NSMutableDictionary new];
  take('{'); space();
  if (at < data.length && bytes[at] == '}') ++at;
  else for (;;) {
    NSString *key = string(); Require(key.length <= 64 && !result[key], "Duplicate or oversized field"); take(':'); space();
    if (configuration && ([key isEqual:@"schemaVersion"] || [key isEqual:@"port"])) {
      size_t start = at; while (at < data.length && bytes[at] >= '0' && bytes[at] <= '9') ++at;
      NSString *number = [[NSString alloc] initWithBytes:bytes+start length:at-start encoding:NSASCIIStringEncoding];
      result[key] = @(Number(number));
    } else result[key] = string();
    Require(result.count <= 12, "Too many control fields"); space();
    if (at < data.length && bytes[at] == '}') { ++at; break; }
    take(',');
  }
  space(); Require(at == data.length, "Trailing control input"); return result;
}
void Keys(NSDictionary *value, NSArray *keys) {
  Require(value.count == keys.count, "Unexpected control fields");
  for (NSString *key in keys) Require(value[key] != nil, "Missing control field");
}
NSData *Unhex(NSString *text, NSUInteger bytes) {
  Require(Hex(text, bytes*2), "Invalid hexadecimal field");
  NSMutableData *result = [NSMutableData dataWithLength:bytes];
  uint8_t *out = static_cast<uint8_t *>(result.mutableBytes);
  const char *input = text.UTF8String;
  auto n = [](char c) { return c <= '9' ? c-'0' : c-'a'+10; };
  for (NSUInteger i=0;i<bytes;i++) out[i] = n(input[i*2])*16+n(input[i*2+1]);
  return result;
}
void ValidateRequest(NSDictionary *request, bool authenticated) {
  NSString *method = request[@"method"];
  if (!authenticated) {
    Keys(request,@[@"method",@"token"]);
    Require([method isEqual:@"authenticate"] && Hex(request[@"token"],64), "Authentication required"); return;
  }
  if ([method isEqual:@"dev.status"] || [method isEqual:@"dev.drain"]) { Keys(request,@[@"method"]); return; }
  Require([method isEqual:@"dev.enqueue"], "Unsupported development method");
  Keys(request,@[@"method",@"generation",@"sessionId",@"sequence",@"baseRevision",@"targetRevision",@"payloadSha256",@"payloadHex"]);
  Require(Number(request[@"generation"]) > 0 && Number(request[@"sequence"]) > 0, "Invalid sequence or generation");
  Require(Hex(request[@"sessionId"],32) && Hex(request[@"payloadSha256"],64), "Invalid update identity");
  Require(Revision(request[@"baseRevision"]) && Revision(request[@"targetRevision"]), "Invalid revision");
  NSString *payload = request[@"payloadHex"];
  Require(payload.length > 0 && payload.length <= NH_DEV_PATCH_MAX_BYTES*2 && payload.length%2 == 0 && Hex(payload,payload.length), "Invalid payload");
}
bool TokenEqual(NSString *a, NSString *b) {
  if (!Hex(a,64) || !Hex(b,64)) return false;
  const char *x=a.UTF8String,*y=b.UTF8String; unsigned different=0;
  for (unsigned i=0;i<64;i++) different |= x[i]^y[i]; return different==0;
}
bool Transfer(int fd, void *buffer, size_t size, bool write, unsigned seconds) {
  char *bytes = static_cast<char *>(buffer); size_t at=0;
  auto deadline=Clock::now()+std::chrono::seconds(seconds);
  while(at<size) {
    auto left=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-Clock::now()).count();
    if(left<=0) return false;
    pollfd p{fd,static_cast<short>(write?POLLOUT:POLLIN),0};
    int ready=poll(&p,1,static_cast<int>(left));
    if(ready<0 && errno==EINTR) continue;
    if(ready<=0 || (p.revents&(POLLERR|POLLNVAL))) return false;
    ssize_t n=write?send(fd,bytes+at,size-at,0):recv(fd,bytes+at,size-at,0);
    if(n<0 && (errno==EINTR || errno==EAGAIN || errno==EWOULDBLOCK)) continue;
    if(n<=0) return false; at+=n;
  }
  return true;
}
NSData *ReadFrame(int fd, bool authenticated) {
  uint8_t first;
  if(!Transfer(fd,&first,1,false,authenticated?60:5)) return nil;
  uint8_t header[4]={first,0,0,0};
  if(!Transfer(fd,header+1,3,false,5)) return nil;
  uint32_t size=(uint32_t(header[0])<<24)|(uint32_t(header[1])<<16)|(uint32_t(header[2])<<8)|header[3];
  if(size==0 || size>kFrameLimit || (!authenticated && size>1024)) return nil;
  NSMutableData *body=[NSMutableData dataWithLength:size];
  return Transfer(fd,body.mutableBytes,size,false,5)?body:nil;
}
bool WriteFrame(int fd, NSString *text) {
  NSData *body=[text dataUsingEncoding:NSUTF8StringEncoding];
  if(!body || body.length==0 || body.length>kFrameLimit) return false;
  uint32_t size=htonl(static_cast<uint32_t>(body.length));
  return Transfer(fd,&size,4,true,5) && Transfer(fd,const_cast<void *>(body.bytes),body.length,true,5);
}
NSData *ConfigurationData(NSString *path) {
  Require([path.stringByResolvingSymlinksInPath isEqual:path], "Configuration path cannot be a symlink");
  // Reject a FIFO/device after opening without allowing its open operation to
  // block the UI thread before the regular-file check can run.
  int fd=open(path.fileSystemRepresentation,O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);
  Require(fd>=0, "Cannot open development configuration");
  struct stat info{};
  if(fstat(fd,&info)!=0 || !S_ISREG(info.st_mode) || info.st_size<=0 || info.st_size>4096) { close(fd); throw std::runtime_error("Invalid configuration file"); }
  // The data container is already private. Restrict a copied config before reading.
  if(fchmod(fd,0600)!=0) { close(fd); throw std::runtime_error("Cannot protect configuration file"); }
  NSMutableData *data=[NSMutableData dataWithLength:static_cast<NSUInteger>(info.st_size)];
  size_t at=0; bool valid=true;
  while(at<data.length) { ssize_t n=read(fd,static_cast<char *>(data.mutableBytes)+at,data.length-at); if(n<0 && errno==EINTR) continue; if(n<=0) {valid=false;break;} at+=n; }
  char extra; if(read(fd,&extra,1)!=0) valid=false; close(fd);
  Require(valid,"Configuration changed while reading"); return data;
}
NSDictionary *ArtifactHashes() {
  NSString *bundle=NSBundle.mainBundle.bundlePath.stringByResolvingSymlinksInPath;
  NSMutableDictionary *hashes=[NSMutableDictionary new];
  for(NSString *name in @[@"NativeHost",@"NativeHost.debug.dylib",@"app.bundle.js",@"Frameworks/hermesvm.framework/hermesvm"]) {
    NSString *file=[bundle stringByAppendingPathComponent:name];
    if(![NSFileManager.defaultManager fileExistsAtPath:file]) {
      Require([name isEqual:@"NativeHost.debug.dylib"],"Missing development runtime artifact"); continue;
    }
    Require([file.stringByResolvingSymlinksInPath hasPrefix:[bundle stringByAppendingString:@"/"]],"Runtime artifact escaped app bundle");
    NSData *data=[NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:nil];
    Require(data && data.length>0 && data.length<=64*1024*1024,"Invalid development runtime artifact");
    unsigned char bytes[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes,(CC_LONG)data.length,bytes);
    NSMutableString *digest=[NSMutableString new];
    for(unsigned i=0;i<sizeof(bytes);i++) [digest appendFormat:@"%02x",bytes[i]];
    hashes[name]=digest;
  }
  return hashes;
}
}

NSString *NHDevUpdateResponse(NHHost *host, NSDictionary *request) {
  if(!NSThread.isMainThread || !host) return ResponseError(@"DEV_LIFETIME",@"Development host is unavailable");
  char *response=nullptr;
  try {
    NSString *method=request[@"method"];
    if([method isEqual:@"dev.open"]) {
      NHDevSessionV1 session{}; session.version=NH_DEV_UPDATES_VERSION; session.size=sizeof(session);
      session.generation=Number(request[@"generation"]);
      memcpy(session.session_id,Unhex(request[@"sessionId"],16).bytes,16);
      memcpy(session.initial_bundle_sha256,Unhex(request[@"initialBundleSha256"],32).bytes,32);
      Require(Revision(request[@"initialRevision"]),"Invalid initial revision");
      strcpy(session.initial_revision,[request[@"initialRevision"] UTF8String]);
      response=nh_host_dev_open(host,&session);
    } else if([method isEqual:@"dev.status"]) response=nh_host_dev_status(host);
    else if([method isEqual:@"dev.drain"]) response=nh_host_dev_drain(host);
    else if([method isEqual:@"dev.enqueue"]) {
      ValidateRequest(request,true);
      NHDevPatchV1 patch{}; patch.version=NH_DEV_UPDATES_VERSION; patch.size=sizeof(patch);
      patch.generation=Number(request[@"generation"]); patch.sequence=Number(request[@"sequence"]);
      memcpy(patch.session_id,Unhex(request[@"sessionId"],16).bytes,16);
      memcpy(patch.payload_sha256,Unhex(request[@"payloadSha256"],32).bytes,32);
      strcpy(patch.base_revision,[request[@"baseRevision"] UTF8String]); strcpy(patch.target_revision,[request[@"targetRevision"] UTF8String]);
      NSData *payload=Unhex(request[@"payloadHex"],[request[@"payloadHex"] length]/2);
      patch.payload=static_cast<const uint8_t *>(payload.bytes); patch.payload_length=payload.length;
      response=nh_host_dev_enqueue(host,&patch);
    } else return ResponseError(@"DEV_SCHEMA",@"Unsupported development method");
  } catch(const std::exception& error) { return ResponseError(@"DEV_SCHEMA",[NSString stringWithUTF8String:error.what()]); }
  if(!response) return ResponseError(@"DEV_ALLOCATION",@"No development response");
  NSString *text=[[NSString alloc] initWithBytes:response length:strlen(response) encoding:NSUTF8StringEncoding];
  nh_host_string_free(response); return text?:ResponseError(@"DEV_RESPONSE",@"Invalid development response");
}

@implementation NHDevUpdates {
  std::atomic<bool> _active;
  std::atomic<bool> _ownerTaskPending;
  std::mutex _socketMutex;
  int _listener, _client;
  NHDevRequestHandler _handler;
  NSString *_token;
  NSDictionary *_identity;
}
+ (void)prepareStagingRoot {
  NSString *root=[Root() stringByAppendingPathComponent:@"dev-revisions"];
  if([root.stringByResolvingSymlinksInPath isEqual:root])
    [NSFileManager.defaultManager createDirectoryAtPath:root withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:nil];
  [[NSURL fileURLWithPath:root] setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  // A receipt is valid for exactly one launch; never leave a prior port visible.
  [NSFileManager.defaultManager removeItemAtPath:[Root() stringByAppendingPathComponent:@"native-dev-ready.json"] error:nil];
  // devicectl cannot create missing intermediate directories in an app data
  // container. An explicit Debug launch can reserve one digits-only leaf; it
  // cannot overwrite an existing revision or accept a caller-supplied path.
  NSArray<NSString *> *arguments=NSProcessInfo.processInfo.arguments;
  NSUInteger stage=[arguments indexOfObject:@"--native-host-stage-revision"];
  NSUInteger end=[arguments indexOfObject:@"--native-host-end-session"];
  if(stage==NSNotFound && end==NSNotFound) return;
  NSMutableDictionary *receipt=[@{@"schemaVersion":@1,@"processId":@(NSProcessInfo.processInfo.processIdentifier)} mutableCopy];
  try {
    Require(stage==NSNotFound || end==NSNotFound,"Choose one development staging action");
    NSString *flag=stage!=NSNotFound?@"--native-host-stage-revision":@"--native-host-end-session";
    NSUInteger index=stage!=NSNotFound?stage:end;
    Require([[arguments filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"SELF == %@",flag]] count]==1 && index+1<arguments.count,"Invalid staging argument");
    NSString *value=arguments[index+1];
    if(stage!=NSNotFound) {
      Require(value.length>0 && value.length<=64 && [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789"] invertedSet]].location==NSNotFound,"Staging revision must contain 1-64 digits");
      receipt[@"revision"]=value; receipt[@"action"]=@"prepare-revision";
#if !TARGET_OS_SIMULATOR
      // Record the real device error from the former simulator-only location.
      // The probe is restricted to our old empty development directory and is
      // removed only when this call created it; no user content is touched.
      NSString *legacy=[NSHomeDirectory().stringByResolvingSymlinksInPath stringByAppendingPathComponent:@"dev-revisions"];
      if(![NSFileManager.defaultManager fileExistsAtPath:legacy]) {
        NSError *legacyError=nil;
        BOOL created=[NSFileManager.defaultManager createDirectoryAtPath:legacy withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:&legacyError];
        NSMutableDictionary *probe=[@{@"created":@(created),@"location":@"app-data-root/dev-revisions"} mutableCopy];
        if(legacyError) {
          probe[@"domain"]=legacyError.domain; probe[@"code"]=@(legacyError.code); probe[@"message"]=legacyError.localizedDescription;
          NSError *underlying=legacyError.userInfo[NSUnderlyingErrorKey];
          if(underlying) probe[@"underlying"]=@{@"domain":underlying.domain,@"code":@(underlying.code),@"message":underlying.localizedDescription};
        }
        if(created) probe[@"removedOwnedProbe"]=@([NSFileManager.defaultManager removeItemAtPath:legacy error:nil]);
        receipt[@"legacyContainerRootProbe"]=probe;
      }
      receipt[@"developmentLocation"]=@"Documents/dev-revisions";
#endif
      NSString *directory=[root stringByAppendingPathComponent:value];
      Require([root.stringByResolvingSymlinksInPath isEqual:root] && [directory.stringByResolvingSymlinksInPath isEqual:directory],"Staging paths cannot be symlinks");
      BOOL isDirectory=NO;
      if([NSFileManager.defaultManager fileExistsAtPath:directory isDirectory:&isDirectory]) {
        NSError *error=nil;
        NSArray *contents=[NSFileManager.defaultManager contentsOfDirectoryAtPath:directory error:&error];
        Require(isDirectory && contents && !error && contents.count==0,"Refusing to overwrite an existing revision");
      } else {
        NSError *error=nil;
        Require([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:&error],"Cannot prepare revision directory");
      }
      receipt[@"status"]=@"prepared";
    } else {
      Require(Hex(value,32),"Invalid session identity");
      receipt[@"sessionId"]=value; receipt[@"action"]=@"end-session";
      NSString *file=[Root() stringByAppendingPathComponent:@"native-dev-session.json"];
      if([NSFileManager.defaultManager fileExistsAtPath:file]) {
        NSDictionary *config=Flat(ConfigurationData(file),true);
        Require([config[@"sessionId"] isEqual:value],"Refusing to remove another development session");
        Require([NSFileManager.defaultManager removeItemAtPath:file error:nil],"Cannot remove owned development session");
      }
      receipt[@"status"]=@"disconnected";
    }
  } catch(const std::exception& error) {
    receipt[@"status"]=@"error"; receipt[@"error"]=[NSString stringWithUTF8String:error.what()];
  }
  NSString *file=[Root() stringByAppendingPathComponent:@"native-dev-stage.json"];
  if([file.stringByResolvingSymlinksInPath isEqual:file]) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:receipt options:0 error:nil];
    [data writeToFile:file options:NSDataWritingAtomic error:nil];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:file error:nil];
  }
}
- (void)receipt:(NSString *)status port:(unsigned)port error:(NSString *)error {
  NSMutableDictionary *value=[NSMutableDictionary dictionaryWithDictionary:_identity?:@{}];
  value[@"schemaVersion"]=@1; value[@"status"]=status; value[@"port"]=@(port);
  value[@"processId"]=@(NSProcessInfo.processInfo.processIdentifier);
  if(error) value[@"error"]=error;
  NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  NSString *file=[Root() stringByAppendingPathComponent:@"native-dev-ready.json"];
  if([file.stringByResolvingSymlinksInPath isEqual:file]) {
    [data writeToFile:file options:NSDataWritingAtomic error:nil];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:file error:nil];
  }
}
- (instancetype)initWithRevision:(NSString *)revision generation:(uint64_t)generation handler:(NHDevRequestHandler)handler {
  self=[super init]; if(!self) return nil;
  _active=false; _ownerTaskPending=false; _listener=-1; _client=-1; _handler=[handler copy];
  NSString *path=[Root() stringByAppendingPathComponent:@"native-dev-session.json"];
  if(![NSFileManager.defaultManager fileExistsAtPath:path]) return nil;
  try {
    Require(NSThread.isMainThread && generation>0,"Development setup requires the owner thread");
    NSDictionary *config=Flat(ConfigurationData(path),true);
    Keys(config,@[@"schemaVersion",@"token",@"sessionId",@"initialRevision",@"initialBundleSha256",@"port"]);
    Require([config[@"schemaVersion"] isEqual:@1] && [config[@"port"] unsignedLongLongValue]<=65535,"Invalid development configuration version or port");
    Require(Hex(config[@"token"],64) && Hex(config[@"sessionId"],32) && Hex(config[@"initialBundleSha256"],64) && Revision(config[@"initialRevision"]),"Invalid development configuration identity");
    _identity=@{@"sessionId":config[@"sessionId"],@"initialRevision":config[@"initialRevision"],@"generation":[NSString stringWithFormat:@"%llu",(unsigned long long)generation]};
    Require([revision isEqual:config[@"initialRevision"]],"Selected bundle does not match development configuration");
    NSMutableDictionary *open=[NSMutableDictionary dictionaryWithDictionary:_identity];
    open[@"method"]=@"dev.open"; open[@"initialBundleSha256"]=config[@"initialBundleSha256"];
    NSString *answer=_handler(open);
    NSDictionary *envelope=[NSJSONSerialization JSONObjectWithData:[answer dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    Require([envelope isKindOfClass:NSDictionary.class] && [envelope[@"result"] isKindOfClass:NSDictionary.class] && [envelope[@"result"][@"opened"] isEqual:@YES],"Native development session could not be opened");
    NSMutableDictionary *identity=[_identity mutableCopy]; identity[@"artifactHashes"]=ArtifactHashes(); _identity=identity;
    _token=config[@"token"];
    _listener=socket(AF_INET,SOCK_STREAM,0); Require(_listener>=0,"Cannot create development listener");
    int yes=1; setsockopt(_listener,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes));
    sockaddr_in address{}; address.sin_len=sizeof(address); address.sin_family=AF_INET; address.sin_addr.s_addr=htonl(INADDR_LOOPBACK); address.sin_port=htons([config[@"port"] unsignedShortValue]);
    Require(bind(_listener,reinterpret_cast<sockaddr *>(&address),sizeof(address))==0 && listen(_listener,1)==0,"Cannot bind development loopback listener");
    socklen_t length=sizeof(address); Require(getsockname(_listener,reinterpret_cast<sockaddr *>(&address),&length)==0,"Cannot identify development listener");
    _active=true; [self receipt:@"ready" port:ntohs(address.sin_port) error:nil];
    dispatch_async(dispatch_queue_create("dev.nativehost.updates",DISPATCH_QUEUE_SERIAL),^{ [self run]; });
    return self;
  } catch(const std::exception& error) {
    if(_listener>=0) { close(_listener); _listener=-1; }
    [self receipt:@"error" port:0 error:[NSString stringWithUTF8String:error.what()]]; return nil;
  }
}
- (NSString *)perform:(NSDictionary *)request socket:(int)socket {
  // A disconnected client cannot accumulate retained payloads while the owner
  // queue is blocked. The one slot remains occupied until its block actually
  // returns, including when that block has already been cancelled.
  bool expected=false;
  if(!_ownerTaskPending.compare_exchange_strong(expected,true))
    return ResponseError(@"DEV_BUSY",@"An owner-thread development task is pending");
  auto cancelled=std::make_shared<std::atomic<bool>>(false);
  dispatch_semaphore_t finished=dispatch_semaphore_create(0);
  __block NSString *answer=nil;
  dispatch_async(dispatch_get_main_queue(),^{
    if(self->_active && !cancelled->load()) answer=self->_handler(request);
    self->_ownerTaskPending=false;
    dispatch_semaphore_signal(finished);
  });
  auto deadline=Clock::now()+std::chrono::seconds(5);
  while(dispatch_semaphore_wait(finished,dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_MSEC))!=0) {
    pollfd p{socket,POLLIN,0}; int ready=poll(&p,1,0);
    char byte; bool disconnected=ready>0 && ((p.revents&(POLLERR|POLLHUP|POLLNVAL)) || ((p.revents&POLLIN) && recv(socket,&byte,1,MSG_PEEK|MSG_DONTWAIT)==0));
    if(!_active || disconnected || Clock::now()>=deadline) { cancelled->store(true); return nil; }
  }
  return answer;
}
- (void)run {
  while(_active) {
    pollfd listener{_listener,POLLIN,0}; int ready=poll(&listener,1,200);
    if(!_active) break;
    if(ready<0 && errno==EINTR) continue;
    if(ready<=0) continue;
    int socket=accept(_listener,nullptr,nullptr); if(socket<0) continue;
    { std::lock_guard<std::mutex> lock(_socketMutex); _client=socket; }
    fcntl(socket,F_SETFL,fcntl(socket,F_GETFL)|O_NONBLOCK);
    int yes=1; setsockopt(socket,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes));
    bool authenticated=false;
    while(_active) {
      @autoreleasepool {
        NSData *body=ReadFrame(socket,authenticated); if(!body) break;
        NSString *response;
        try {
          NSDictionary *request=Flat(body,false); ValidateRequest(request,authenticated);
          if(!authenticated) {
            if(!TokenEqual(request[@"token"],_token)) { WriteFrame(socket,ResponseError(@"DEV_AUTH",@"Authentication rejected")); break; }
            authenticated=true; response=@"{\"id\":null,\"result\":{\"authenticated\":true}}";
          } else response=[self perform:request socket:socket];
        } catch(const std::exception& error) {
          WriteFrame(socket,ResponseError(@"DEV_SCHEMA",[NSString stringWithUTF8String:error.what()]));
          break;
        }
        if(!response || !WriteFrame(socket,response)) break;
      }
    }
    { std::lock_guard<std::mutex> lock(_socketMutex); close(_client); _client=-1; }
  }
  { std::lock_guard<std::mutex> lock(_socketMutex); if(_listener>=0) close(_listener); _listener=-1; }
}
- (void)stop {
  bool wasActive=_active.exchange(false); if(!wasActive) return;
  { std::lock_guard<std::mutex> lock(_socketMutex); if(_client>=0) shutdown(_client,SHUT_RDWR); if(_listener>=0) shutdown(_listener,SHUT_RDWR); }
  [self receipt:@"stopped" port:0 error:nil];
}
- (void)dealloc { [self stop]; }
@end
#endif

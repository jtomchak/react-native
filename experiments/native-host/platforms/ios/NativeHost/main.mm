#import "NHAppState.h"
#import "NHDevUpdates.h"
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <CommonCrypto/CommonDigest.h>
#include "host.h"
#include <stdlib.h>
#include <string.h>

@class NHController;
@interface NHProxy : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) NHController *owner;
@property(nonatomic, copy) NSString *node;
@end
@interface NHFrameProxy : NSObject
@property(nonatomic, weak) NHController *owner;
- (void)tick;
@end

@interface NHContainer : UIView
@property(nonatomic, copy) NSString *pointerMode;
@end
@implementation NHContainer
- (UIView *)hitTest:(CGPoint)p withEvent:(UIEvent *)event {
  if ([self.pointerMode isEqual:@"none"]) return nil;
  UIView *hit = [super hitTest:p withEvent:event];
  if ([self.pointerMode isEqual:@"box-none"] && hit == self) return nil;
  return [self.pointerMode isEqual:@"box-only"] && hit ? self : hit;
}
@end

@interface NHController : UIViewController <UITextFieldDelegate, WKNavigationDelegate, UIScrollViewDelegate>
@property(nonatomic) NHHost *host;
@property(nonatomic) NSMutableDictionary *nodes, *types, *webRecords, *webSources, *textEventCounts;
@property(nonatomic) CADisplayLink *displayLink;
@property(nonatomic) UIView *surface;
@property(nonatomic) NSString *epoch;
@property(nonatomic) NSString *failure;
@property(nonatomic) NSString *loadedRevision;
@property(nonatomic) NSNumber *runtimeGeneration;
@property(nonatomic) NHAppStateObserver *appStateObserver;
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
@property(nonatomic) NHDevUpdates *devUpdates;
#endif
@property(nonatomic) BOOL committing;
- (void)commit:(NSDictionary *)snapshot;
- (void)event:(NSString *)event node:(NSString *)node payload:(id)payload;
- (void)webMessage:(WKScriptMessage *)message node:(NSString *)node;
- (void)pump;
- (void)consume:(char *)response;
- (void)updateHealth;
- (NSDictionary *)command:(NSDictionary *)request;
@end

static NSString *String(id value) { return [value isKindOfClass:NSString.class] ? value : (value && value != NSNull.null ? [value description] : @""); }
static BOOL BundleFile(NSURL *url) {
  if (!url.isFileURL) return NO;
  NSString *path=url.URLByStandardizingPath.URLByResolvingSymlinksInPath.path;
  NSString *root=NSBundle.mainBundle.bundleURL.URLByStandardizingPath.URLByResolvingSymlinksInPath.path;
  return [path isEqual:root] || [path hasPrefix:[root stringByAppendingString:@"/"]];
}
#if defined(NH_TEST_HOOKS) || (defined(NH_DEV_UPDATES) && NH_DEV_UPDATES)
static BOOL Digits(NSString *value) {
  return value.length>0 && value.length<=64 && [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789"] invertedSet]].location==NSNotFound;
}
static NSString *Digest(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes,(CC_LONG)data.length,digest);
  NSMutableString *hex=[NSMutableString new]; for(unsigned i=0;i<CC_SHA256_DIGEST_LENGTH;i++) [hex appendFormat:@"%02x",digest[i]]; return hex;
}
static BOOL VerifiedFile(NSString *file, NSDictionary *metadata) {
  NSData *data=[NSData dataWithContentsOfFile:file];
  return data && data.length<=8*1024*1024 && [metadata[@"byteLength"] isKindOfClass:NSNumber.class] && [metadata[@"byteLength"] unsignedLongLongValue]==data.length && [metadata[@"sha256"] isKindOfClass:NSString.class] && [Digest(data) isEqual:metadata[@"sha256"]];
}
#endif
static UIColor *Color(id value) {
  if (![value isKindOfClass:NSString.class]) return nil;
  NSDictionary *named = @{@"white":UIColor.whiteColor,@"black":UIColor.blackColor,@"transparent":UIColor.clearColor,@"red":UIColor.redColor,@"blue":UIColor.blueColor};
  if (named[value]) return named[value];
  NSString *s = [(NSString *)value stringByReplacingOccurrencesOfString:@"#" withString:@""];
  if (s.length == 3) s = [NSString stringWithFormat:@"%C%C%C%C%C%C",[s characterAtIndex:0],[s characterAtIndex:0],[s characterAtIndex:1],[s characterAtIndex:1],[s characterAtIndex:2],[s characterAtIndex:2]];
  unsigned int n = 0; if (![[NSScanner scannerWithString:s] scanHexInt:&n]) return nil;
  if (s.length == 6) return [UIColor colorWithRed:((n>>16)&255)/255.0 green:((n>>8)&255)/255.0 blue:(n&255)/255.0 alpha:1];
  if (s.length == 8) return [UIColor colorWithRed:((n>>24)&255)/255.0 green:((n>>16)&255)/255.0 blue:((n>>8)&255)/255.0 alpha:(n&255)/255.0];
  return nil;
}
static NSString *Text(NSDictionary *node) {
  if ([node[@"type"] isEqual:@"#text"]) return String(node[@"props"][@"text"] ?: node[@"text"] ?: node[@"props"][@"value"]);
  NSMutableString *text = [NSMutableString new]; for (NSDictionary *child in node[@"children"] ?: @[]) [text appendString:Text(child)]; return text;
}
static void Committed(void *context, const char *json) {
  NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
  [(__bridge NHController *)context commit:[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]];
}
static char *Commanded(void *context, const char *json) {
  NSData *data=[NSData dataWithBytes:json length:strlen(json)];
  id request=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  NSDictionary *response=[(__bridge NHController *)context command:request];
  NSData *encoded=[NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
  char *result=(char *)malloc(encoded.length+1); if(!result) return nullptr;
  memcpy(result,encoded.bytes,encoded.length); result[encoded.length]=0; return result;
}
static NSDictionary *CommandError(NSString *code, NSString *message) { return @{@"error":@{@"code":code,@"message":message}}; }
@implementation NHProxy
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message { [self.owner webMessage:message node:self.node]; }
@end
@implementation NHFrameProxy
- (void)tick { [self.owner pump]; }
@end

@implementation NHController
- (void)viewDidLoad {
  [super viewDidLoad]; self.view.backgroundColor = UIColor.whiteColor;
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
  [NHDevUpdates prepareStagingRoot];
#endif
  self.nodes=[NSMutableDictionary new]; self.types=[NSMutableDictionary new]; self.webRecords=[NSMutableDictionary new]; self.webSources=[NSMutableDictionary new]; self.textEventCounts=[NSMutableDictionary new]; self.epoch=NSUUID.UUID.UUIDString;
  self.surface=[NHContainer new]; self.surface.accessibilityIdentifier=@"native-surface"; self.surface.accessibilityValue=@"starting"; [self.view addSubview:self.surface];
}
- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated]; if(self.host) return;
  self.surface.frame=UIEdgeInsetsInsetRect(self.view.bounds,self.view.safeAreaInsets);
  NSString *bundle=[NSBundle.mainBundle pathForResource:@"app.bundle" ofType:@"js"];
#if defined(NH_TEST_HOOKS) || (defined(NH_DEV_UPDATES) && NH_DEV_UPDATES)
  self.loadedRevision=@"packaged-development";
  NSArray *arguments=NSProcessInfo.processInfo.arguments;
  NSUInteger revisionIndex=[arguments indexOfObject:@"--native-host-revision"];
  if(revisionIndex!=NSNotFound) {
    NSString *revision=revisionIndex+1<arguments.count ? arguments[revisionIndex+1] : @"";
    self.loadedRevision=revision;
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
    NSString *base=[NHDevelopmentRoot() stringByAppendingPathComponent:@"dev-revisions"];
#else
    NSString *base=[NSHomeDirectory().stringByResolvingSymlinksInPath stringByAppendingPathComponent:@"dev-revisions"];
#endif
    NSString *directory=[base stringByAppendingPathComponent:revision];
    NSString *canonical=[directory stringByResolvingSymlinksInPath];
    NSString *expected=[[base stringByResolvingSymlinksInPath] stringByAppendingPathComponent:revision];
    NSString *manifestPath=[directory stringByAppendingPathComponent:@"manifest.json"];
    NSData *manifestData=Digits(revision) && [base.stringByResolvingSymlinksInPath isEqual:base] && [canonical isEqual:expected] && [manifestPath.stringByResolvingSymlinksInPath isEqual:manifestPath] ? [NSData dataWithContentsOfFile:manifestPath] : nil;
    NSDictionary *manifest=manifestData ? [NSJSONSerialization JSONObjectWithData:manifestData options:0 error:nil] : nil;
    NSString *candidate=[directory stringByAppendingPathComponent:@"app.bundle.js"];
    NSString *map=[directory stringByAppendingPathComponent:@"app.bundle.js.map"];
    BOOL valid=[manifest isKindOfClass:NSDictionary.class] && [manifest[@"schemaVersion"] isEqual:@1] && [manifest[@"mode"] isEqual:@"development"] && [manifest[@"reload"] isEqual:@"full"] && [manifest[@"revision"] isEqual:revision] && [candidate.stringByResolvingSymlinksInPath isEqual:candidate] && [map.stringByResolvingSymlinksInPath isEqual:map] && VerifiedFile(candidate,manifest) && [manifest[@"sourceMap"] isKindOfClass:NSDictionary.class] && [manifest[@"sourceMap"][@"file"] isEqual:@"app.bundle.js.map"] && VerifiedFile(map,manifest[@"sourceMap"]);
    if(valid) bundle=candidate; else self.failure=@"Development revision rejected: invalid path, manifest, length or SHA256";
  }
#else
  self.loadedRevision=@"packaged-release";
#endif
  if(self.failure) { [self updateHealth]; UILabel *error=[[UILabel alloc] initWithFrame:self.surface.bounds]; error.text=self.failure; error.numberOfLines=0; error.accessibilityIdentifier=@"host-error"; [self.surface addSubview:error]; return; }
  NHHostOptions options={}; options.version=NH_HOST_OPTIONS_VERSION; options.size=sizeof(options);
  options.commit_callback=Committed; options.commit_context=(__bridge void *)self;
  options.initial_app_state=[NHAppStateObserver currentState].UTF8String;
  options.command_callback=Commanded; options.command_context=(__bridge void *)self;
  options.command_capabilities_json=R"({"TextInput":["focus","blur","clear"],"ScrollView":["scrollTo","scrollToEnd"],"WebView":["goBack","goForward","reload","stopLoading","postMessage","injectJavaScript"]})";
  self.host=nh_host_create_with_options(bundle.UTF8String,self.surface.bounds.size.width,self.surface.bounds.size.height,"ios",&options);
  if(!self.host) { self.failure=[NSString stringWithFormat:@"Host failed: %s",nh_host_last_error()]; [self updateHealth]; UILabel *error=[[UILabel alloc] initWithFrame:self.surface.bounds]; error.numberOfLines=0; error.text=self.failure; error.accessibilityIdentifier=@"host-error"; [self.surface addSubview:error]; return; }
  [self updateHealth];
  char *identity=nh_host_dispatch(self.host,"{\"id\":null,\"method\":\"session.describe\",\"params\":{}}");
  if(identity) { NSData *data=[NSData dataWithBytes:identity length:strlen(identity)]; NSDictionary *description=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]; self.runtimeGeneration=description[@"result"][@"generation"]; [self consume:identity]; }
#ifdef NH_TEST_HOOKS
  if([arguments containsObject:@"--native-host-inject-error"]) [self consume:nh_host_dispatch(self.host,"{\"id\":null,\"method\":\"runtime.eval\",\"params\":{\"source\":\"setTimeout(() => { throw new Error('intentional-ios-health-fault'); }, 0); undefined\"}}")];
#endif
  __weak NHController *weakSelf=self;
  NHHost *observedHost=self.host; uint64_t observedGeneration=self.runtimeGeneration.unsignedLongLongValue;
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
  NSString *developmentEpoch=self.epoch;
  self.devUpdates=[[NHDevUpdates alloc] initWithRevision:self.loadedRevision generation:observedGeneration handler:^NSString *(NSDictionary *request) {
    NHController *owner=weakSelf;
    if(!owner || !owner.host || ![owner.epoch isEqual:developmentEpoch] || owner.runtimeGeneration.unsignedLongLongValue!=observedGeneration)
      return @"{\"id\":null,\"error\":{\"code\":\"DEV_LIFETIME\",\"message\":\"Development host is unavailable\"}}";
    return NHDevUpdateResponse(owner.host,request);
  }];
#endif
  self.appStateObserver=[[NHAppStateObserver alloc] initWithCallback:^(NSString *state) {
    NHController *owner=weakSelf;
    if(owner && owner.host==observedHost && owner.runtimeGeneration.unsignedLongLongValue==observedGeneration)
      [owner consume:nh_host_app_state_update(observedHost,observedGeneration,state.UTF8String)];
  }];
  NHFrameProxy *ticker=[NHFrameProxy new]; ticker.owner=self;
  self.displayLink=[CADisplayLink displayLinkWithTarget:ticker selector:@selector(tick)]; [self.displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}
- (void)updateHealth {
  NSDictionary *health=@{@"healthy":@(!self.failure && self.host!=nullptr),@"status":self.failure ?: (self.host ? @"healthy" : @"starting"),@"loadedRevision":self.loadedRevision ?: @"starting",@"runtimeEpoch":self.epoch ?: @"",@"runtimeGeneration":self.runtimeGeneration ?: @0,@"pid":@(NSProcessInfo.processInfo.processIdentifier)};
  self.surface.accessibilityValue=[[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:health options:0 error:nil] encoding:NSUTF8StringEncoding];
}
- (void)consume:(char *)response {
  if(!response) { if(!self.failure) self.failure=@"Native host returned no response"; [self updateHealth]; return; }
  NSData *data=[NSData dataWithBytes:response length:strlen(response)];
  NSError *parseError=nil;
  id envelope=[NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];
  nh_host_string_free(response);
  if(!self.failure) {
    if(![envelope isKindOfClass:NSDictionary.class] || parseError) self.failure=@"Invalid native host response";
    else if(envelope[@"error"]) self.failure=String(envelope[@"error"]);
    else {
      id result=envelope[@"result"];
      if([result isKindOfClass:NSDictionary.class]) {
        NSArray *errors=[result[@"errors"] isKindOfClass:NSArray.class] ? result[@"errors"] : nil;
        if(errors.count) self.failure=String(errors.firstObject);
        else if([result[@"suppressedErrors"] unsignedIntegerValue]>0) self.failure=@"Native host suppressed additional asynchronous errors";
      }
    }
  }
  [self updateHealth];
}
- (void)pump { if(self.host) [self consume:nh_host_pump(self.host)]; }
- (NSString *)nodeForView:(UIView *)view { for(NSString *key in self.nodes) if(self.nodes[key]==view) return key; return nil; }
- (void)event:(NSString *)event node:(NSString *)node payload:(id)payload {
  // UIKit may call delegates synchronously inside a commit or command callback.
  // Dispatch only after the host call returns, and reject obsolete native owners.
  UIView *view=node ? self.nodes[node] : nil; if(!view) return;
  NSString *epoch=self.epoch, *document=self.webRecords[node][@"token"];
  __weak NHController *weakSelf=self; __weak UIView *weakView=view;
  dispatch_async(dispatch_get_main_queue(), ^{
    NHController *owner=weakSelf; UIView *current=weakView;
    if(!owner.host || !current || owner.nodes[node]!=current || ![owner.epoch isEqual:epoch]) return;
    if(document && ![owner.webRecords[node][@"token"] isEqual:document]) return;
    NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"id":@1,@"method":@"app.event",@"params":@{@"nodeId":@([node longLongValue]),@"event":event,@"payload":payload ?: NSNull.null}} options:0 error:nil];
    NSString *json=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    [owner consume:nh_host_dispatch(owner.host,json.UTF8String)];
  });
}
- (NSDictionary *)command:(NSDictionary *)request {
  if(!NSThread.isMainThread) return CommandError(@"wrong_thread",@"Native commands require the UI thread");
  if(![request isKindOfClass:NSDictionary.class] || ![request[@"version"] isEqual:@1] || ![request[@"generation"] isKindOfClass:NSNumber.class] || [request[@"generation"] unsignedLongLongValue]==0) return CommandError(@"invalid_command",@"Invalid native command envelope");
  if(self.runtimeGeneration && ![self.runtimeGeneration isEqual:request[@"generation"]]) return CommandError(@"stale_runtime",@"Runtime generation changed");
  self.runtimeGeneration=request[@"generation"];
  NSString *node=String(request[@"nodeId"]), *name=String(request[@"name"]), *type=self.types[node];
  UIView *view=self.nodes[node]; NSDictionary *args=request[@"args"];
  if(!view || !view.superview) return CommandError(@"stale_node",@"Native node is no longer mounted");
  if(![args isKindOfClass:NSDictionary.class]) return CommandError(@"invalid_arguments",@"Command arguments must be an object");
  if([type isEqual:@"TextInput"] && [view isKindOfClass:UITextField.class]) {
    UITextField *field=(UITextField *)view;
    if([name isEqual:@"focus"]) { if(![field becomeFirstResponder]) return CommandError(@"focus_failed",@"Text input could not become first responder"); }
    else if([name isEqual:@"blur"]) [field resignFirstResponder];
    else if([name isEqual:@"clear"]) field.text=@"";
    else return CommandError(@"unsupported_command",@"Unsupported TextInput command");
  } else if([type isEqual:@"ScrollView"] && [view isKindOfClass:UIScrollView.class]) {
    UIScrollView *scroll=(UIScrollView *)view;
    if([name isEqual:@"scrollTo"]) [scroll setContentOffset:CGPointMake([args[@"x"] doubleValue],[args[@"y"] doubleValue]) animated:args[@"animated"] ? [args[@"animated"] boolValue] : YES];
    else if([name isEqual:@"scrollToEnd"]) [scroll setContentOffset:CGPointMake(scroll.contentOffset.x,MAX(-scroll.adjustedContentInset.top,scroll.contentSize.height-scroll.bounds.size.height+scroll.adjustedContentInset.bottom)) animated:args[@"animated"] ? [args[@"animated"] boolValue] : YES];
    else return CommandError(@"unsupported_command",@"Unsupported ScrollView command");
  } else if([type isEqual:@"WebView"] && [view isKindOfClass:WKWebView.class]) {
    WKWebView *web=(WKWebView *)view; NSDictionary *record=self.webRecords[node];
    if(!record || ![record[@"epoch"] isEqual:self.epoch]) return CommandError(@"stale_document",@"WebView has no current document");
    if([name isEqual:@"goBack"]) { if(web.canGoBack) [web goBack]; }
    else if([name isEqual:@"goForward"]) { if(web.canGoForward) [web goForward]; }
    else if([name isEqual:@"reload"]) [web reload];
    else if([name isEqual:@"stopLoading"]) [web stopLoading];
    else if([name isEqual:@"postMessage"] || [name isEqual:@"injectJavaScript"]) {
      NSString *source=args[@"source"];
      if([name isEqual:@"postMessage"]) {
        if(![args[@"data"] isKindOfClass:NSString.class]) return CommandError(@"invalid_arguments",@"Message data must be a string");
        NSData *data=[NSJSONSerialization dataWithJSONObject:@[args[@"data"]] options:0 error:nil];
        NSString *literal=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        source=[NSString stringWithFormat:@"window.dispatchEvent(new MessageEvent('message',{data:(%@)[0]}));void 0;",literal];
      }
      if(![source isKindOfClass:NSString.class]) return CommandError(@"invalid_arguments",@"JavaScript source must be a string");
      NSString *token=record[@"token"], *epoch=self.epoch;
      if(!token) return CommandError(@"stale_document",@"WebView document identity is not confirmed");
      NSData *tokenData=[NSJSONSerialization dataWithJSONObject:@[token] options:0 error:nil];
      NSString *tokenLiteral=[[NSString alloc] initWithData:tokenData encoding:NSUTF8StringEncoding];
      source=[NSString stringWithFormat:@"if(window.__nativeHostDocumentToken!== (%@)[0]) throw new Error('Native command document changed');\n%@",tokenLiteral,source];
      __weak NHController *weakSelf=self; __weak WKWebView *weakWeb=web;
      [web evaluateJavaScript:source completionHandler:^(id result, NSError *error) {
        NHController *owner=weakSelf; WKWebView *current=weakWeb;
        if(!owner || !current || owner.nodes[node]!=current || ![owner.epoch isEqual:epoch] || ![owner.webRecords[node][@"token"] isEqual:token]) return;
        if(error) [owner event:@"error" node:node payload:@{@"message":error.localizedDescription,@"command":name,@"documentGeneration":token}];
      }];
    } else return CommandError(@"unsupported_command",@"Unsupported WebView command");
  } else return CommandError(@"unsupported_command",@"Native node has no command implementation");
  return @{@"result":NSNull.null};
}
- (void)pressed:(UIButton *)button { [self event:@"press" node:[self nodeForView:button] payload:@{}]; }
- (void)changed:(UITextField *)field {
  NSString *node=[self nodeForView:field]; if(!node) return;
  NSNumber *count=@([self.textEventCounts[node] unsignedLongLongValue]+1);
  self.textEventCounts[node]=count;
  [self event:@"changeText" node:node payload:@{@"text":field.text ?: @"",@"eventCount":count}];
}
- (void)textFieldDidBeginEditing:(UITextField *)field { [self event:@"focus" node:[self nodeForView:field] payload:@{}]; }
- (void)textFieldDidEndEditing:(UITextField *)field { [self event:@"blur" node:[self nodeForView:field] payload:@{}]; }
- (BOOL)textFieldShouldReturn:(UITextField *)field { [self event:@"submitEditing" node:[self nodeForView:field] payload:@{@"text":field.text ?: @""}]; [field resignFirstResponder]; return YES; }
- (void)scrollViewDidScroll:(UIScrollView *)scroll { NSString *node=[self nodeForView:scroll]; if(node) [self event:@"scroll" node:node payload:@{@"contentOffset":@{@"x":@(scroll.contentOffset.x),@"y":@(scroll.contentOffset.y)}}]; }
- (void)prepareWeb:(WKWebView *)web node:(NSString *)node {
  // A React source change replaces this seed synchronously, before loading.
  // Native navigations retain the seed but each actual document gets a nonce.
  // URL shape does not determine document identity (History API can change it).
  NSString *seed=NSUUID.UUID.UUIDString;
  self.webRecords[node]=[@{@"seed":seed,@"epoch":self.epoch,@"serial":@0} mutableCopy];
  [web.configuration.userContentController removeAllUserScripts];
  NSString *script=[NSString stringWithFormat:@"(()=>{const words=new Uint32Array(4);crypto.getRandomValues(words);const token='%@:'+Array.from(words).join('-'),epoch='%@';window.__nativeHostDocumentToken=token;const send=(kind,data)=>window.webkit.messageHandlers.nativeHost.postMessage({kind,token,epoch,data});const bridge={postMessage(data){send('message',String(data))}};window.NativeHost=bridge;window.ReactNativeWebView=bridge;window.__nativeHostAnnounceDocument=()=>send('documentReady','');window.addEventListener('pageshow',window.__nativeHostAnnounceDocument);window.__nativeHostAnnounceDocument();})();",seed,self.epoch];
  [web.configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:script injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
}
- (void)deliverWebData:(NSString *)data node:(NSString *)node token:(NSString *)token {
  [self event:@"message" node:node payload:@{@"data":data,@"documentGeneration":token,@"runtimeEpoch":self.epoch}];
}
- (void)webMessage:(WKScriptMessage *)message node:(NSString *)node {
  NSMutableDictionary *record=self.webRecords[node]; NSDictionary *body=[message.body isKindOfClass:NSDictionary.class] ? message.body : nil;
  NSString *token=[body[@"token"] isKindOfClass:NSString.class] ? body[@"token"] : nil;
  if(!record || !body || !token || token.length>128 || !message.frameInfo.mainFrame || message.webView!=self.nodes[node] || ![body[@"epoch"] isEqual:self.epoch] || ![token hasPrefix:[record[@"seed"] stringByAppendingString:@":"]]) return;
  if([body[@"kind"] isEqual:@"documentReady"]) {
    if([record[@"token"] isEqual:token]) return;
    if(![record[@"pendingToken"] isEqual:token]) { record[@"pendingToken"]=token; record[@"pendingMessages"]=[NSMutableArray new]; record[@"pendingBytes"]=@0; [record removeObjectForKey:@"pendingFailure"]; }
    NSNumber *serial=record[@"serial"]; NSString *epoch=self.epoch;
    __weak NHController *weakSelf=self; __weak WKWebView *weakWeb=message.webView;
    [message.webView evaluateJavaScript:@"window.__nativeHostDocumentToken" completionHandler:^(id currentToken, NSError *error) {
      NHController *owner=weakSelf; WKWebView *web=weakWeb;
      if(error || !owner || !web || owner.nodes[node]!=web || owner.webRecords[node]!=record || ![owner.epoch isEqual:epoch] || ![record[@"serial"] isEqual:serial] || ![record[@"pendingToken"] isEqual:token] || ![currentToken isEqual:token]) return;
      record[@"token"]=token;
      if(record[@"pendingFailure"] && !owner.failure) { owner.failure=record[@"pendingFailure"]; [owner updateHealth]; }
      [record removeObjectForKey:@"pendingFailure"];
      NSArray *pending=[record[@"pendingMessages"] copy]; [record removeObjectForKey:@"pendingMessages"]; [record removeObjectForKey:@"pendingToken"]; [record removeObjectForKey:@"pendingBytes"];
      for(NSString *data in pending) [owner deliverWebData:data node:node token:token];
    }];
  } else if([body[@"kind"] isEqual:@"message"]) {
    if(![record[@"token"] isEqual:token] && ![record[@"pendingToken"] isEqual:token]) return;
    NSString *data=[body[@"data"] isKindOfClass:NSString.class] ? body[@"data"] : nil;
    if(!data) return;
    NSUInteger bytes=[data lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if(bytes>1024*1024) {
      if([record[@"token"] isEqual:token]) { if(!self.failure) self.failure=@"WebView message exceeds the 1 MiB limit"; [self updateHealth]; }
      else record[@"pendingFailure"]=@"WebView message exceeds the 1 MiB limit";
      return;
    }
    if([record[@"token"] isEqual:token]) [self deliverWebData:data node:node token:token];
    else if([record[@"pendingToken"] isEqual:token]) {
      NSMutableArray *pending=record[@"pendingMessages"];
      NSUInteger aggregate=[record[@"pendingBytes"] unsignedIntegerValue]+bytes;
      if(pending.count>=64 || aggregate>1024*1024) { record[@"pendingFailure"]=@"WebView document handshake buffer exceeded (64 messages or 1 MiB)"; return; }
      [pending addObject:data]; record[@"pendingBytes"]=@(aggregate);
    }
  }
}

- (void)webView:(WKWebView *)web didStartProvisionalNavigation:(WKNavigation *)navigation {
  NSString *node=[self nodeForView:web]; NSMutableDictionary *record=node ? self.webRecords[node] : nil;
  if(!record || (record[@"expectedNavigation"] && record[@"expectedNavigation"]!=navigation)) return;
  [record removeObjectForKey:@"expectedNavigation"]; record[@"navigation"]=navigation;
  record[@"serial"]=@([record[@"serial"] unsignedLongLongValue]+1);
  [record removeObjectForKey:@"token"]; [record removeObjectForKey:@"pendingToken"]; [record removeObjectForKey:@"pendingMessages"]; [record removeObjectForKey:@"pendingBytes"]; [record removeObjectForKey:@"pendingFailure"];
}
- (void)webView:(WKWebView *)web didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  // Failed/cancelled provisional loads can leave the prior document displayed.
  // Re-verify that actual document instead of reviving an old token by URL.
  NSString *node=[self nodeForView:web]; NSDictionary *record=node ? self.webRecords[node] : nil;
  if(record && record[@"navigation"]==navigation) [web evaluateJavaScript:@"window.__nativeHostAnnounceDocument && window.__nativeHostAnnounceDocument()" completionHandler:nil];
}
- (void)webView:(WKWebView *)web decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))handler {
  NSURL *url=action.request.URL; BOOL allowed=[@[@"about",@"http",@"https",@"data"] containsObject:url.scheme.lowercaseString];
  if(url.isFileURL) allowed=BundleFile(url);
  handler(allowed ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)web didFinishNavigation:(WKNavigation *)navigation { [self event:@"navigation" node:[self nodeForView:web] payload:@{@"url":web.URL.absoluteString ?: @"",@"loading":@NO}]; }
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)web { NSString *node=[self nodeForView:web]; if(node) { [self.webRecords removeObjectForKey:node]; [self event:@"error" node:node payload:@{@"message":@"Web content process terminated"}]; } }
- (UIView *)newView:(NSString *)type node:(NSString *)node {
  UIView *view;
  if([type isEqual:@"Text"] || [type isEqual:@"#text"]) { UILabel *label=[UILabel new]; label.numberOfLines=0; view=label; }
  else if([type isEqual:@"Pressable"]) { UIButton *button=[UIButton buttonWithType:UIButtonTypeCustom]; [button addTarget:self action:@selector(pressed:) forControlEvents:UIControlEventTouchUpInside]; view=button; }
  else if([type isEqual:@"TextInput"]) { UITextField *field=[UITextField new]; field.delegate=self; [field addTarget:self action:@selector(changed:) forControlEvents:UIControlEventEditingChanged]; view=field; }
  else if([type isEqual:@"Image"]) { UIImageView *image=[UIImageView new]; image.contentMode=UIViewContentModeScaleAspectFit; view=image; }
  else if([type isEqual:@"ScrollView"]) { UIScrollView *scroll=[UIScrollView new]; scroll.delegate=self; view=scroll; }
  else if([type isEqual:@"WebView"]) { WKWebViewConfiguration *config=[WKWebViewConfiguration new]; NHProxy *proxy=[NHProxy new]; proxy.owner=self; proxy.node=node; [config.userContentController addScriptMessageHandler:proxy name:@"nativeHost"]; WKWebView *web=[[WKWebView alloc] initWithFrame:CGRectZero configuration:config]; web.navigationDelegate=self; view=web; }
  else view=[NHContainer new];
  self.nodes[node]=view; self.types[node]=type; return view;
}
- (void)removeNode:(NSString *)node {
  UIView *view=self.nodes[node]; if([view isKindOfClass:WKWebView.class]) { WKWebView *web=(WKWebView *)view; web.navigationDelegate=nil; [web stopLoading]; [web.configuration.userContentController removeScriptMessageHandlerForName:@"nativeHost"]; [web.configuration.userContentController removeAllUserScripts]; }
  [self.webRecords removeObjectForKey:node]; [self.webSources removeObjectForKey:node]; [self.textEventCounts removeObjectForKey:node]; [view removeFromSuperview]; [self.nodes removeObjectForKey:node]; [self.types removeObjectForKey:node];
}
- (void)mount:(NSDictionary *)node parent:(UIView *)parent origin:(CGPoint)origin seen:(NSMutableSet *)seen {
  NSString *key=String(node[@"id"]), *type=String(node[@"type"]); if(!key.length) return; [seen addObject:key];
  if(self.nodes[key] && ![self.types[key] isEqual:type]) [self removeNode:key];
  BOOL created=self.nodes[key]==nil; UIView *view=self.nodes[key] ?: [self newView:type node:key]; if(view.superview!=parent) [parent addSubview:view]; else [parent bringSubviewToFront:view];
  NSDictionary *props=node[@"props"] ?: @{}, *style=[props[@"style"] isKindOfClass:NSDictionary.class] ? props[@"style"] : @{}, *bounds=node[@"bounds"] ?: @{};
  CGPoint absolute=CGPointMake([bounds[@"x"] doubleValue],[bounds[@"y"] doubleValue]);
  view.frame=CGRectMake(absolute.x-origin.x,absolute.y-origin.y,[bounds[@"width"] doubleValue],[bounds[@"height"] doubleValue]);
  view.backgroundColor=Color(style[@"backgroundColor"]) ?: UIColor.clearColor; view.alpha=style[@"opacity"] ? [style[@"opacity"] doubleValue] : 1; view.hidden=[style[@"display"] isEqual:@"none"];
  view.layer.cornerRadius=[style[@"borderRadius"] doubleValue]; view.layer.borderWidth=[style[@"borderWidth"] doubleValue]; view.layer.borderColor=(Color(style[@"borderColor"]) ?: UIColor.blackColor).CGColor; view.clipsToBounds=style[@"overflow"] ? [style[@"overflow"] isEqual:@"hidden"] : [view isKindOfClass:UIScrollView.class];
  view.accessibilityIdentifier=String(props[@"testID"]); view.accessibilityLabel=props[@"accessibilityLabel"]; view.accessibilityHint=props[@"accessibilityHint"];
  if([view isKindOfClass:NHContainer.class]) ((NHContainer *)view).pointerMode=props[@"pointerEvents"];
  if([view isKindOfClass:UILabel.class]) { UILabel *label=(UILabel *)view; label.text=Text(node); label.font=[UIFont systemFontOfSize:style[@"fontSize"] ? [style[@"fontSize"] doubleValue] : 14 weight:[style[@"fontWeight"] isEqual:@"bold"] ? UIFontWeightBold : UIFontWeightRegular]; label.textColor=Color(style[@"color"]) ?: UIColor.blackColor; label.textAlignment=[style[@"textAlign"] isEqual:@"center"] ? NSTextAlignmentCenter : NSTextAlignmentNatural; label.numberOfLines=[props[@"numberOfLines"] integerValue]; }
  else if([view isKindOfClass:UIButton.class]) { ((UIButton *)view).enabled=![props[@"disabled"] boolValue]; view.accessibilityTraits=UIAccessibilityTraitButton; view.accessibilityLabel=props[@"accessibilityLabel"] ?: Text(node); }
  else if([view isKindOfClass:UITextField.class]) { UITextField *field=(UITextField *)view; NSString *value=String(props[@"value"] ?: props[@"defaultValue"]); // A queued JS echo must not overwrite newer native edits. No-op assignments also preserve selection.
    BOOL acknowledged=[props[@"mostRecentEventCount"] unsignedLongLongValue]==[self.textEventCounts[key] unsignedLongLongValue];
    if(((props[@"value"] && acknowledged) || created) && ![field.text isEqual:value]) field.text=value; field.placeholder=props[@"placeholder"]; field.secureTextEntry=[props[@"secureTextEntry"] boolValue]; field.enabled=props[@"editable"] ? [props[@"editable"] boolValue] : YES; field.textColor=Color(style[@"color"]) ?: UIColor.blackColor; field.font=[UIFont systemFontOfSize:style[@"fontSize"] ? [style[@"fontSize"] doubleValue] : 16]; }
  else if([view isKindOfClass:UIImageView.class]) { id source=props[@"source"]; NSString *uri=[source isKindOfClass:NSDictionary.class] ? source[@"uri"] : nil; UIImage *image=nil; if([uri hasPrefix:@"data:"]) { NSArray *parts=[uri componentsSeparatedByString:@","]; if(parts.count==2) image=[UIImage imageWithData:[[NSData alloc] initWithBase64EncodedString:parts[1] options:0]]; } else if([uri hasPrefix:@"file:"]) image=[UIImage imageWithContentsOfFile:[NSURL URLWithString:uri].path]; else if(uri) image=[UIImage imageNamed:uri]; ((UIImageView *)view).image=image; }
  else if([view isKindOfClass:WKWebView.class]) { id source=props[@"source"]; if([source isKindOfClass:NSDictionary.class] && ![source isEqual:self.webSources[key]]) { self.webSources[key]=source; WKWebView *web=(WKWebView *)view; [self prepareWeb:web node:key]; WKNavigation *navigation=nil; if([source[@"html"] isKindOfClass:NSString.class]) navigation=[web loadHTMLString:source[@"html"] baseURL:NSBundle.mainBundle.bundleURL]; else { NSURL *url=[NSURL URLWithString:source[@"uri"] ?: @""]; if(BundleFile(url)) navigation=[web loadFileURL:url allowingReadAccessToURL:NSBundle.mainBundle.bundleURL]; else if([@[@"https",@"http"] containsObject:url.scheme]) navigation=[web loadRequest:[NSURLRequest requestWithURL:url]]; } if(navigation) { self.webRecords[key][@"navigation"]=navigation; self.webRecords[key][@"expectedNavigation"]=navigation; } } }
  if(![type isEqual:@"Text"] && ![type isEqual:@"#text"] && ![type isEqual:@"WebView"]) {
    CGFloat maxX=0,maxY=0; for(NSDictionary *child in node[@"children"] ?: @[]) { [self mount:child parent:view origin:absolute seen:seen]; NSDictionary *b=child[@"bounds"]; maxX=MAX(maxX,[b[@"x"] doubleValue]-absolute.x+[b[@"width"] doubleValue]); maxY=MAX(maxY,[b[@"y"] doubleValue]-absolute.y+[b[@"height"] doubleValue]); }
    if([view isKindOfClass:UIScrollView.class]) ((UIScrollView *)view).contentSize=CGSizeMake(MAX(view.bounds.size.width,maxX),MAX(view.bounds.size.height,maxY));
  }
}
- (void)commit:(NSDictionary *)snapshot {
  if(![snapshot isKindOfClass:NSDictionary.class]) return; self.committing=YES; NSMutableSet *seen=[NSMutableSet new];
  for(NSDictionary *child in snapshot[@"children"] ?: @[]) [self mount:child parent:self.surface origin:CGPointZero seen:seen];
  for(NSString *key in self.nodes.allKeys) if(![seen containsObject:key]) [self removeNode:key];
  [self updateHealth]; self.committing=NO;
}
- (void)dealloc {
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
  [self.devUpdates stop];
#endif
  [self.appStateObserver invalidate]; [self.displayLink invalidate]; for(NSString *key in self.nodes.allKeys) [self removeNode:key]; if(self.host) nh_host_destroy(self.host);
}
@end

@interface NHAppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic) UIWindow *window;
@end
@implementation NHAppDelegate
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)options { self.window=[[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds]; self.window.rootViewController=[NHController new]; [self.window makeKeyAndVisible]; return YES; }
@end
int main(int argc,char *argv[]) { @autoreleasepool { return UIApplicationMain(argc,argv,nil,NSStringFromClass(NHAppDelegate.class)); } }

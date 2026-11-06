#import "NHAppState.h"

@interface NHAppStateObserver ()
@property (nonatomic, copy) void (^callback)(NSString *state);
@property (nonatomic) BOOL live;
@end

@implementation NHAppStateObserver
+ (NSString *)currentState
{
  switch (UIApplication.sharedApplication.applicationState) {
    case UIApplicationStateActive:
      return @"active";
    case UIApplicationStateInactive:
      return @"inactive";
    case UIApplicationStateBackground:
      return @"background";
  }
}
- (instancetype)initWithCallback:(void (^)(NSString *))callback
{
  if ((self = [super init])) {
    self.callback = callback;
    self.live = YES;
    for (NSNotificationName name in @[
           UIApplicationDidBecomeActiveNotification,
           UIApplicationWillResignActiveNotification,
           UIApplicationDidEnterBackgroundNotification,
           UIApplicationWillEnterForegroundNotification
         ]) {
      [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(changed:) name:name object:nil];
    }
  }
  return self;
}
- (void)changed:(NSNotification *)notification
{
  NSString *state = [notification.name isEqual:UIApplicationDidBecomeActiveNotification] ? @"active"
      : [notification.name isEqual:UIApplicationDidEnterBackgroundNotification]          ? @"background"
                                                                                         : @"inactive";
  // A lifecycle notification can arrive during a native callback. Preserve the
  // OS-observed state now, but enter the host only on a later owner-thread turn.
  __weak NHAppStateObserver *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    NHAppStateObserver *observer = weakSelf;
    if (observer.live && observer.callback)
      observer.callback(state);
  });
}
- (void)invalidate
{
  self.live = NO;
  self.callback = nil;
  [NSNotificationCenter.defaultCenter removeObserver:self];
}
- (void)dealloc
{
  [NSNotificationCenter.defaultCenter removeObserver:self];
}
@end

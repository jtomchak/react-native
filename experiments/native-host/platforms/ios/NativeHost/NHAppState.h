#import <UIKit/UIKit.h>

// Real UIApplication lifecycle observer; never invokes Hermes directly.
@interface NHAppStateObserver : NSObject
+ (NSString *)currentState;
- (instancetype)initWithCallback:(void (^)(NSString *state))callback;
- (void)invalidate;
@end

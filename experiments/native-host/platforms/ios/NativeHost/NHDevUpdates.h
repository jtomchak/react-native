#pragma once
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
#import <Foundation/Foundation.h>
#include "host.h"
NS_ASSUME_NONNULL_BEGIN

// This handler is invoked only on the main queue. The controller resolves its
// current host through a weak reference; the transport never owns a host pointer.
typedef NSString *_Nonnull (^NHDevRequestHandler)(NSDictionary *_Nonnull request);
@interface NHDevUpdates : NSObject
+ (void)prepareStagingRoot;
- (nullable instancetype)initWithRevision:(NSString *)revision
                     generation:(uint64_t)generation
                        handler:(NHDevRequestHandler)handler;
- (void)stop;
@end

// Owner-thread adapter for already validated development envelopes.
NSString *NHDevUpdateResponse(NHHost *_Nullable host, NSDictionary *request);
// Physical iOS permits writable development artifacts under Documents. Keep
// the established simulator root so existing staged simulator fixtures survive.
NSString *NHDevelopmentRoot(void);
NS_ASSUME_NONNULL_END
#endif

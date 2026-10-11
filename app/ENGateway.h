#import <Foundation/Foundation.h>

// Talks to the user's Encore Bridge (the "gateway" in code). Every /v1 request is HMAC-signed with the pairing secret.
// Home address first (fast LAN probe), away address otherwise. Neither has a default: both stay empty until Setup (or
// Settings) saves what the user typed. (0.5 owner: DATA)

typedef void (^ENJSONBlock)(id json, NSInteger status, NSError *error);

extern NSString *const ENGatewayRouteChangedNotification;

@interface ENGateway : NSObject

+ (instancetype)shared;

@property (nonatomic, copy) NSString *homeURL;     // e.g. http://192.168.1.20:8095 ("" until saved)
@property (nonatomic, copy) NSString *awayURL;     // e.g. http://your-public-address:8095 ("" = none)
@property (nonatomic, readonly) NSString *baseURL; // whichever one answered last probe
@property (nonatomic, readonly) BOOL away;
@property (nonatomic, readonly) BOOL paired;
@property (nonatomic, readonly) NSString *deviceID;

// Check home, fall back to away. Calls back on the main thread.
- (void)probe:(void (^)(BOOL reachable))done;

- (void)pairWithCode:(NSString *)code completion:(void (^)(NSError *error))done;
- (void)unpair;

// pathAndQuery must already be percent-encoded (it is signed exactly as sent).
- (NSMutableURLRequest *)requestWithMethod:(NSString *)method path:(NSString *)pathAndQuery body:(NSData *)body;
- (void)sendMethod:(NSString *)method path:(NSString *)pathAndQuery json:(id)obj timeout:(NSTimeInterval)timeout completion:(ENJSONBlock)done;
// 4b-c: the same, but never sent twice once it may have reached the gateway: a network error (a timeout too) goes to done
// as it is (status 0) and is not resent on a new route (a route check starts for the next request). Only the 401
// clock-skew resend stays (that request was refused unread). For writes a second send could repeat: the Jam writes
// (/v1/jam/<action>: Spotify's social-connect) and the Up Next edits (/v1/jam/queue/*); their outcome is then settled by
// the next read or event.
- (void)sendOnceMethod:(NSString *)method path:(NSString *)pathAndQuery json:(id)obj timeout:(NSTimeInterval)timeout completion:(ENJSONBlock)done;
- (void)getData:(NSString *)pathAndQuery completion:(void (^)(NSData *data, NSInteger status))done;

// App 0.5 (catalog JSON and covers; owner: DATA). A raw signed GET: the same 401 clock-adopt retry and home/away re-probe as
// sendMethod, but no JSON parsing (ENCatalog parses on its own queue). If-None-Match is sent when etag is non-nil;
// cachePolicy NSURLRequestReloadIgnoringLocalCacheData (with the zero-size NSURLCache from +[ENCatalog prepareAtLaunch], iOS
// hands a 304 through as a 304). NSURLConnection asks for gzip and inflates by itself. Completion on the main queue:
// data = the body (for an HTTP error the gateway's {"error":…} JSON; nil for a 304 or a network error), status = the HTTP
// status (0 = network error, err set), etag = the response's ETag header exactly as sent, quotes included
// (allHeaderFields, @"ETag" or @"Etag"), nil if none.
- (void)fetchData:(NSString *)pathAndQuery etag:(NSString *)etag timeout:(NSTimeInterval)timeout
       completion:(void (^)(NSData *data, NSInteger status, NSString *etag, NSError *err))done;

// Server said 401: if its clock disagrees with ours, adopt the difference and return YES so the caller retries.
- (BOOL)adoptServerClockFrom:(NSHTTPURLResponse *)response;

+ (NSString *)escape:(NSString *)s;

@end

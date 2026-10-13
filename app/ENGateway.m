#import "ENGateway.h"
#import "ENCompat.h"
#import "ENKeychain.h"
#import "ENAnon.h"
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>
#import <CommonCrypto/CommonHMAC.h>
#import "ENL.h"

NSString *const ENGatewayRouteChangedNotification = @"ENGatewayRouteChanged";

// No built-in addresses: Setup asks for the Home address (and an optional Away one) and saves them before pairing.
static NSString *const kDefaultHome = @"";
static NSString *const kDefaultAway = @"";

static NSString *ENHex(const unsigned char *b, size_t n) {
	NSMutableString *s = [NSMutableString stringWithCapacity:n * 2];
	for (size_t i = 0; i < n; i++) [s appendFormat:@"%02x", b[i]];
	return s;
}

static NSData *ENDataFromHex(NSString *hex) {
	if (hex.length % 2) return nil;
	NSMutableData *d = [NSMutableData dataWithLength:hex.length / 2];
	unsigned char *p = d.mutableBytes;
	for (NSUInteger i = 0; i < hex.length / 2; i++) {
		unsigned int v = 0;
		if (![[NSScanner scannerWithString:[hex substringWithRange:NSMakeRange(i * 2, 2)]] scanHexInt:&v]) return nil;
		p[i] = (unsigned char)v;
	}
	return d;
}

static BOOL ENIsNetworkError(NSError *e) {
	if (![e.domain isEqualToString:NSURLErrorDomain]) return NO;
	switch (e.code) {
		case NSURLErrorTimedOut: case NSURLErrorCannotConnectToHost: case NSURLErrorNetworkConnectionLost:
		case NSURLErrorNotConnectedToInternet: case NSURLErrorCannotFindHost: case NSURLErrorDNSLookupFailed:
			return YES;
		default: return NO;
	}
}

@implementation ENGateway {
	NSData *_secret;
	NSString *_deviceID;
	NSString *_baseURL;
	BOOL _away;
	NSTimeInterval _clockOffset;
	NSMutableArray *_probeWaiters;
	BOOL _probedOnce;              // a route check has finished since launch (requests before it wait for it)
}

+ (instancetype)shared {
	static ENGateway *g;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ g = [[ENGateway alloc] init]; });
	return g;
}

- (instancetype)init {
	if ((self = [super init])) {
		NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
		_homeURL = [ud stringForKey:@"homeURL"] ?: kDefaultHome;
		_awayURL = [ud stringForKey:@"awayURL"] ?: kDefaultAway;
		// start on the route that worked last time: away, a home-first guess costs every early request a 20 s timeout
		_away = [ud boolForKey:@"lastAway"] && _awayURL.length;
		_baseURL = _away ? _awayURL : _homeURL;
		[self loadCreds];
	}
	return self;
}

- (void)loadCreds {
	NSDictionary *c = [ENKeychain load];
	_deviceID = c[@"device_id"];
	_secret = ENDataFromHex(c[@"secret_hex"] ?: @"");
	if (!_secret.length) { _secret = nil; _deviceID = nil; }
}

- (void)setHomeURL:(NSString *)u {
	_homeURL = [[u stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] copy];
	while ([_homeURL hasSuffix:@"/"]) _homeURL = [_homeURL substringToIndex:_homeURL.length - 1];
	[[NSUserDefaults standardUserDefaults] setObject:_homeURL forKey:@"homeURL"];
}

- (void)setAwayURL:(NSString *)u {
	_awayURL = [[u stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] copy];
	while ([_awayURL hasSuffix:@"/"]) _awayURL = [_awayURL substringToIndex:_awayURL.length - 1];
	[[NSUserDefaults standardUserDefaults] setObject:_awayURL forKey:@"awayURL"];
}

- (NSString *)baseURL { return _baseURL; }
- (BOOL)away { return _away; }
- (BOOL)paired { return _secret != nil && _deviceID != nil; }
- (NSString *)deviceID { return _deviceID; }

#pragma mark - route

// GET / answers "Encore gateway" (bridges up to 0.10) or "Encore Bridge" (the public name, D7): either one is Encore's
// bridge. An empty address (nothing saved yet) fails at once, still asynchronously, as a request would.
- (void)ping:(NSString *)base timeout:(NSTimeInterval)t done:(void (^)(BOOL ok))done {
	NSURL *url = base.length ? [NSURL URLWithString:[base stringByAppendingString:@"/"]] : nil;
	if (!url.host.length) { dispatch_async(dispatch_get_main_queue(), ^{ done(NO); }); return; }
	NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:t];
	[NSURLConnection sendAsynchronousRequest:r queue:[NSOperationQueue mainQueue] completionHandler:^(NSURLResponse *resp, NSData *data, NSError *err) {
		NSString *body = data ? [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] lowercaseString] : nil;
		done(!err && [(NSHTTPURLResponse *)resp statusCode] == 200 && ([body hasPrefix:@"encore gateway"] || [body hasPrefix:@"encore bridge"]));
	}];
}

- (void)probe:(void (^)(BOOL reachable))done {
	if (_probeWaiters) { if (done) [_probeWaiters addObject:[done copy]]; return; }
	_probeWaiters = [NSMutableArray array];
	if (done) [_probeWaiters addObject:[done copy]];
	NSString *before = _baseURL;
	void (^finish)(NSString *, BOOL, BOOL) = ^(NSString *base, BOOL away, BOOL ok) {
		if (ok) {
			self->_baseURL = base;
			self->_away = away;
			[[NSUserDefaults standardUserDefaults] setBool:away forKey:@"lastAway"];
		}
		self->_probedOnce = YES;
		NSArray *w = self->_probeWaiters;
		self->_probeWaiters = nil;
		if (![before isEqualToString:self->_baseURL])
			[[NSNotificationCenter defaultCenter] postNotificationName:ENGatewayRouteChangedNotification object:self];
		for (void (^b)(BOOL) in w) b(ok);
	};
	[self ping:_homeURL timeout:1.5 done:^(BOOL homeOK) {
		if (homeOK) { finish(self->_homeURL, NO, YES); return; }
		if (!self->_awayURL.length) { finish(nil, NO, NO); return; }
		[self ping:self->_awayURL timeout:6 done:^(BOOL awayOK) { finish(self->_awayURL, YES, awayOK); }];
	}];
}

// Requests made before the first route check of this run (the catalog revalidates at launch) wait for it: ~1.5 s at
// most when away, instead of trying a guessed route and timing out.
- (BOOL)deferUntilRouted:(void (^)(void))go {
	if (_probedOnce) return NO;
	[self probe:^(BOOL ok) { go(); }];
	return YES;
}

#pragma mark - pairing

- (void)pairWithCode:(NSString *)code completion:(void (^)(NSError *error))done {
	[self probe:^(BOOL reachable) {
		if (!reachable) {
			done([NSError errorWithDomain:@"Encore" code:1 userInfo:@{ NSLocalizedDescriptionKey: ENL(@"Can't reach your Encore Bridge at either address.") }]);
			return;
		}
		// (R2a) the name the bridge lists this phone under: the model while Anonymous Mode is on (D1: this iPhone's name)
		NSDictionary *body = @{ @"code": code ?: @"", @"device_name": [ENAnon thisDeviceName] ?: @"iPhone" };
		NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[self->_baseURL stringByAppendingString:@"/v1/pair"]]
		                                                 cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:15];
		r.HTTPMethod = @"POST";
		r.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:NULL];
		[r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
		[r setValue:[ENLang activeCode] forHTTPHeaderField:@"X-Encore-Lang"];
		// (1.1) sendAsynchronousRequest:queue:mainQueue; on iOS 5 (240 s minimum for a POST) the 15 s are kept by a watchdog
		ENSendAsynchronousRequest(r, ^(NSURLResponse *resp, NSData *data, NSError *err) {
			NSDictionary *j = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
			NSInteger st = [(NSHTTPURLResponse *)resp statusCode];
			if (err || st != 200 || ![j isKindOfClass:[NSDictionary class]] || !j[@"device_id"] || !j[@"secret_hex"]) {
				NSString *msg = [j isKindOfClass:[NSDictionary class]] ? j[@"error"][@"message"] : nil;
				done([NSError errorWithDomain:@"Encore" code:st userInfo:@{ NSLocalizedDescriptionKey: msg ?: err.localizedDescription ?: ENL(@"Pairing failed.") }]);
				return;
			}
			[ENKeychain save:@{ @"device_id": j[@"device_id"], @"secret_hex": j[@"secret_hex"] }];
			[self loadCreds];
			done(self.paired ? nil : [NSError errorWithDomain:@"Encore" code:2 userInfo:@{ NSLocalizedDescriptionKey: ENL(@"Couldn't save the pairing.") }]);
		});
	}];
}

- (void)unpair {
	[ENKeychain clear];
	_secret = nil;
	_deviceID = nil;
}

#pragma mark - signed requests

+ (NSString *)escape:(NSString *)s {
	return (__bridge_transfer NSString *)CFURLCreateStringByAddingPercentEscapes(NULL, (__bridge CFStringRef)s, NULL,
		CFSTR("!*'();:@&=+$,/?%#[]\" <>{}|\\^`"), kCFStringEncodingUTF8);
}

- (NSMutableURLRequest *)requestWithMethod:(NSString *)method path:(NSString *)pathAndQuery body:(NSData *)body {
	NSURL *url = [NSURL URLWithString:[_baseURL stringByAppendingString:pathAndQuery]];
	NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:20];
	r.HTTPMethod = method;
	if (body) { r.HTTPBody = body; [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"]; }
	[r setValue:[ENLang activeCode] forHTTPHeaderField:@"X-Encore-Lang"];      // the bridge answers in the app's language
	if (!_secret) return r;

	unsigned char h[CC_SHA256_DIGEST_LENGTH];
	CC_SHA256(body.length ? body.bytes : "", (CC_LONG)body.length, h);
	long long t = (long long)floor([[NSDate date] timeIntervalSince1970] + _clockOffset);
	NSString *msg = [NSString stringWithFormat:@"%@\n%@\n%lld\n%@", method, pathAndQuery, t, ENHex(h, sizeof h)];
	NSData *md = [msg dataUsingEncoding:NSUTF8StringEncoding];
	unsigned char mac[CC_SHA256_DIGEST_LENGTH];
	CCHmac(kCCHmacAlgSHA256, _secret.bytes, _secret.length, md.bytes, md.length, mac);
	[r setValue:_deviceID forHTTPHeaderField:@"X-Encore-Device"];
	[r setValue:[NSString stringWithFormat:@"%lld", t] forHTTPHeaderField:@"X-Encore-Time"];
	[r setValue:ENHex(mac, sizeof mac) forHTTPHeaderField:@"X-Encore-Sig"];
	return r;
}

- (BOOL)adoptServerClockFrom:(NSHTTPURLResponse *)response {
	NSString *ds = [response allHeaderFields][@"Date"];
	if (!ds) return NO;
	static NSDateFormatter *f;
	if (!f) {
		f = [[NSDateFormatter alloc] init];
		f.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
		f.timeZone = [NSTimeZone timeZoneWithAbbreviation:@"GMT"];
		f.dateFormat = @"EEE, dd MMM yyyy HH:mm:ss zzz";
	}
	NSDate *server = [f dateFromString:ds];
	if (!server) return NO;
	NSTimeInterval off = [server timeIntervalSinceNow];
	if (fabs(off - _clockOffset) < 30) return NO;
	NSLog(@"[Encore] phone clock is %.0f s off the gateway; compensating", off);
	_clockOffset = off;
	return YES;
}

- (void)sendMethod:(NSString *)method path:(NSString *)p json:(id)obj timeout:(NSTimeInterval)timeout completion:(ENJSONBlock)done {
	[self sendMethod:method path:p json:obj timeout:timeout retry:YES reroute:YES completion:done];
}

- (void)sendOnceMethod:(NSString *)method path:(NSString *)p json:(id)obj timeout:(NSTimeInterval)timeout completion:(ENJSONBlock)done {
	[self sendMethod:method path:p json:obj timeout:timeout retry:YES reroute:NO completion:done];
}

// retry: one resend after a 401 whose Date shows the phone's clock is off (the gateway refused the request unread).
// reroute: after a network error, re-probe and resend once if the route changed; NO for a request a second send could
// repeat (it may have reached the gateway): the error goes back at once and a route check starts for the next request.
// A resend has neither.
- (void)sendMethod:(NSString *)method path:(NSString *)p json:(id)obj timeout:(NSTimeInterval)timeout retry:(BOOL)retry
           reroute:(BOOL)reroute completion:(ENJSONBlock)done {
	if ([self deferUntilRouted:^{ [self sendMethod:method path:p json:obj timeout:timeout retry:retry reroute:reroute completion:done]; }]) return;
	NSData *body = obj ? [NSJSONSerialization dataWithJSONObject:obj options:0 error:NULL] : ([method isEqualToString:@"POST"] ? [NSData data] : nil);
	NSMutableURLRequest *r = [self requestWithMethod:method path:p body:body];
	r.timeoutInterval = timeout > 0 ? timeout : 20;
	NSString *usedBase = _baseURL;
	// (1.1) sendAsynchronousRequest:queue:mainQueue; on iOS 5 a request with a body (every POST) would ignore a timeout under
	// 240 s: a watchdog keeps `timeout` there
	ENSendAsynchronousRequest(r, ^(NSURLResponse *resp, NSData *data, NSError *err) {
		NSHTTPURLResponse *h = (NSHTTPURLResponse *)resp;
		if (retry && !err && h.statusCode == 401 && [self adoptServerClockFrom:h]) {
			[self sendMethod:method path:p json:obj timeout:timeout retry:NO reroute:NO completion:done];
			return;
		}
		if (retry && err && ENIsNetworkError(err)) {
			if (!reroute) {
				[self probe:nil];          // maybe we left/arrived home: the next request takes the new route; this one isn't resent
				if (done) done(nil, 0, err);
				return;
			}
			// maybe we left/arrived home: re-probe, and retry once if the route changed
			[self probe:^(BOOL ok) {
				if (ok && ![usedBase isEqualToString:self->_baseURL]) [self sendMethod:method path:p json:obj timeout:timeout retry:NO reroute:NO completion:done];
				else if (done) done(nil, 0, err);
			}];
			return;
		}
		id j = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
		if (done) done(j, err ? 0 : h.statusCode, err);
	});
}

- (void)getData:(NSString *)pathAndQuery completion:(void (^)(NSData *data, NSInteger status))done {
	if ([self deferUntilRouted:^{ [self getData:pathAndQuery completion:done]; }]) return;
	NSMutableURLRequest *r = [self requestWithMethod:@"GET" path:pathAndQuery body:nil];
	[NSURLConnection sendAsynchronousRequest:r queue:[NSOperationQueue mainQueue] completionHandler:^(NSURLResponse *resp, NSData *data, NSError *err) {
		done(err ? nil : data, err ? 0 : [(NSHTTPURLResponse *)resp statusCode]);
	}];
}

// 0.5: catalog JSON and covers. The body is handed over raw (ENCatalog parses on its own queue); for an HTTP error it is
// the gateway's {"error":…} JSON, for a 304 or a network error nil.
- (void)fetchData:(NSString *)p etag:(NSString *)etag timeout:(NSTimeInterval)timeout
       completion:(void (^)(NSData *data, NSInteger status, NSString *etag, NSError *err))done {
	[self fetchData:p etag:etag timeout:timeout retry:YES completion:done];
}

- (void)fetchData:(NSString *)p etag:(NSString *)etag timeout:(NSTimeInterval)timeout retry:(BOOL)retry
       completion:(void (^)(NSData *data, NSInteger status, NSString *etag, NSError *err))done {
	if ([self deferUntilRouted:^{ [self fetchData:p etag:etag timeout:timeout retry:retry completion:done]; }]) return;
	NSMutableURLRequest *r = [self requestWithMethod:@"GET" path:p body:nil];
	r.timeoutInterval = timeout > 0 ? timeout : 20;
	if (etag.length) [r setValue:etag forHTTPHeaderField:@"If-None-Match"];
	NSString *usedBase = _baseURL;
	[NSURLConnection sendAsynchronousRequest:r queue:[NSOperationQueue mainQueue] completionHandler:^(NSURLResponse *resp, NSData *data, NSError *err) {
		NSHTTPURLResponse *h = [resp isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)resp : nil;
		if (retry && !err && h.statusCode == 401 && [self adoptServerClockFrom:h]) {
			[self fetchData:p etag:etag timeout:timeout retry:NO completion:done];
			return;
		}
		if (retry && err && ENIsNetworkError(err)) {
			// maybe we left/arrived home: re-probe, and retry once if the route changed
			[self probe:^(BOOL ok) {
				if (ok && ![usedBase isEqualToString:self->_baseURL]) [self fetchData:p etag:etag timeout:timeout retry:NO completion:done];
				else if (done) done(nil, 0, nil, err);
			}];
			return;
		}
		if (!done) return;
		if (err || !h) { done(nil, 0, nil, err ?: [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadServerResponse userInfo:nil]); return; }
		NSDictionary *hdr = [h allHeaderFields];
		NSString *tag = hdr[@"ETag"] ?: hdr[@"Etag"];
		if (!tag) for (NSString *k in hdr) if ([k caseInsensitiveCompare:@"etag"] == NSOrderedSame) { tag = hdr[k]; break; }
		done(h.statusCode == 304 ? nil : data, h.statusCode, [tag isKindOfClass:[NSString class]] ? tag : nil, nil);
	}];
}

@end

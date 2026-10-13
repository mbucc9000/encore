#import "ENJam.h"
#import "ENL.h"
#import "ENGateway.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENUtil.h"
#import "ENDiag.h"
#import "ENAnon.h"

// The phone's mirror of the gateway's Jam (DESIGN-4b §4.2–§4.5, §6.2). State only ever comes from the gateway: a GET's body,
// a `jam` event's data or a write's reply replaces everything at once. The ETag is kept only for a body that came from a
// GET, so a state taken from an event or a reply is never confirmed by a 304 for an older body.

NSString *const ENJamChangedNotification = @"ENJamChanged";
NSString *const ENJamEventKey = @"ev";
NSString *const ENJamOwnEventKey = @"own";
NSString *const ENJamGuestPlayNotification = @"ENJamGuestPlay";
NSString *const ENJamURIKey = @"uri";
NSString *const ENJamErrorRoleKey = @"ENJamErrorRole";

static const NSTimeInterval ENJamGetTimeout = 20;
static const NSTimeInterval ENJamWriteTimeout = 60;      // the gateway's 50 s action deadline, plus the way there and back
static const NSTimeInterval ENJamWatchEvery = 20;        // the lease lasts 25 s (§4.3)
static const NSTimeInterval ENJamOwnWindow = 90;         // an ev this soon after our own write of the same kind is its echo

static NSTimeInterval ENJamNow(void) { return [NSDate timeIntervalSinceReferenceDate]; }

static BOOL ENJamVersionAtLeast(NSString *v, NSInteger major, NSInteger minor, NSInteger patch) {
	if (!v.length) return NO;
	NSArray *p = [v componentsSeparatedByString:@"."];
	NSInteger want[3] = { major, minor, patch };
	for (NSUInteger i = 0; i < 3; i++) {
		NSInteger n = i < p.count ? [(NSString *)p[i] integerValue] : 0;     // "0-dev" -> 0
		if (n != want[i]) return n > want[i];
	}
	return YES;
}

// the regular expressions of the link forms (§5.7 Join step 1), built once
static NSRegularExpression *ENJamRegex(NSString *pattern) {
	return [NSRegularExpression regularExpressionWithPattern:pattern options:NSRegularExpressionCaseInsensitive error:NULL];
}

static NSString *ENJamMatch(NSRegularExpression *re, NSString *s, NSUInteger group) {
	NSTextCheckingResult *m = [re firstMatchInString:s options:0 range:NSMakeRange(0, s.length)];
	if (!m || [m rangeAtIndex:group].location == NSNotFound) return nil;
	return [s substringWithRange:[m rangeAtIndex:group]];
}

static NSRegularExpression *ENJamSessionURL(void) {     // open.spotify.com/(intl-xx/)socialsession/<t>, with or without https, ?si=
	static NSRegularExpression *re;
	if (!re) re = ENJamRegex(@"^(?:https?://)?open\\.spotify\\.com/(?:intl-[a-z_-]+/)?socialsession/([A-Za-z0-9_-]{1,128})/?(?:[?#].*)?$");
	return re;
}

static NSRegularExpression *ENJamSessionURI(void) {
	static NSRegularExpression *re;
	if (!re) re = ENJamRegex(@"^spotify:socialsession:([A-Za-z0-9_-]{1,128})$");
	return re;
}

static NSRegularExpression *ENJamShortLink(void) {      // spotify.link/<x>: only the gateway can expand it
	static NSRegularExpression *re;
	if (!re) re = ENJamRegex(@"^(?:https?://)?spotify\\.link/([A-Za-z0-9_-]{1,128})/?(?:[?#].*)?$");
	return re;
}

static NSRegularExpression *ENJamBareToken(void) {
	static NSRegularExpression *re;
	if (!re) re = ENJamRegex(@"^[A-Za-z0-9_-]{6,128}$");
	return re;
}

static NSString *ENJamTrim(NSString *s) {
	return [s isKindOfClass:[NSString class]] ? [s stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] : nil;
}

@implementation ENJam {
	BOOL _started, _watching, _fetching, _again, _againFresh, _ctl;
	NSDictionary *_body;                   // the JAM last applied, without ev (what change detection compares)
	NSString *_tag;                        // the ETag of _body when it came from a GET; nil otherwise
	NSDictionary *_caps;                   // x
	NSString *_hostID;
	NSDictionary *_snapshot;               // the last snapshot `jam` summary (noteSnapshot:)
	BOOL _snapshotSeen;
	NSTimer *_watchTimer;
	NSString *_ownK;                       // the write in flight or just answered (start / join / leave / end; nil after a
	NSTimeInterval _ownAt;                 // definite refusal) and when it was sent: its ev echo is marked own
	NSArray *_prevMembers;                 // (R2a) the members before the last change: an event's bare name (someone who just
	                                       // left or ended it) is matched against them too (-nameForEvent:)
}

@synthesize hostName = _hostName;          // (R2a) its getter is our own

+ (instancetype)shared {
	static ENJam *j;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ j = [[ENJam alloc] init]; });
	return j;
}

- (instancetype)init {
	if ((self = [super init])) {
		_members = @[];
		_caps = @{};
	}
	return self;
}

- (void)startObserving {
	if (_started) return;
	_started = YES;
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(versionKnown) name:ENCatalogVersionNotification object:nil];
	[nc addObserver:self selector:@selector(appActive) name:UIApplicationDidBecomeActiveNotification object:nil];
	[nc addObserver:self selector:@selector(appInactive) name:UIApplicationWillResignActiveNotification object:nil];
	[nc addObserver:self selector:@selector(appInactive) name:UIApplicationDidEnterBackgroundNotification object:nil];
	if (self.available) [self refresh:NO];
}

- (BOOL)available {
	return ENJamVersionAtLeast([ENCatalog shared].gatewayVersion, 0, 6, 0);
}

- (void)versionKnown {
	if (self.available) [self refresh:NO];
	else if (_active || _loaded) [self apply:@{} ev:nil own:NO tag:nil];     // a rollback to an older gateway: nothing is on
}

- (void)appActive {
	if (!_started || !self.available) return;
	[self refresh:NO];                     // events missed while suspended; a 304 when nothing changed
	if (_watching) [self startWatchTimer];
}

- (void)appInactive {
	[_watchTimer invalidate];
	_watchTimer = nil;
}

#pragma mark - reading the state

- (BOOL)canControl { return !_active || _ctl; }

- (BOOL)can:(NSString *)capability {
	return capability && ENJFlag(_caps[capability]);
}

- (ENJamMember *)memberWithID:(NSString *)memberID {
	if (!memberID) return nil;
	for (ENJamMember *m in _members) if ([m.memberID isEqualToString:memberID]) return m;
	return nil;
}

- (NSString *)meName {
	for (ENJamMember *m in _members) if (m.isMe) return m.name;
	return [ENCatalog shared].library.meName;
}

#pragma mark - (R2a) Anonymous Mode: the host's name as shown

// the host's made-up name (by member id, else keyed by the bridge's hn), "You" when it is this account
- (NSString *)anonHostName {
	if (_host.isMe) return ENL(@"You");
	NSString *hid = _hostID ?: _host.memberID;
	return hid ? [ENAnon nameForUser:hid] : [ENAnon nameForUser:nil fallbackName:_hostName];
}

- (NSString *)hostName {
	if (![ENAnon on]) return _hostName;
	return _hostName || _host ? [self anonHostName] : nil;
}

- (NSString *)nameForEvent:(NSDictionary *)ev {
	NSString *n = ENJStr(ev[@"n"]);
	if (![ENAnon on]) return n;
	NSString *mid = ENJStr(ev[@"id"]);                    // H2 (R2b): the member id beside the name
	if (mid) return [ENAnon nameForUser:mid];
	if (!n) return nil;
	for (NSArray *list in @[ _members ?: @[], _prevMembers ?: @[] ])
		for (ENJamMember *m in list)
			if ([m.rawName isEqualToString:n]) return m.isMe ? ENL(@"You") : [ENAnon nameForUser:m.memberID];
	if (_hostName && [n isEqualToString:_hostName]) return [self anonHostName];
	return nil;                                           // nobody to name: the HUD says it without a name
}

- (NSString *)title {
	if (_limited) return ENL(@"Jam on Encore");
	if ([ENAnon on]) {                     // (R2a) yours is "Your Jam"; someone else's carries their made-up name
		if (_hosting || _waiting) return ENL(@"Your Jam");
		NSString *hn = self.hostName;
		return hn.length ? [NSString stringWithFormat:ENL(@"%@’s Jam"), hn] : ENL(@"Jam on Encore");
	}
	NSString *hn = _hostName ?: _host.name;
	if (!hn && (_hosting || _waiting)) hn = [self meName];
	if (hn.length) return [NSString stringWithFormat:ENL(@"%@’s Jam"), hn];
	return _hosting || _waiting ? ENL(@"Your Jam") : ENL(@"Jam on Encore");
}

- (NSString *)hostLabel {                  // "Sam", for "In Sam’s Jam"
	if ([ENAnon on]) return self.hostName ?: ENL(@"a friend");
	return (_hostName ?: _host.name) ?: ENL(@"a friend");
}

- (NSString *)label {
	if (!self.available) return nil;
	if (!_active) return ENL(@"Off");
	if (_away) return ENL(@"Playing elsewhere");
	if (_limited || _waiting) return ENL(@"On");
	if (_hosting) return [NSString stringWithFormat:ENL(@"Hosting · %lu"), (unsigned long)_count];
	if (_guest) return [NSString stringWithFormat:ENL(@"In %@’s Jam"), [self hostLabel]];
	return ENL(@"On");
}

- (NSString *)listeningText {
	return [NSString stringWithFormat:ENL(@"%lu listening"), (unsigned long)_count];
}

- (NSArray *)barNames {                    // join order, me = "You"
	NSMutableArray *names = [NSMutableArray arrayWithCapacity:_members.count];
	for (ENJamMember *m in _members) [names addObject:m.displayName ?: @"?"];
	if (!names.count) [names addObject:ENL(@"You")];
	return names;
}

- (NSString *)barText {
	if (!_active) return nil;
	if (_away) return ENL(@"Your Jam is playing on another device");
	if (_waiting) return ENL(@"Jam · waiting for Spotify");
	if (_limited) return ENL(@"Jam on Encore");
	if (_hosting) return [NSString stringWithFormat:ENL(@"Jam · %@"), [[self barNames] componentsJoinedByString:@", "]];
	if (_guest) return [NSString stringWithFormat:ENL(@"In %@’s Jam · %@"), [self hostLabel], [self listeningText]];
	return ENL(@"Jam on Encore");
}

- (NSString *)barTextFittingWidth:(CGFloat)width font:(UIFont *)font {
	NSString *full = [self barText];
	if (!_hosting || _away || _waiting || _limited || !font || [full sizeWithFont:font].width <= width) return full;
	NSArray *names = [self barNames];
	NSString *best = nil;
	for (NSUInteger k = 1; k <= names.count; k++) {
		NSString *t = [NSString stringWithFormat:ENL(@"Jam · %@"), [[names subarrayWithRange:NSMakeRange(0, k)] componentsJoinedByString:@", "]];
		if (k < names.count) t = [t stringByAppendingFormat:@" +%lu", (unsigned long)(names.count - k)];
		if (best && [t sizeWithFont:font].width > width) break;
		best = t;
	}
	return best ?: full;                   // the bar truncates whatever is still too long
}

- (NSString *)pillText {
	if (!_active) return nil;
	if (_limited || _away || _waiting) return ENL(@"Jam");
	if (_hosting) return [NSString stringWithFormat:ENL(@"Jam · %@"), [self listeningText]];
	if (_guest) return [NSString stringWithFormat:ENL(@"%@’s Jam · %@"), [self hostLabel], [self listeningText]];
	return ENL(@"Jam");
}

#pragma mark - applying a JAM object

// j = the JAM without ev; tag = its ETag when it came from a GET. Posts ENJamChangedNotification when the body changed or
// something happened (ev).
- (void)apply:(NSDictionary *)j ev:(NSDictionary *)ev own:(BOOL)own tag:(NSString *)tag {
	j = ENJDict(j) ?: @{};
	_tag = [tag copy];
	BOOL changed = ![j isEqual:_body] || !_loaded;
	_loaded = YES;
	if (changed) {
		BOOL was = _active;
		NSString *wasRole = _hosting ? @"host" : _guest ? @"guest" : _limited ? @"lim" : @"";
		_body = [j copy];
		_active = ENJFlag(j[@"on"]);
		NSString *r = ENJStr(j[@"r"]);
		_hosting = _active && [r isEqualToString:@"host"];
		_guest = _active && [r isEqualToString:@"guest"];
		_limited = _active && ENJFlag(j[@"lim"]);
		_waiting = _active && ENJFlag(j[@"wait"]);
		_away = _active && ENJFlag(j[@"away"]);
		_fake = ENJFlag(j[@"fake"]);
		_ctl = ENJFlag(j[@"ctl"]);
		_guestsCanControl = ENJFlag(j[@"gc"]);
		_token = [ENJStr(j[@"t"]) copy];
		_link = [ENJStr(j[@"l"]) copy];
		_codeImageToken = [ENJStr(j[@"ci"]) copy];
		_hostID = [ENJStr(j[@"h"]) copy];
		_hostName = [ENJStr(j[@"hn"]) copy];
		_caps = ENJDict(j[@"x"]) ?: @{};
		NSMutableArray *ms = [NSMutableArray array];
		ENJamMember *host = nil;
		for (id x in ENJArr(j[@"m"])) {
			ENJamMember *m = [ENJamMember memberWithJSON:x];
			if (!m) continue;
			[ms addObject:m];
			if (m.isHost || (!host && _hostID && [m.memberID isEqualToString:_hostID])) host = m;
		}
		_prevMembers = _members;
		_members = [ms copy];
		_host = host;
		NSInteger cnt = ENJInt(j[@"cnt"], (NSInteger)ms.count);
		_count = (NSUInteger)MAX(cnt, (NSInteger)0);
		NSString *role = _hosting ? @"host" : _guest ? @"guest" : _limited ? @"lim" : @"";
		if (was != _active || ![role isEqualToString:wasRole])        // roles and counts only: no ids, names or tokens
			ENLog(@"jam: %@%@%@", _active ? @"on" : @"off", role.length ? [@" as " stringByAppendingString:role] : @"",
				_active ? [NSString stringWithFormat:@" (%lu listening%@%@)", (unsigned long)_count, _fake ? @", fake" : @"",
					_waiting ? @", wait" : _away ? @", away" : @""] : @"");
	}
	if (!changed && !ev) return;
	NSMutableDictionary *ui = [NSMutableDictionary dictionary];
	if (ev) ui[ENJamEventKey] = ev;
	if (ev && own) ui[ENJamOwnEventKey] = @YES;
	[[NSNotificationCenter defaultCenter] postNotificationName:ENJamChangedNotification object:self userInfo:ui];
}

// an ev of the same kind as our own write (sent within the window) is its echo: our action shows its own HUD. A leave the
// gateway made on its own (`why`) and an end someone else made (`n`) are never ours.
- (BOOL)isOwnEvent:(NSDictionary *)ev {
	NSString *k = ENJStr(ev[@"k"]);
	if (!k || !_ownK || ![k isEqualToString:_ownK] || ENJamNow() - _ownAt > ENJamOwnWindow) return NO;
	if ([k isEqualToString:@"leave"] && ENJStr(ev[@"why"])) return NO;
	if ([k isEqualToString:@"end"] && ENJStr(ev[@"n"])) return NO;
	return YES;
}

- (void)handleEvent:(NSDictionary *)e {
	NSDictionary *d = ENJDict(ENJDict(e)[@"data"]);
	if (!d) return;
	NSMutableDictionary *j = [d mutableCopy];
	NSDictionary *ev = ENJDict(j[@"ev"]);
	[j removeObjectForKey:@"ev"];
	BOOL own = ev && [self isOwnEvent:ev];
	if (ev) ENLog(@"jam event %@%@%@", ENJStr(ev[@"k"]) ?: @"?", ENJStr(ev[@"why"]) ? [@" " stringByAppendingString:ev[@"why"]] : @"",
		own ? @" (ours)" : @"");
	[self apply:j ev:ev own:own tag:nil];
}

- (void)noteSnapshot:(NSDictionary *)jamSummary {
	NSDictionary *s = ENJDict(jamSummary);
	if (_snapshotSeen && (s == _snapshot || [s isEqual:_snapshot])) return;
	BOOL first = !_snapshotSeen;
	_snapshotSeen = YES;
	_snapshot = [s copy];
	if (!self.available) return;
	if (first && !s && !_active) return;   // nothing on, as we already think
	[self refresh:NO];
}

#pragma mark - reads

- (void)refresh:(BOOL)fresh {
	if (!self.available || ![ENGateway shared].paired) return;
	if (_fetching) {
		_again = YES;
		_againFresh = _againFresh || fresh;
		return;
	}
	_fetching = YES;
	NSMutableArray *q = [NSMutableArray arrayWithCapacity:2];
	if (_watching) [q addObject:@"w=1"];
	if (fresh) [q addObject:@"fresh=1"];
	NSString *path = q.count ? [@"/v1/jam?" stringByAppendingString:[q componentsJoinedByString:@"&"]] : @"/v1/jam";
	NSString *sentTag = _tag;
	[[ENGateway shared] fetchData:path etag:sentTag timeout:ENJamGetTimeout completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		self->_fetching = NO;
		if (st == 200 && data.length) {
			id j = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];     // < 8 KB: on the main thread
			if (ENJDict(j)) [self apply:j ev:nil own:NO tag:etag];
		} else if (st != 304) {
			ENLog(@"jam: GET failed (%ld)", (long)st);
		}
		if (self->_again) {
			BOOL f = self->_againFresh;
			self->_again = self->_againFresh = NO;
			[self refresh:f];
		}
	}];
}

- (void)watch:(BOOL)on {
	if (on == _watching) {
		if (on) [self refresh:NO];
		return;
	}
	_watching = on;
	if (!on) {
		[_watchTimer invalidate];
		_watchTimer = nil;
		return;
	}
	[self refresh:NO];
	if ([UIApplication sharedApplication].applicationState == UIApplicationStateActive) [self startWatchTimer];
}

- (void)startWatchTimer {
	[_watchTimer invalidate];
	_watchTimer = [NSTimer timerWithTimeInterval:ENJamWatchEvery target:self selector:@selector(watchTick) userInfo:nil repeats:YES];
	[[NSRunLoop mainRunLoop] addTimer:_watchTimer forMode:NSRunLoopCommonModes];
}

- (void)watchTick {
	if (_watching) [self refresh:NO];
}

#pragma mark - writes

- (NSError *)errorWithJSON:(id)j status:(NSInteger)st error:(NSError *)err {
	NSError *e = [ENCatalog errorWithJSON:j status:st error:err];
	NSString *r = ENJStr(ENJDict(ENJDict(j)[@"error"])[@"r"]);
	if (!r) return e;
	NSMutableDictionary *ui = [e.userInfo mutableCopy];
	ui[ENJamErrorRoleKey] = r;
	return [NSError errorWithDomain:e.domain code:e.code userInfo:ui];
}

// One write at a time from this phone (the gateway serializes them too), sent once: after a network error (a timeout too)
// it is never resent, even on a new route, since it may have been done; the next read or event settles it. k: the ev our
// success stands for (its echo is marked own); ev: what the success posts.
- (void)write:(NSString *)action body:(NSDictionary *)body own:(NSString *)k
         done:(void (^)(NSDictionary *reply, NSError *e))done {
	if (_busy) {
		NSDictionary *j = @{ @"error": @{ @"code": @"busy", @"message": ENL(@"Wait for the last Jam action to finish.") } };
		dispatch_async(dispatch_get_main_queue(), ^{ done(nil, [ENCatalog errorWithJSON:j status:409 error:nil]); });
		return;
	}
	_busy = YES;
	if (k) { _ownK = k; _ownAt = ENJamNow(); }
	NSTimeInterval t0 = ENJamNow();
	[[ENGateway shared] sendOnceMethod:@"POST" path:[@"/v1/jam/" stringByAppendingString:action] json:body ?: @{}
	                           timeout:ENJamWriteTimeout completion:^(id j, NSInteger st, NSError *err) {
		self->_busy = NO;
		if (st == 200 && ENJDict(j)) {
			ENLog(@"jam %@: ok in %.0f ms", action, (ENJamNow() - t0) * 1000);
			done(j, nil);
			return;
		}
		NSError *e = [self errorWithJSON:j status:st error:err];
		ENLog(@"jam %@ failed: %ld %@", action, (long)st, [ENCatalog codeOfError:e] ?: @"");
		// a definite refusal (4xx, or 503: nothing was done) has no echo coming, so a later ev of its kind is someone else's.
		// After a timeout or a 502 the outcome is unknown: its echo may still come and stays marked own.
		if (k && ((st >= 400 && st < 500) || st == 503)) self->_ownK = nil;
		done(nil, e);
	}];
}

// the reply's jam replaces the state; ev (our own success) goes with it, marked own
- (void)takeReply:(NSDictionary *)reply ev:(NSDictionary *)ev {
	NSDictionary *jam = ENJDict(reply[@"jam"]);
	if (jam) [self apply:jam ev:ev own:YES tag:nil];
	else if (ev) [self apply:_body ev:ev own:YES tag:_tag];
}

- (void)start:(void (^)(NSError *e))done {
	void (^d)(NSError *) = [done copy];
	[self write:@"start" body:@{} own:@"start" done:^(NSDictionary *reply, NSError *e) {
		if (reply) [self takeReply:reply ev:@{ @"k": @"start" }];
		if (d) d(e);
	}];
}

- (void)joinLink:(NSString *)link replace:(BOOL)replace done:(void (^)(NSError *e))done {
	void (^d)(NSError *) = [done copy];
	NSString *s = [ENJam normalizedJamLink:link] ?: ENJamTrim(link) ?: @"";
	NSMutableDictionary *body = [NSMutableDictionary dictionaryWithObject:s forKey:@"link"];     // never logged
	if (replace) body[@"replace"] = @YES;
	[self write:@"join" body:body own:@"join" done:^(NSDictionary *reply, NSError *e) {
		if (reply) {
			NSMutableDictionary *ev = [NSMutableDictionary dictionaryWithObject:@"join" forKey:@"k"];
			NSString *hn = ENJStr(ENJDict(reply[@"jam"])[@"hn"]);
			if (hn) ev[@"n"] = hn;
			[self takeReply:reply ev:ev];
			NSInteger gen = ENJInt(reply[@"gen"], 0);
			if (gen > 0) [[ENPlayback shared] openReplyGeneration:gen state:ENJDict(reply[@"state"])];
		}
		if (d) d(e);
	}];
}

- (void)leave:(void (^)(NSError *e))done {
	void (^d)(NSError *) = [done copy];
	[self write:@"leave" body:@{} own:@"leave" done:^(NSDictionary *reply, NSError *e) {
		if (reply) [self takeReply:reply ev:@{ @"k": @"leave" }];
		if (d) d(e);
	}];
}

- (void)end:(void (^)(NSError *e))done {
	void (^d)(NSError *) = [done copy];
	[self write:@"end" body:@{} own:@"end" done:^(NSDictionary *reply, NSError *e) {
		if (reply) {
			[self takeReply:reply ev:@{ @"k": @"end" }];
			NSInteger gen = ENJInt(reply[@"gen"], 0);
			NSDictionary *state = ENJDict(reply[@"state"]);
			if (gen > 0 || state) [[ENPlayback shared] openReplyGeneration:gen state:state];
		}
		if (d) d(e);
	}];
}

- (void)setGuestsCanControl:(BOOL)on done:(void (^)(NSError *e))done {
	void (^d)(NSError *) = [done copy];
	[self write:@"settings" body:@{ @"gc": on ? @YES : @NO } own:nil done:^(NSDictionary *reply, NSError *e) {
		if (reply) [self takeReply:reply ev:nil];
		if (d) d(e);
	}];
}

- (void)removeMember:(ENJamMember *)m done:(void (^)(NSError *e))done {
	void (^d)(NSError *) = [done copy];
	if (!m.memberID) {
		dispatch_async(dispatch_get_main_queue(), ^{ if (d) d([ENCatalog errorWithJSON:nil status:400 error:nil]); });
		return;
	}
	[self write:@"remove" body:@{ @"id": m.memberID } own:nil done:^(NSDictionary *reply, NSError *e) {
		if (reply) [self takeReply:reply ev:nil];
		if (d) d(e);
	}];
}

#pragma mark - links and the clipboard

+ (NSString *)tokenFromLink:(NSString *)s {
	s = ENJamTrim(s);
	if (!s.length) return nil;
	NSString *t = ENJamMatch(ENJamSessionURL(), s, 1) ?: ENJamMatch(ENJamSessionURI(), s, 1);
	if (t) return t;
	if (ENJamMatch(ENJamShortLink(), s, 1)) return @"";
	return ENJamMatch(ENJamBareToken(), s, 0);
}

+ (BOOL)isJamLink:(NSString *)s {
	return [self normalizedJamLink:s] != nil;
}

+ (NSString *)normalizedJamLink:(NSString *)s {
	s = ENJamTrim(s);
	if (!s.length) return nil;
	NSString *t = ENJamMatch(ENJamSessionURL(), s, 1) ?: ENJamMatch(ENJamSessionURI(), s, 1);
	if (t) return [@"https://open.spotify.com/socialsession/" stringByAppendingString:t];
	NSString *x = ENJamMatch(ENJamShortLink(), s, 1);
	return x ? [@"https://spotify.link/" stringByAppendingString:x] : nil;
}

// what the clipboard bookkeeping compares: a hash of the token, or of the spotify.link URL (no token before the gateway
// expands it). Never the link itself.
+ (NSString *)keyOfLink:(NSString *)s {
	NSString *t = [self tokenFromLink:s];
	if (t.length) return ENSHA1Hex(t);
	NSString *n = [self normalizedJamLink:s];
	return n ? ENSHA1Hex(n) : nil;
}

// The keys that stand for the Jam this phone is in: its token's and its link's. 4b-c: `l` is the session's own
// join_session_url (§4.7), which may be a spotify.link URL (keyed by the URL: only the gateway can expand it) or carry
// another token than `t`, so the token's key alone wouldn't recognise it.
- (NSArray *)currentLinkKeys {
	if (!_active) return @[];
	NSMutableArray *keys = [NSMutableArray arrayWithCapacity:2];
	NSString *a = _token ? [ENJam keyOfLink:_token] : nil, *b = _link ? [ENJam keyOfLink:_link] : nil;
	if (a) [keys addObject:a];
	if (b && ![b isEqualToString:a]) [keys addObject:b];
	return keys;
}

- (BOOL)isCurrentJamLink:(NSString *)s {
	NSString *key = [ENJam keyOfLink:s];
	return key && [[self currentLinkKeys] containsObject:key];
}

- (NSString *)clipboardJamLink {
	UIPasteboard *pb = [UIPasteboard generalPasteboard];
	NSInteger count = pb.changeCount;
	NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
	NSMutableDictionary *st = [NSMutableDictionary dictionaryWithDictionary:[ud dictionaryForKey:@"jamClipboard"] ?: @{}];
	id seen = st[@"count"];
	if ([seen isKindOfClass:[NSNumber class]] && [(NSNumber *)seen integerValue] == count) return nil;     // nothing new
	st[@"count"] = @(count);
	NSString *s = pb.string;
	if (![ENJam isJamLink:s]) {
		NSString *u = pb.URL.absoluteString;    // a link copied from Messages can be a URL item only
		s = [ENJam isJamLink:u] ? u : nil;
	}
	NSString *key = s ? [ENJam keyOfLink:s] : nil;
	BOOL offer = key && ![[self currentLinkKeys] containsObject:key] && ![key isEqualToString:ENJStr(st[@"copied"])]
		&& ![key isEqualToString:ENJStr(st[@"offered"])];
	if (offer) st[@"offered"] = key;
	[ud setObject:st forKey:@"jamClipboard"];
	return offer ? [ENJamTrim(s) copy] : nil;
}

// the key of what Copy Link put on the pasteboard: the link (`l`), else the token
- (void)noteCopiedLink {
	NSString *key = _link ? [ENJam keyOfLink:_link] : nil;
	if (!key && _token) key = [ENJam keyOfLink:_token];
	if (!key) return;
	NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
	NSMutableDictionary *st = [NSMutableDictionary dictionaryWithDictionary:[ud dictionaryForKey:@"jamClipboard"] ?: @{}];
	st[@"copied"] = key;
	st[@"count"] = @([UIPasteboard generalPasteboard].changeCount);
	[ud setObject:st forKey:@"jamClipboard"];
}

@end

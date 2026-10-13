#import "ENCatalog.h"
#import "ENL.h"
#import "ENGateway.h"
#import "ENPlayback.h"
#import "ENImageCache.h"
#import "ENDiag.h"
#import "ENUtil.h"
#import "ENAnon.h"
#import <UIKit/UIKit.h>

// The catalog (DESIGN-3 §5.3, §6; ARCH-0.5.md §4). Everything public runs on the main thread. Per route (one gateway URL =
// one cache file) there is a memory copy, the ETag of the last body delivered, and at most one request in flight that
// later calls join. JSON is parsed on _parseQueue; the raw bodies are written to <Caches>/<bundle id>/json on
// _ioQueue. Every `done` is called through dispatch_async(main), so a call's cached copy always arrives before its network
// answer, and never inside the call itself.

NSString *const ENCatalogErrorDomain = @"ENCatalogErrorDomain";
NSString *const ENCatalogErrorCodeKey = @"ENCatalogErrorCode";
NSString *const ENCatalogRetryAfterKey = @"ENCatalogRetryAfter";
NSString *const ENCatalogErrorURIsKey = @"ENCatalogErrorURIs";
NSString *const ENCatalogChangedNotification = @"ENCatalogChanged";
NSString *const ENCatalogKindKey = @"kind";
NSString *const ENCatalogURIKey = @"uri";
NSString *const ENCatalogURIsKey = @"uris";
NSString *const ENCatalogKindLibrary = @"library";
NSString *const ENCatalogKindList = @"list";
NSString *const ENCatalogKindLiked = @"liked";
NSString *const ENCatalogKindReset = @"reset";
NSString *const ENCatalogKindAlbums = @"albums";
NSString *const ENCatalogKindUser = @"user";              // (0.11 profiles)
NSString *const ENLikedListURI = @"encore:liked";
NSString *const ENCatalogVersionNotification = @"ENCatalogVersion";

static const NSTimeInterval ENGetTimeout = 20;
static const NSTimeInterval ENSearchTimeout = 15;
static const NSTimeInterval ENContainsTimeout = 10;
static const NSTimeInterval ENWriteTimeout = 45;         // the gateway may take ~35 s for an add (§3.4)
static const NSTimeInterval ENDayAge = 86400;            // albums and artists: revalidated once a day
static const NSUInteger ENSearchMax = 30;
static const NSTimeInterval ENSearchTTL = 600;
static const NSTimeInterval ENWriteEcho = 3;             // a snapshot `liked` this soon after our own write may predate it
static const NSTimeInterval ENAddedTTL = 600;            // (0.9.4) dates added of a playlist without a revision (Spotify's own)
static const NSTimeInterval ENAddedTimeout = 45;         // (0.9.4) the gateway reads up to 50 Web API pages one after another
static const NSTimeInterval ENPlaylistSaveHold = 30;     // (0.11) a confirmed save of someone's playlist outranks the library this long
// D8: one message for every "the bridge is too old for this" case (the app and the bridge share one version number)
NSString *const ENUpdateBridgeText = @"Update your Encore Bridge.";
NSString *const ENUpdateBridgeShortText = @"Update your Encore Bridge";
// (the constants stay the English keys for the other files; shown here through ENL:)
#define ENUpdateBridgeL ENL(@"Update your Encore Bridge.")

#define ENNotProfileText ENL(@"That isn't a Spotify profile.")

#define ENUnpairText ENL(@"Your Encore Bridge doesn't know this phone any more. Unpair and pair again.")
#define ENNoGatewayText ENL(@"Can't reach your Encore Bridge.")
#define ENUnreadableText ENL(@"Your Encore Bridge sent an answer Encore can't read.")

static BOOL ENSameTag(NSString *a, NSString *b) { return a && b && [a isEqualToString:b]; }

static BOOL ENValidID(NSString *s) {        // a 22-character base62 Spotify id (the gateway's routes accept nothing else)
	if (s.length != 22) return NO;
	for (NSUInteger i = 0; i < 22; i++) {
		unichar c = [s characterAtIndex:i];
		if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return NO;
	}
	return YES;
}

static BOOL ENIsAlbumURI(NSString *uri) {   // (0.9) spotify:album:<valid id>: what the Your Library album routes take
	return [ENJStr(uri) hasPrefix:@"spotify:album:"] && ENValidID(ENIDFromURI(uri));
}

static BOOL ENVersionBelow(NSString *v, NSInteger major, NSInteger minor, NSInteger patch) {
	NSArray *p = [v componentsSeparatedByString:@"."];
	NSInteger want[3] = { major, minor, patch };
	for (NSUInteger i = 0; i < 3; i++) {
		NSInteger n = i < p.count ? [(NSString *)p[i] integerValue] : 0;     // "0-dev" -> 0
		if (n != want[i]) return n < want[i];
	}
	return NO;
}

static id ENParseJSON(NSData *d) {
	return d.length ? [NSJSONSerialization JSONObjectWithData:d options:0 error:NULL] : nil;
}

typedef enum { ENRouteLibrary = 0, ENRouteList, ENRouteArtist, ENRouteHome, ENRouteProfile, ENRouteAlbums, ENRouteArtists,
	ENRouteRecent, ENRouteUser, ENRouteUserPlaylists, ENRoutePeople } ENRouteType;     // (0.11: the last three, memory only)

static BOOL ENIsPeopleRoute(ENRouteType t) { return t == ENRouteUser || t == ENRouteUserPlaylists || t == ENRoutePeople; }

// (0.11) a user id as part of a route name: every character outside [A-Za-z0-9._-] -> '_', and when any was replaced 8 hex of
// the id's SHA-1 after it, so two ids never share a route (route names are never logged; these routes are never files)
static NSString *ENSafeUserID(NSString *uid) {
	NSMutableString *out = [NSMutableString stringWithCapacity:uid.length + 9];
	BOOL replaced = NO;
	for (NSUInteger i = 0; i < uid.length; i++) {
		unichar c = [uid characterAtIndex:i];
		BOOL ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '.' || c == '_' || c == '-';
		if (!ok) replaced = YES;
		unichar put = ok ? c : (unichar)'_';
		[out appendFormat:@"%C", put];
	}
	if (replaced) [out appendFormat:@"_%@", [ENSHA1Hex(uid) substringToIndex:8]];
	return out;
}

// (0.11) one canonical spotify:user: uri per person (the state maps' keys), nil for anything else
static NSString *ENUserKey(NSString *uri) { return ENUserURIFromID(ENUserIDFromURI(uri)); }

// ---------------------------------------------------------------- private helpers

// One load / poll call.
@interface ENCatalogWaiter : NSObject
@property (nonatomic, copy) ENCatalogBlock done;
@property (nonatomic, copy) NSString *etag;          // ETag of the last body delivered to this call (nil: none)
@property (nonatomic) BOOL fresh;                    // wants ?fresh=1 (pull to refresh)
@property (nonatomic) BOOL poll;                     // pollList: no cached copy, nothing on a 304
@end
@implementation ENCatalogWaiter
@end

// One gateway route = one cache file.
@interface ENCatalogRoute : NSObject
@property (nonatomic, copy) NSString *name;          // file name: playlists | pl_<id> | liked | album_<id> | artist_<id>
@property (nonatomic, copy) NSString *path;          // /v1/... (no query)
@property (nonatomic, copy) NSString *uri;           // for kind list notifications (ENLikedListURI for Liked)
@property (nonatomic) ENRouteType type;
@property (nonatomic) NSTimeInterval maxAge;         // > 0: a copy checked less than this ago isn't revalidated
@property (nonatomic) BOOL freshQuery;               // the route takes ?fresh=1 (0.11: &fresh=1 after a path with a query)
@property (nonatomic) BOOL memoryOnly;               // (0.11) people routes: never read from or written to disk
@property (nonatomic, strong) id model;              // memory copy (library / Liked: with the local patches)
@property (nonatomic, copy) NSString *etag;          // ETag of the last body delivered for the route
@property (nonatomic, copy) NSString *diskEtag;      // ETag of the file on disk
@property (nonatomic, strong) NSDate *checkedAt;     // last 200 / 304 (from disk: the .etag file's mtime)
@property (nonatomic) BOOL diskTried;                // the file was read since the memory copy went (or there is none)
@property (nonatomic) BOOL readingDisk;
@property (nonatomic, strong) NSMutableArray *diskWaiters;
@property (nonatomic, strong) NSMutableArray *waiters;   // calls on the request in flight (late joiners included)
@property (nonatomic) BOOL inFlight;
@property (nonatomic, strong) NSDate *sentAt;        // when the last request went out (Liked: writes answered later may be
                                                     // missing from its body)
@end
@implementation ENCatalogRoute
- (instancetype)init {
	if ((self = [super init])) {
		_waiters = [NSMutableArray array];
		_diskWaiters = [NSMutableArray array];
	}
	return self;
}
@end

@interface ENSearchEntry : NSObject
@property (nonatomic, strong) id result;             // ENSearchResult (0.11: an ENRowList of people in the people search cache)
@property (nonatomic, strong) NSDate *at;
@end
@implementation ENSearchEntry
@end

// One setSaved:tracks:done: call: done once every uri it named has settled.
@interface ENSaveCall : NSObject
@property (nonatomic, copy) void (^done)(NSError *error);
@property (nonatomic) NSInteger pending;
@property (nonatomic, strong) NSError *error;
- (void)settle:(NSError *)error;
@end
@implementation ENSaveCall
- (void)settle:(NSError *)error {
	if (error && !_error) _error = error;
	if (--_pending > 0) return;
	void (^d)(NSError *) = _done;
	_done = nil;
	if (d) d(_error);
}
@end

// The like / unlike state of one uri while requests for it run (serialized per uri, §6.4).
@interface ENSaveOp : NSObject
@property (nonatomic, copy) NSString *uri;
@property (nonatomic, strong) ENTrack *track;        // the newest row passed for it (its rowJSON goes with a save)
@property (nonatomic, strong) NSNumber *before;      // its state when the first call came (nil = unknown)
@property (nonatomic) BOOL wanted;                   // what the latest call asked for = what the hearts show
@property (nonatomic) BOOL server;                   // what the server has: `before` (unknown: the opposite of the first
                                                     // call), then each 200
@property (nonatomic) BOOL serverKnown;              // server came from a 200
@property (nonatomic) BOOL inFlight;
@property (nonatomic) BOOL sent;                     // what the request in flight asks for
@property (nonatomic, strong) ENTrack *removedRow;   // the Liked row an unlike took out, and its index (for a revert)
@property (nonatomic) NSUInteger removedIndex;
@property (nonatomic) NSInteger countSeq;            // _librarySeq when it last changed the liked count
@property (nonatomic, strong) NSMutableArray *calls;
@end
@implementation ENSaveOp
@end

// (0.9) An album's add to / removal from Your Library while requests for it run (serialized per album, like ENSaveOp).
@interface ENAlbumOp : NSObject
@property (nonatomic, copy) NSString *uri;
@property (nonatomic, strong) NSNumber *before;      // its state when the first call came (nil = unknown)
@property (nonatomic) BOOL wanted;                   // what the latest call asked for = what the heart shows
@property (nonatomic) BOOL server;                   // what the server has: `before` (unknown: the opposite of the first
                                                     // call), then each 200
@property (nonatomic) BOOL serverKnown;              // server came from a 200 (so the saved albums list may have changed)
@property (nonatomic) BOOL inFlight;
@property (nonatomic) BOOL sent;                     // what the request in flight asks for
@property (nonatomic, strong) NSMutableArray *calls; // the done blocks of the calls waiting for it
@end
@implementation ENAlbumOp
@end

// (0.11) A follow / unfollow of a person, or a save of someone else's playlist, while requests for it run: the album op's
// fields and rules (serialized per uri, the newest wanted state sent when one returns).
@interface ENFollowOp : ENAlbumOp
@end
@implementation ENFollowOp
@end

// (0.9.4) A playlist's dates added (memory only), keyed by the playlist id.
@interface ENAddedEntry : NSObject
@property (nonatomic, copy) NSArray *entries;        // @[uri, NSNumber ms] each, the playlist's order
@property (nonatomic, copy) NSString *v;             // the gateway's library revision for it (nil: none, Spotify's own)
@property (nonatomic, copy) NSString *listRev;       // the revision of the catalog's copy of the list when they were asked for
@property (nonatomic, copy) NSString *etag;
@property (nonatomic, strong) NSDate *at;            // the last 200 / 304
@property (nonatomic) BOOL dropped;                  // a kind list since: asked again (If-None-Match) before any use
@property (nonatomic) BOOL stale;                    // the gateway's saved copy (stale: 1, Spotify failed): never current
@end
@implementation ENAddedEntry
@end

// (0.9.4) The request in flight for one playlist's dates added.
@interface ENAddedFlight : NSObject
@property (nonatomic, strong) NSMutableArray *waiters;   // done blocks
@property (nonatomic) BOOL superseded;               // the list changed while it ran: later calls don't join, its answer is
                                                     // kept as dropped
@end
@implementation ENAddedFlight
@end

// ---------------------------------------------------------------- ENCatalog

@implementation ENCatalog {
	dispatch_queue_t _parseQueue;          // JSON -> models (serial)
	dispatch_queue_t _ioQueue;             // cache file writes (serial, background priority)
	NSMutableDictionary *_routes;          // name -> ENCatalogRoute
	NSInteger _requests;                   // JSON requests in flight (-loading)
	NSMutableDictionary *_saved;           // uri -> @YES / @NO
	NSMutableDictionary *_saveOps;         // uri -> ENSaveOp
	NSMutableDictionary *_wroteAt;         // uri -> NSDate its last write was answered
	NSMutableDictionary *_wroteRows;       // uri -> ENTrack of its last like the server confirmed (removed by an unlike)
	NSInteger _librarySeq;                // bumped whenever the server's liked count replaces ours
	NSMutableDictionary *_searches;        // key -> ENSearchEntry
	NSMutableArray *_searchOrder;          // keys, least recently used first
	NSMutableDictionary *_searchWaiters;   // key -> NSMutableArray of ENCatalogBlock (request in flight)
	BOOL _started, _versionAsking;
	BOOL _versionStale;                    // a reset came since the last answer: the gateway may run another version now
	BOOL _libraryStale, _resetPending;     // events that came while the app was in the background
	NSMutableSet *_staleLists;
	NSString *_heardURI;                   // the song being heard (ENPlaybackChangedNotification)
	NSString *_heardChecked;               // the last one checkSaved: was asked about
	BOOL _personalTooOld;                  // (0.7) the gateway is older than 0.7.0: Home / Library lists / profile 404
	NSMutableDictionary *_albumSaved;      // (0.9) album uri -> @YES / @NO (Your Library)
	NSMutableDictionary *_albumOps;        // album uri -> ENAlbumOp (a save / removal in flight)
	NSMutableDictionary *_albumChecks;     // album uri -> NSMutableArray of done blocks (its contains check in flight)
	NSMutableDictionary *_albumWroteAt;    // album uri -> NSDate its last save / removal was answered
	NSDate *_albumsWroteAt;                // the last one of those (an `albums` event this soon after is its echo)
	BOOL _albumsStale;                     // an `albums` event came while the app was in the background
	NSMutableDictionary *_addedDates;      // (0.9.4) playlist id -> ENAddedEntry
	NSMutableDictionary *_addedFlights;    // playlist id -> ENAddedFlight
	BOOL _profilesOld;                     // (0.11) /v1/status said a gateway before 0.10.0
	BOOL _profilesMissing;                 // a profile route answered 404 not_found (until the next version answer)
	NSMutableDictionary *_userSearches;    // people search: key -> ENSearchEntry (an ENRowList)
	NSMutableArray *_userSearchOrder;      // keys, least recently used first
	NSMutableDictionary *_userSearchWaiters;   // key -> NSMutableArray of ENCatalogBlock
	NSMutableDictionary *_userFollow;      // canonical spotify:user: uri -> @YES / @NO (pending or confirmed)
	NSMutableDictionary *_followOps;       // canonical uri -> ENFollowOp
	NSMutableDictionary *_plSaved;         // playlist uri -> @YES / @NO, confirmed by a save of ours
	NSMutableDictionary *_plSavedAt;       // playlist uri -> NSDate of that confirmation
	NSMutableDictionary *_plSaveOps;       // playlist uri -> ENFollowOp
}

+ (instancetype)shared {
	static ENCatalog *c;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ c = [[ENCatalog alloc] init]; });
	return c;
}

- (instancetype)init {
	if ((self = [super init])) {
		_parseQueue = dispatch_queue_create("com.mbucc9000.encore.catalog.parse", DISPATCH_QUEUE_SERIAL);
		_ioQueue = dispatch_queue_create("com.mbucc9000.encore.catalog.io", DISPATCH_QUEUE_SERIAL);
		dispatch_set_target_queue(_ioQueue, dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_BACKGROUND, 0));
		_routes = [NSMutableDictionary dictionary];
		_saved = [NSMutableDictionary dictionary];
		_saveOps = [NSMutableDictionary dictionary];
		_wroteAt = [NSMutableDictionary dictionary];
		_wroteRows = [NSMutableDictionary dictionary];
		_searches =[NSMutableDictionary dictionary];
		_searchOrder = [NSMutableArray array];
		_searchWaiters = [NSMutableDictionary dictionary];
		_staleLists = [NSMutableSet set];
		_albumSaved = [NSMutableDictionary dictionary];
		_albumOps = [NSMutableDictionary dictionary];
		_albumChecks = [NSMutableDictionary dictionary];
		_albumWroteAt = [NSMutableDictionary dictionary];
		_addedDates = [NSMutableDictionary dictionary];
		_addedFlights = [NSMutableDictionary dictionary];
		_userSearches = [NSMutableDictionary dictionary];
		_userSearchOrder = [NSMutableArray array];
		_userSearchWaiters = [NSMutableDictionary dictionary];
		_userFollow = [NSMutableDictionary dictionary];
		_followOps = [NSMutableDictionary dictionary];
		_plSaved = [NSMutableDictionary dictionary];
		_plSavedAt = [NSMutableDictionary dictionary];
		_plSaveOps = [NSMutableDictionary dictionary];
		_jamSocialState = -1;
		[ENCatalog prepareAtLaunch];       // (a no-op when didFinishLaunching did it first, as it should)
	}
	return self;
}

+ (void)prepareAtLaunch {
	static BOOL done;
	if (done) return;
	done = YES;
	// No second copy of covers or JSON in Cache.db, and a 304 is handed through as a 304 (§5.2)
	[NSURLCache setSharedURLCache:[[NSURLCache alloc] initWithMemoryCapacity:0 diskCapacity:0 diskPath:nil]];
	ENCacheDir(@"json");
	ENCacheDir(@"img");
}

- (void)start {
	if (_started) return;
	_started = YES;
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(memoryWarning) name:UIApplicationDidReceiveMemoryWarningNotification object:nil];
	[nc addObserver:self selector:@selector(appActive) name:UIApplicationDidBecomeActiveNotification object:nil];
	[nc addObserver:self selector:@selector(playbackChanged) name:ENPlaybackChangedNotification object:nil];
	[self checkVersion];
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		[[ENImageCache shared] pruneDisk];
	});
}

- (BOOL)loading { return _requests > 0; }

- (void)beginRequest { _requests++; }

- (void)endRequest {
	if (_requests > 0) _requests--;
	if (!_requests) [[ENImageCache shared] pump];     // covers held back to one connection may start now
}

- (void)post:(NSString *)kind info:(NSDictionary *)extra {
	if ([kind isEqualToString:ENCatalogKindList]) [self dropAddedDates:extra[ENCatalogURIKey]];   // (0.9.4) that list changed
	NSMutableDictionary *ui = [NSMutableDictionary dictionaryWithObject:kind forKey:ENCatalogKindKey];
	if (extra) [ui addEntriesFromDictionary:extra];
	[[NSNotificationCenter defaultCenter] postNotificationName:ENCatalogChangedNotification object:self userInfo:ui];
}

// after the deliveries already queued (a screen's own done comes before the notification about the same change)
- (void)postLater:(NSString *)kind info:(NSDictionary *)extra {
	dispatch_async(dispatch_get_main_queue(), ^{ [self post:kind info:extra]; });
}

#pragma mark - app state

- (void)appActive {
	if (_libraryStale) [self revalidateLibrary];
	if (_resetPending) {
		_resetPending = NO;
		[self post:ENCatalogKindReset info:nil];
	}
	NSArray *lists = [_staleLists allObjects];
	[_staleLists removeAllObjects];
	for (NSString *u in lists) [self post:ENCatalogKindList info:@{ ENCatalogURIKey: u }];
	if (_albumsStale) {
		_albumsStale = NO;
		[self post:ENCatalogKindAlbums info:nil];
	}
	if (!_gatewayVersion || _versionStale) [self checkVersion];
	[self checkHeard];
}

- (void)memoryWarning {
	// the disk copies stay; the library and Liked (shared with the screens, and patched) stay in memory
	NSUInteger n = 0;
	for (ENCatalogRoute *r in [_routes allValues]) {
		if (r.type == ENRouteLibrary || [r.name isEqualToString:@"liked"] || !r.model) continue;
		r.model = nil;
		r.diskTried = r.memoryOnly;        // (0.11) people routes have no file to read back
		n++;
	}
	[_searches removeAllObjects];
	[_searchOrder removeAllObjects];
	[_userSearches removeAllObjects];      // (0.11)
	[_userSearchOrder removeAllObjects];
	[_addedDates removeAllObjects];        // (0.9.4) asked for again when a Date added sort needs them
	ENLog(@"memory warning: catalog dropped %lu lists (%.0f MB resident)", (unsigned long)n, [ENDiag residentMB]);
}

- (void)checkVersion {
	if (_versionAsking || ![ENGateway shared].paired) return;
	_versionAsking = YES;
	[self beginRequest];
	[[ENGateway shared] sendMethod:@"GET" path:@"/v1/status" json:nil timeout:10 completion:^(id j, NSInteger st, NSError *err) {
		self->_versionAsking = NO;
		[self endRequest];
		NSString *v = st == 200 ? ENJStr(ENJDict(ENJDict(j)[@"gateway"])[@"version"]) : nil;
		if (!v) return;                    // asked again on the next activation
		self->_gatewayVersion = [v copy];
		self->_versionStale = NO;
		id sc = ENJDict(ENJDict(j)[@"jam"])[@"sc"];      // 0.6: absent = unknown
		self->_jamSocialState = [sc isKindOfClass:[NSNumber class]] ? ([(NSNumber *)sc integerValue] == 1 ? 1 : 0) : -1;
		self->_personalTooOld = ENVersionBelow(v, 0, 7, 0);
		[self takeProfilesStatus:ENJDict(ENJDict(j)[@"profiles"]) version:v];     // (0.11)
		BOOL old = ENVersionBelow(v, 0, 5, 0);
		ENLog(@"gateway %@%@", v, old ? @": too old for the browse screens (needs 0.5.0)" : @"");
		if (old != self->_gatewayTooOld) {
			self->_gatewayTooOld = old;
			[self post:ENCatalogKindLibrary info:nil];
		}
		[[NSNotificationCenter defaultCenter] postNotificationName:ENCatalogVersionNotification object:self];
	}];
}

// (0.11) /v1/status `profiles` ({v, follow, sp}; absent before gateway 0.10.0): availability and the playlist-save capability.
// A version answer also ends a "no profile routes" state a 404 not_found started. Posts kind user (no uri) when either changed.
- (void)takeProfilesStatus:(NSDictionary *)pr version:(NSString *)v {
	BOOL wasAvailable = self.profilesAvailable, couldSave = _canSavePlaylists;
	_profilesOld = ENVersionBelow(v, 0, 10, 0);
	_profilesMissing = NO;
	_canSavePlaylists = !_profilesOld && ENJInt(pr[@"sp"], 0) == 1;
	if (wasAvailable != self.profilesAvailable || couldSave != _canSavePlaylists) [self post:ENCatalogKindUser info:nil];
}

- (BOOL)profilesAvailable { return !_profilesOld && !_profilesMissing; }

- (void)parseOnQueue:(void (^)(void))block {
	if (block) dispatch_async(_parseQueue, block);
}

#pragma mark - routes

- (ENCatalogRoute *)routeNamed:(NSString *)name path:(NSString *)path type:(ENRouteType)type uri:(NSString *)uri {
	ENCatalogRoute *r = _routes[name];
	if (!r) {
		r = [[ENCatalogRoute alloc] init];
		r.name = name;
		r.path = path;
		r.type = type;
		r.uri = uri;
		r.freshQuery = YES;
		_routes[name] = r;
	}
	return r;
}

- (ENCatalogRoute *)libraryRoute { return [self routeNamed:@"playlists" path:@"/v1/playlists" type:ENRouteLibrary uri:nil]; }

- (ENCatalogRoute *)routeForListURI:(NSString *)uri {
	if (!ENJStr(uri)) return nil;
	if ([uri isEqualToString:ENLikedListURI] || ([uri hasPrefix:@"spotify:user:"] && [uri hasSuffix:@":collection"]))
		return [self routeNamed:@"liked" path:@"/v1/liked" type:ENRouteList uri:ENLikedListURI];
	NSString *lid = ENIDFromURI(uri);
	if (!ENValidID(lid)) return nil;
	if ([uri hasPrefix:@"spotify:playlist:"])
		return [self routeNamed:[@"pl_" stringByAppendingString:lid] path:[@"/v1/playlists/" stringByAppendingString:lid] type:ENRouteList uri:uri];
	if ([uri hasPrefix:@"spotify:album:"]) {
		ENCatalogRoute *r = [self routeNamed:[@"album_" stringByAppendingString:lid] path:[@"/v1/albums/" stringByAppendingString:lid]
		                                type:ENRouteList uri:uri];
		r.maxAge = ENDayAge;
		r.freshQuery = NO;                 // the gateway's album route has no fresh=1 (its own copy lasts a day too)
		return r;
	}
	return nil;
}

#pragma mark - cache files

+ (id)modelFromJSON:(id)j type:(ENRouteType)type meName:(NSString *)meName checkedAt:(NSDate *)at {
	switch (type) {
		case ENRouteLibrary: return [ENLibrary libraryWithJSON:j checkedAt:at];
		case ENRouteList: return [ENTrackList listWithJSON:j meName:meName];
		case ENRouteArtist: return [ENArtistPage pageWithJSON:j];
		case ENRouteHome: return [ENHomePage pageWithJSON:j meName:meName];
		case ENRouteProfile: return [ENProfile profileWithJSON:j meName:meName];
		case ENRouteAlbums: return [ENRowList listWithJSON:j kind:ENRowListAlbums];
		case ENRouteArtists: return [ENRowList listWithJSON:j kind:ENRowListArtists];
		case ENRouteRecent: return [ENRowList listWithJSON:j kind:ENRowListRecent];
		case ENRouteUser: return [ENUserProfile profileWithJSON:j meName:meName];                  // (0.11)
		case ENRouteUserPlaylists: return [ENRowList listWithJSON:j kind:ENRowListPlaylists meName:meName];
		case ENRoutePeople: return [ENRowList listWithJSON:j kind:ENRowListPeople];
	}
	return nil;
}

// Any thread: the cached body of `name` as a model + its ETag + check time ({model, etag?, at?}), nil if none / unreadable.
+ (NSDictionary *)readCacheNamed:(NSString *)name type:(ENRouteType)type meName:(NSString *)meName {
	NSString *base = [ENCacheDir(@"json") stringByAppendingPathComponent:name];
	NSString *jsonPath = [base stringByAppendingPathExtension:@"json"], *tagPath = [base stringByAppendingPathExtension:@"etag"];
	CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
	NSData *d = [NSData dataWithContentsOfFile:jsonPath];
	if (!d.length) return nil;
	NSString *etag = [[NSString stringWithContentsOfFile:tagPath encoding:NSUTF8StringEncoding error:NULL]
		stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	if (!etag.length) etag = nil;
	NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:(etag ? tagPath : jsonPath) error:NULL];
	NSDate *at = [attrs fileModificationDate];
	id m = [self modelFromJSON:ENParseJSON(d) type:type meName:meName checkedAt:at];
	if ([name isEqualToString:@"liked"] && [m isKindOfClass:[ENTrackList class]])
		ENLog(@"liked: cached copy read + parsed in %.0f ms (%lu rows, %lu KB)", (CFAbsoluteTimeGetCurrent() - t0) * 1000,
			(unsigned long)[(ENTrackList *)m tracks].count, (unsigned long)(d.length / 1024));
	if (!m) return nil;
	NSMutableDictionary *c = [NSMutableDictionary dictionaryWithObject:m forKey:@"model"];
	if (etag) c[@"etag"] = etag;
	if (at) c[@"at"] = at;
	return c;
}

// The raw body as received (never re-serialized) and then its ETag: a crash in between leaves an old ETag, which the
// gateway answers with a 200.
- (void)writeCacheNamed:(NSString *)name data:(NSData *)data etag:(NSString *)etag {
	NSString *base = [ENCacheDir(@"json") stringByAppendingPathComponent:name];
	dispatch_async(_ioQueue, ^{
		NSString *tagPath = [base stringByAppendingPathExtension:@"etag"];
		if (![data writeToFile:[base stringByAppendingPathExtension:@"json"] atomically:YES]) {
			ENLog(@"catalog: a cache file couldn't be written");
			return;
		}
		if (etag) [etag writeToFile:tagPath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
		else [[NSFileManager defaultManager] removeItemAtPath:tagPath error:NULL];
	});
}

- (void)touchCacheNamed:(NSString *)name at:(NSDate *)date {
	NSString *tagPath = [[ENCacheDir(@"json") stringByAppendingPathComponent:name] stringByAppendingPathExtension:@"etag"];
	dispatch_async(_ioQueue, ^{
		[[NSFileManager defaultManager] setAttributes:@{ NSFileModificationDate: date } ofItemAtPath:tagPath error:NULL];
	});
}

- (BOOL)shouldWrite:(id)m {
	if ([m isKindOfClass:[ENTrackList class]]) return [(ENTrackList *)m done] && ![(ENTrackList *)m stale];   // partial: never
	if ([m isKindOfClass:[ENLibrary class]]) return ![(ENLibrary *)m stale];
	if ([m isKindOfClass:[ENArtistPage class]]) return ![(ENArtistPage *)m stale];
	if ([m isKindOfClass:[ENHomePage class]]) return ![(ENHomePage *)m stale];
	if ([m isKindOfClass:[ENProfile class]]) return ![(ENProfile *)m stale];
	if ([m isKindOfClass:[ENRowList class]]) {     // (0.11) people, their playlists and people search: memory only
		ENRowListKind k = [(ENRowList *)m kind];
		if (k == ENRowListPlaylists || k == ENRowListPeople || k == ENRowListUsers) return NO;
		return ![(ENRowList *)m stale];
	}
	return NO;                             // (0.11: ENUserProfile among them)
}

#pragma mark - loads

- (void)fail:(ENCatalogBlock)done status:(NSInteger)status code:(NSString *)code message:(NSString *)message {
	if (!done) return;
	NSError *e = [NSError errorWithDomain:ENCatalogErrorDomain code:status
	                             userInfo:@{ ENCatalogErrorCodeKey: code, NSLocalizedDescriptionKey: message }];
	dispatch_async(dispatch_get_main_queue(), ^{ done(nil, NO, e); });
}

- (void)deliver:(id)model fromCache:(BOOL)fromCache error:(NSError *)e to:(ENCatalogWaiter *)w {
	ENCatalogBlock d = w.done;
	if (!d) return;
	dispatch_async(dispatch_get_main_queue(), ^{ d(model, fromCache, e); });
}

- (void)load:(ENCatalogRoute *)r fresh:(BOOL)fresh poll:(BOOL)poll done:(ENCatalogBlock)done {
	ENCatalogWaiter *w = [[ENCatalogWaiter alloc] init];
	w.done = done;
	w.fresh = fresh;
	w.poll = poll;
	if (poll) {
		w.etag = r.etag;                   // the last body delivered for the route
		[self join:w route:r];
		return;
	}
	if (r.model || r.diskTried) {
		[self deliverCache:w route:r];
		return;
	}
	[r.diskWaiters addObject:w];
	if (r.readingDisk) return;
	r.readingDisk = YES;
	NSString *name = r.name, *meName = _library.rawMeName;
	ENRouteType type = r.type;
	dispatch_async(_parseQueue, ^{
		NSDictionary *c = [ENCatalog readCacheNamed:name type:type meName:meName];
		dispatch_async(dispatch_get_main_queue(), ^{
			r.readingDisk = NO;
			r.diskTried = YES;
			if (c) r.diskEtag = c[@"etag"];
			if (c && !r.model) [self takeModel:c[@"model"] etag:c[@"etag"] checkedAt:c[@"at"] data:nil route:r network:NO];
			NSArray *ws = [r.diskWaiters copy];
			[r.diskWaiters removeAllObjects];
			for (ENCatalogWaiter *x in ws) [self deliverCache:x route:r];
		});
	});
}

// The cached copy (if any) to this call, then the request unless the copy is young enough (albums, artists).
- (void)deliverCache:(ENCatalogWaiter *)w route:(ENCatalogRoute *)r {
	BOOL ask = YES;
	if (r.model) {
		w.etag = r.etag;
		[self deliver:r.model fromCache:YES error:nil to:w];
		if (r.maxAge > 0 && !w.fresh && r.checkedAt && -[r.checkedAt timeIntervalSinceNow] < r.maxAge && [ENCatalog keepsForDay:r.model])
			ask = NO;
	}
	if (ask) [self join:w route:r];
}

// An artist page without Popular songs is asked for again on every open: the gateway answers `top: []` (and doesn't keep
// the page) when its top-tracks search failed, and builds the whole page on the next request.
+ (BOOL)keepsForDay:(id)m {
	return ![m isKindOfClass:[ENArtistPage class]] || [(ENArtistPage *)m popular].count > 0;
}

- (void)join:(ENCatalogWaiter *)w route:(ENCatalogRoute *)r {
	[r.waiters addObject:w];
	if (!r.inFlight) [self send:r];
}

- (void)send:(ENCatalogRoute *)r {
	// If-None-Match only with an ETag every waiting call was delivered (a first-time caller always gets a body)
	BOOL fresh = NO, first = YES;
	NSString *inm = nil;
	for (ENCatalogWaiter *w in r.waiters) {
		fresh = fresh || w.fresh;
		if (first) inm = w.etag;
		else if (!ENSameTag(inm, w.etag)) inm = nil;
		first = NO;
	}
	r.inFlight = YES;
	r.sentAt = [NSDate date];
	NSString *path = r.path;
	if (fresh && r.freshQuery)             // (0.11) a playlists page's path already has ?offset=N
		path = [path stringByAppendingString:([path rangeOfString:@"?"].location == NSNotFound ? @"?fresh=1" : @"&fresh=1")];
	NSString *sent = inm;
	CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
	[self beginRequest];
	[[ENGateway shared] fetchData:path etag:inm timeout:ENGetTimeout completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		[self endRequest];
		// (T-b3: a 304 must come through as a 304; the route kind only, no ids)
		ENLog(@"catalog %@%@: %ld, %lu KB in %.0f ms", [self labelOfRoute:r], fresh ? @" (fresh)" : @"", (long)st,
			(unsigned long)(data.length / 1024), (CFAbsoluteTimeGetCurrent() - t0) * 1000);
		[self route:r answered:data status:st etag:etag error:err sent:sent fresh:fresh];
	}];
}

- (NSString *)labelOfRoute:(ENCatalogRoute *)r {
	if (r.type == ENRouteLibrary) return @"library";
	if (r.type == ENRouteArtist) return @"artist";
	if ([r.name hasPrefix:@"album_"]) return @"album";
	if ([r.name hasPrefix:@"pl_"]) return @"playlist";
	if (r.type == ENRouteUser) return @"user";                 // (0.11: never the id)
	if (r.type == ENRouteUserPlaylists) return @"user playlists";
	if (r.type == ENRoutePeople) return [r.name hasPrefix:@"ufo_"] ? @"followers" : @"following";
	return r.name;
}

- (void)route:(ENCatalogRoute *)r answered:(NSData *)data status:(NSInteger)st etag:(NSString *)etag error:(NSError *)err
         sent:(NSString *)sent fresh:(BOOL)fresh {
	// 304, or a 200 with the very body we hold: only the check time changes
	if (st == 304 || (st == 200 && r.model && ENSameTag(etag, r.etag))) {
		[self finish:r model:nil etag:(st == 304 ? sent : etag) data:nil error:nil fresh:fresh];
		return;
	}
	ENRouteType type = r.type;
	NSString *meName = _library.rawMeName;
	BOOL liked = [r.name isEqualToString:@"liked"];
	BOOL personal = type == ENRouteHome || type == ENRouteProfile || type == ENRouteAlbums || type == ENRouteArtists || type == ENRouteRecent;
	BOOL tooOld = _personalTooOld;
	BOOL people = ENIsPeopleRoute(type);   // (0.11)
	dispatch_async(_parseQueue, ^{
		id model = nil;
		NSError *e = nil;
		if (st == 200) {
			CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
			model = [ENCatalog modelFromJSON:ENParseJSON(data) type:type meName:meName checkedAt:[NSDate date]];
			if (liked && model)
				ENLog(@"liked: parsed %lu rows (%lu KB) in %.0f ms", (unsigned long)[(ENTrackList *)model tracks].count,
					(unsigned long)(data.length / 1024), (CFAbsoluteTimeGetCurrent() - t0) * 1000);
			if (!model) e = [NSError errorWithDomain:ENCatalogErrorDomain code:502
			                                userInfo:@{ ENCatalogErrorCodeKey: @"unreadable", NSLocalizedDescriptionKey: ENUnreadableText }];
		} else {
			e = [ENCatalog errorWithJSON:ENParseJSON(data) status:st error:err];
			if (st == 404 && personal && tooOld)
				e = [NSError errorWithDomain:ENCatalogErrorDomain code:404 userInfo:@{ ENCatalogErrorCodeKey: @"gateway_too_old",
					NSLocalizedDescriptionKey: ENUpdateBridgeL }];
			if (people) e = [ENCatalog profilesError:e];          // (0.11) not_found: a gateway from before the routes
		}
		dispatch_async(dispatch_get_main_queue(), ^{
			if (people) [self noteProfilesError:e];
			[self finish:r model:model etag:etag data:data error:e fresh:fresh];
		});
	});
}

// The request ended: model (200), or error, or neither (not modified; etag = the one confirmed).
- (void)finish:(ENCatalogRoute *)r model:(id)m etag:(NSString *)etag data:(NSData *)data error:(NSError *)e fresh:(BOOL)fresh {
	NSArray *ws = [r.waiters copy];
	[r.waiters removeAllObjects];
	r.inFlight = NO;
	if (e) {
		for (ENCatalogWaiter *w in ws) [self deliver:nil fromCache:NO error:e to:w];
		return;                            // (a pull-to-refresh that joined has had its answer: the error)
	}
	if (m) {
		// A re-read still in progress (partial) never replaces a finished copy: new screens and like patches keep using
		// the full list; only the callers asking now get the partial (so they keep polling).
		BOOL partialOverDone = [m isKindOfClass:[ENTrackList class]] && ![(ENTrackList *)m done] &&
			[r.model isKindOfClass:[ENTrackList class]] && [(ENTrackList *)r.model done];
		if (!partialOverDone) [self takeModel:m etag:etag checkedAt:[NSDate date] data:data route:r network:YES];
		for (ENCatalogWaiter *w in ws) {
			if (ENSameTag(w.etag, etag)) continue;
			w.etag = etag;
			[self deliver:(partialOverDone ? m : r.model) fromCache:NO error:nil to:w];
		}
	} else {
		[self noteChecked:r etag:etag];
		// a call that joined without having been delivered this body (its copy went in a memory warning): the copy
		for (ENCatalogWaiter *w in ws) {
			if (w.poll || ENSameTag(w.etag, etag) || !r.model || !ENSameTag(r.etag, etag)) continue;
			w.etag = etag;
			[self deliver:r.model fromCache:YES error:nil to:w];
		}
	}
	// a pull to refresh that joined a plain revalidation: ask again with fresh=1
	if (!fresh && r.freshQuery) {
		for (ENCatalogWaiter *w in ws) if (w.fresh) [r.waiters addObject:w];
		if (r.waiters.count && !r.inFlight) [self send:r];
	}
}

- (void)noteChecked:(ENCatalogRoute *)r etag:(NSString *)etag {
	NSDate *now = [NSDate date];
	r.checkedAt = now;
	if (r.type == ENRouteLibrary && [r.model isKindOfClass:[ENLibrary class]]) {
		r.model = [(ENLibrary *)r.model libraryWithCheckedAt:now];      // the footer's "updated just now"
		_library = r.model;
		[self postLater:ENCatalogKindLibrary info:nil];                 // (a 304 delivers nothing to the screens)
	}
	if (ENSameTag(r.diskEtag, etag)) [self touchCacheNamed:r.name at:now];
}

// A new memory copy for a route (disk or network).
- (void)takeModel:(id)m etag:(NSString *)etag checkedAt:(NSDate *)at data:(NSData *)data route:(ENCatalogRoute *)r network:(BOOL)network {
	if (!m) return;
	r.model = m;
	r.etag = etag;
	r.checkedAt = at;
	// (R2a) the real token: the getter masks it while Anonymous Mode is on
	NSString *me = [m isKindOfClass:[ENHomePage class]] ? [(ENHomePage *)m rawMeImage] : [m isKindOfClass:[ENProfile class]] ? [(ENProfile *)m rawImage] : nil;
	if (me) _meImageToken = [me copy];
	if (r.type == ENRouteLibrary) {
		_library = m;
		if (network) {
			_librarySeq++;
			[self postLater:ENCatalogKindLibrary info:nil];
		}
	} else if ([r.name isEqualToString:@"liked"] && [m isKindOfClass:[ENTrackList class]]) {
		NSDate *sent = network ? r.sentAt : nil;
		r.model = m = [self withPendingSaves:m since:sent];     // likes still in flight (or newer than the body) stay visible
		_likedList = m;
		NSArray *changed = [self markLikedRows:m network:network since:sent];
		if (changed.count) [self postLater:ENCatalogKindLiked info:@{ ENCatalogURIsKey: changed }];
		if (network) [self recheckSavedMissingFrom:m since:sent];
	}
	if (network && data.length && [self shouldWrite:m]) {
		[self writeCacheNamed:r.name data:data etag:etag];
		r.diskEtag = etag;
	}
}

// Our own like / unlike of uri is in flight, or was answered after `sent` (a body asked for before then may predate it).
- (BOOL)ownWrite:(NSString *)uri since:(NSDate *)sent {
	if (_saveOps[uri]) return YES;
	NSDate *w = sent ? _wroteAt[uri] : nil;
	return w && [w compare:sent] != NSOrderedAscending;
}

// Every Liked row is saved: the network copy says so for sure, a cached one only fills unknown states. Our own writes the
// body may predate keep our state.
- (NSArray *)markLikedRows:(ENTrackList *)l network:(BOOL)network since:(NSDate *)sent {
	NSMutableArray *changed = [NSMutableArray array];
	for (ENTrack *t in l.tracks) {
		NSString *u = t.uri;
		if ([self ownWrite:u since:sent]) continue;
		NSNumber *s = _saved[u];
		if (s ? (network && ![s boolValue]) : YES) {
			_saved[u] = @YES;
			[changed addObject:u];
		}
	}
	return changed;
}

// A whole network copy of Liked lacks a song we hold as saved: unliked elsewhere (on another device), or the gateway's listing is
// still behind a like made there (it keeps one for up to 5 min). contains is current: ask it, which sets the state and
// posts kind liked (the ••• menu trusts a known state).
- (void)recheckSavedMissingFrom:(ENTrackList *)l since:(NSDate *)sent {
	if (!l.done || l.stale || l.truncated) return;
	NSMutableSet *rows = [NSMutableSet setWithCapacity:l.tracks.count];
	for (ENTrack *t in l.tracks) [rows addObject:t.uri];
	NSMutableArray *ask = [NSMutableArray array];
	for (NSString *u in _saved) {
		if ([_saved[u] boolValue] && ![rows containsObject:u] && ![self ownWrite:u since:sent]) [ask addObject:u];
	}
	if (ask.count) [self checkSaved:ask done:nil];
}

// The server's Liked list with our likes / unlikes it may not have yet applied on top: the ones not answered yet, and (a
// network body: sent = when it was asked for) the ones answered after it was asked for.
- (ENTrackList *)withPendingSaves:(ENTrackList *)l since:(NSDate *)sent {
	if (!_saveOps.count && !sent) return l;
	NSMutableSet *drop = [NSMutableSet set];
	for (ENSaveOp *op in [_saveOps allValues]) {
		if (!op.wanted) [drop addObject:op.uri];
		else if (op.track) l = [l listByPrepending:op.track];
	}
	if (sent) {
		for (NSString *u in _wroteAt) {
			if (_saveOps[u] || [(NSDate *)_wroteAt[u] compare:sent] == NSOrderedAscending) continue;
			NSNumber *s = _saved[u];
			if ([s isEqual:@NO]) [drop addObject:u];
			else if ([s boolValue] && _wroteRows[u]) l = [l listByPrepending:_wroteRows[u]];
		}
	}
	return [l listByRemovingURIs:drop];
}

- (void)setLibraryPatch:(ENLibrary *)lib {
	if (!lib || lib == _library) return;
	_library = lib;
	[self libraryRoute].model = lib;
	[self post:ENCatalogKindLibrary info:nil];
}

- (void)setLikedPatch:(ENTrackList *)l {
	if (!l || l == _likedList) return;
	_likedList = l;
	ENCatalogRoute *r = _routes[@"liked"];
	if (r) r.model = l;
}

- (void)revalidateLibrary {
	_libraryStale = NO;
	[self load:[self libraryRoute] fresh:NO poll:YES done:nil];      // a new body posts kind library
}

#pragma mark - public loads

@synthesize meImageToken = _meImageToken;

// (R2a) no picture of you while Anonymous Mode is on: the profile buttons show the no-picture face and never ask for it
- (NSString *)meImageToken { return [ENAnon on] ? nil : _meImageToken; }

- (ENLibrary *)cachedLibrarySync {
	ENCatalogRoute *r = [self libraryRoute];
	if (r.model) return r.model;
	if (!r.diskTried && !r.readingDisk) {
		CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
		NSDictionary *c = [ENCatalog readCacheNamed:r.name type:ENRouteLibrary meName:nil];
		r.diskTried = YES;
		if (c) {
			r.diskEtag = c[@"etag"];
			[self takeModel:c[@"model"] etag:c[@"etag"] checkedAt:c[@"at"] data:nil route:r network:NO];
			ENLog(@"library: cached copy in %.1f ms (%lu playlists)", (CFAbsoluteTimeGetCurrent() - t0) * 1000,
				(unsigned long)_library.playlists.count);
		}
	}
	return _library;
}

- (void)loadLibrary:(BOOL)fresh done:(ENCatalogBlock)done {
	[self load:[self libraryRoute] fresh:fresh poll:NO done:done];
}

- (void)loadList:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done {
	ENCatalogRoute *r = [self routeForListURI:uri];
	if (!r) { [self fail:done status:400 code:@"bad_request" message:ENL(@"This list can't be opened.")]; return; }
	[self load:r fresh:fresh poll:NO done:done];
}

- (void)pollList:(NSString *)uri done:(ENCatalogBlock)done {
	ENCatalogRoute *r = [self routeForListURI:uri];
	if (!r) { [self fail:done status:400 code:@"bad_request" message:ENL(@"This list can't be opened.")]; return; }
	[self load:r fresh:NO poll:YES done:done];
}

- (void)loadArtist:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done {
	NSString *aid = ENIDFromURI(uri);
	if (![ENJStr(uri) hasPrefix:@"spotify:artist:"] || !ENValidID(aid)) {
		[self fail:done status:400 code:@"bad_request" message:ENL(@"This artist can't be opened.")];
		return;
	}
	ENCatalogRoute *r = [self routeNamed:[@"artist_" stringByAppendingString:aid] path:[@"/v1/artists/" stringByAppendingString:aid]
	                                type:ENRouteArtist uri:uri];
	r.maxAge = ENDayAge;
	r.freshQuery = NO;
	[self load:r fresh:fresh poll:NO done:done];
}

#pragma mark - 0.7: Home, Your Library's lists, your profile

- (void)loadHome:(BOOL)fresh done:(ENCatalogBlock)done {
	[self load:[self routeNamed:@"home" path:@"/v1/home" type:ENRouteHome uri:nil] fresh:fresh poll:NO done:done];
}

- (void)loadProfile:(BOOL)fresh done:(ENCatalogBlock)done {
	[self load:[self routeNamed:@"profile" path:@"/v1/me" type:ENRouteProfile uri:nil] fresh:fresh poll:NO done:done];
}

- (void)loadSavedAlbums:(BOOL)fresh done:(ENCatalogBlock)done {
	[self load:[self routeNamed:@"my_albums" path:@"/v1/me/albums" type:ENRouteAlbums uri:nil] fresh:fresh poll:NO done:done];
}

- (void)loadFollowedArtists:(BOOL)fresh done:(ENCatalogBlock)done {
	[self load:[self routeNamed:@"my_artists" path:@"/v1/me/artists" type:ENRouteArtists uri:nil] fresh:fresh poll:NO done:done];
}

- (void)loadRecentlyPlayed:(BOOL)fresh done:(ENCatalogBlock)done {
	[self load:[self routeNamed:@"recent" path:@"/v1/recent" type:ENRouteRecent uri:nil] fresh:fresh poll:NO done:done];
}

#pragma mark - search (memory only)

- (void)search:(NSString *)q offset:(NSInteger)offset done:(ENCatalogBlock)done {
	NSString *t = [(ENJStr(q) ?: @"") stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	if (!t.length) { [self fail:done status:400 code:@"bad_request" message:ENL(@"Type something to search for.")]; return; }
	if (t.length > 100) {                  // the gateway takes 1-100 characters; never cut a surrogate pair in half
		unichar c = [t characterAtIndex:99];
		t = [t substringToIndex:(c >= 0xD800 && c <= 0xDBFF) ? 99 : 100];
	}
	NSInteger off = MAX(0, MIN(990, offset));
	off -= off % 10;
	NSString *key = [NSString stringWithFormat:@"%@|%ld", [t lowercaseString], (long)off];
	ENSearchEntry *hit = _searches[key];
	if (hit && -[hit.at timeIntervalSinceNow] < ENSearchTTL) {
		[_searchOrder removeObject:key];
		[_searchOrder addObject:key];
		ENSearchResult *res = hit.result;
		if (done) dispatch_async(dispatch_get_main_queue(), ^{ done(res, YES, nil); });
		return;
	}
	NSMutableArray *ws = _searchWaiters[key];
	if (ws) { if (done) [ws addObject:[done copy]]; return; }
	ws = [NSMutableArray array];
	if (done) [ws addObject:[done copy]];
	_searchWaiters[key] = ws;
	NSString *qq = [ENGateway escape:t] ?: @"";      // (nil only for text that isn't valid UTF-16: the gateway then says 400)
	NSString *path = off > 0 ? [NSString stringWithFormat:@"/v1/search?q=%@&type=track&offset=%ld", qq, (long)off]
	                         : [@"/v1/search?q=" stringByAppendingString:qq];
	[self beginRequest];
	[[ENGateway shared] fetchData:path etag:nil timeout:ENSearchTimeout completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		[self endRequest];
		dispatch_async(self->_parseQueue, ^{
			id j = ENParseJSON(data);
			ENSearchResult *res = st == 200 ? [ENSearchResult resultWithJSON:j offset:off] : nil;
			NSError *e = nil;
			if (!res) e = st == 200 ? [NSError errorWithDomain:ENCatalogErrorDomain code:502
			                                          userInfo:@{ ENCatalogErrorCodeKey: @"unreadable", NSLocalizedDescriptionKey: ENUnreadableText }]
			                        : [ENCatalog errorWithJSON:j status:st error:err];
			dispatch_async(dispatch_get_main_queue(), ^{ [self search:key answered:res error:e]; });
		});
	}];
}

- (void)search:(NSString *)key answered:(ENSearchResult *)res error:(NSError *)e {
	NSArray *blocks = _searchWaiters[key];
	[_searchWaiters removeObjectForKey:key];
	if (res) {
		ENSearchEntry *entry = [[ENSearchEntry alloc] init];
		entry.result = res;
		entry.at = [NSDate date];
		_searches[key] = entry;
		[_searchOrder removeObject:key];
		[_searchOrder addObject:key];
		while (_searchOrder.count > ENSearchMax) {
			[_searches removeObjectForKey:_searchOrder[0]];
			[_searchOrder removeObjectAtIndex:0];
		}
	}
	for (ENCatalogBlock b in blocks) b(res, NO, e);
}

#pragma mark - saved states

- (NSNumber *)savedStateForURI:(NSString *)uri {
	return ENJStr(uri) ? _saved[uri] : nil;
}

// contains answers / events: uri -> 1|0. Uris with a like/unlike in flight keep what the user asked for.
- (NSArray *)applyStates:(NSDictionary *)items {
	NSMutableArray *changed = [NSMutableArray array];
	for (id u in items) {
		if (!ENJStr(u) || _saveOps[u]) continue;
		NSNumber *s = ENJInt(items[u], 0) == 1 ? @YES : @NO;
		if ([_saved[u] isEqual:s]) continue;
		_saved[u] = s;
		[changed addObject:u];
	}
	return changed;
}

- (void)checkSaved:(NSArray *)uris done:(void (^)(void))done {
	void (^d)(void) = [done copy];
	NSMutableArray *list = [NSMutableArray array];
	NSMutableSet *seen = [NSMutableSet set];
	for (id u in ENJArr(uris)) {
		if (!ENJStr(u) || ![u hasPrefix:@"spotify:track:"] || [seen containsObject:u]) continue;      // the route takes songs only
		[seen addObject:u];
		[list addObject:u];
	}
	if (!list.count) {
		if (d) dispatch_async(dispatch_get_main_queue(), d);
		return;
	}
	__block NSUInteger left = (list.count + 49) / 50;
	NSMutableArray *changed = [NSMutableArray array];
	for (NSUInteger i = 0; i < list.count; i += 50) {
		NSArray *batch = [list subarrayWithRange:NSMakeRange(i, MIN((NSUInteger)50, list.count - i))];
		NSMutableArray *esc = [NSMutableArray arrayWithCapacity:batch.count];
		for (NSString *u in batch) [esc addObject:[ENGateway escape:u] ?: @""];
		NSString *path = [@"/v1/library/contains?uris=" stringByAppendingString:[esc componentsJoinedByString:@","]];
		[self beginRequest];
		[[ENGateway shared] fetchData:path etag:nil timeout:ENContainsTimeout completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
			[self endRequest];
			dispatch_async(self->_parseQueue, ^{
				NSDictionary *items = st == 200 ? ENJDict(ENJDict(ENParseJSON(data))[@"items"]) : nil;
				dispatch_async(dispatch_get_main_queue(), ^{
					if (items) [changed addObjectsFromArray:[self applyStates:items]];
					else ENLog(@"saved-state check failed (%ld)", (long)st);
					if (--left > 0) return;
					if (changed.count) [self post:ENCatalogKindLiked info:@{ ENCatalogURIsKey: [changed copy] }];
					if (d) d();
				});
			});
		}];
	}
}

// The song being heard has no known state: ask once per song, while the app is on screen (§5.3)
- (void)playbackChanged {
	NSString *u = [[ENPlayback shared] playingURI];
	if (!u || [u isEqualToString:_heardURI]) return;
	_heardURI = [u copy];
	// the snapshot's own `liked` usually comes along within a moment: give it the chance first
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(checkHeard) object:nil];
	[self performSelector:@selector(checkHeard) withObject:nil afterDelay:1.5];
}

- (void)checkHeard {
	NSString *u = [[ENPlayback shared] playingURI];
	if (![u hasPrefix:@"spotify:track:"] || [u isEqualToString:_heardChecked] || _saved[u] || _saveOps[u]) return;
	if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) return;     // again on activation
	_heardChecked = [u copy];
	[self checkSaved:@[u] done:nil];
}

- (void)noteSnapshotTrack:(NSDictionary *)track {
	NSDictionary *t = ENJDict(track);
	id lv = t[@"liked"];
	if (![lv isKindOfClass:[NSNumber class]]) return;               // absent = unknown
	NSString *u = ENJStr(t[@"context_track_uri"]) ?: ENJStr(t[@"uri"]);
	if (!u || _saveOps[u]) return;
	NSDate *wrote = _wroteAt[u];
	if (wrote && -[wrote timeIntervalSinceNow] < ENWriteEcho) return;   // may have been taken before our write landed
	NSNumber *s = [(NSNumber *)lv integerValue] == 1 ? @YES : @NO;
	if ([_saved[u] isEqual:s]) return;
	_saved[u] = s;
	[self post:ENCatalogKindLiked info:@{ ENCatalogURIsKey: @[u] }];
}

#pragma mark - like / unlike (optimistic, §6.4)

- (void)setSaved:(BOOL)saved tracks:(NSArray *)tracks done:(void (^)(NSError *error))done {
	ENSaveCall *call = [[ENSaveCall alloc] init];
	call.done = done;
	NSMutableArray *changed = [NSMutableArray array], *send = [NSMutableArray array], *prepend = [NSMutableArray array];
	NSMutableSet *remove = [NSMutableSet set];
	NSInteger delta = 0;
	for (ENTrack *t in ENJArr(tracks)) {
		if (![t isKindOfClass:[ENTrack class]] || ![t.uri hasPrefix:@"spotify:track:"]) continue;
		NSString *u = t.uri;
		ENSaveOp *op = _saveOps[u];
		if ([op.calls containsObject:call]) continue;                // the same song twice in one call
		if (!op) {
			op = [[ENSaveOp alloc] init];
			op.uri = u;
			op.before = _saved[u];
			op.server = op.before ? [op.before boolValue] : !saved;  // unknown: take it that this call changes it
			op.wanted = op.server;
			op.removedIndex = NSNotFound;
			op.calls = [NSMutableArray array];
			_saveOps[u] = op;
		}
		op.track = t;
		[op.calls addObject:call];
		call.pending++;
		if (op.wanted != saved) {
			op.wanted = saved;
			_saved[u] = saved ? @YES : @NO;
			[changed addObject:u];
			delta += saved ? 1 : -1;
			if (saved) [prepend addObject:t];
			else [remove addObject:u];
		}
		if (!op.inFlight) [send addObject:u];
	}
	if (!call.pending) {
		call.done = nil;
		if (done) {
			NSError *e = [NSError errorWithDomain:ENCatalogErrorDomain code:400
			                             userInfo:@{ ENCatalogErrorCodeKey: @"bad_request", NSLocalizedDescriptionKey: ENL(@"Only songs can be saved to Liked Songs.") }];
			dispatch_async(dispatch_get_main_queue(), ^{ done(e); });
		}
		return;
	}
	// at once: Liked rows, the count, the hearts
	if (_likedList && (prepend.count || remove.count)) {
		ENTrackList *l = _likedList;
		for (ENTrack *t in [prepend reverseObjectEnumerator]) l = [l listByPrepending:t];
		for (NSString *u in remove) {
			NSUInteger i = [l indexOfURI:u];
			if (i == NSNotFound) continue;
			ENSaveOp *op = _saveOps[u];
			op.removedRow = l.tracks[i];
			op.removedIndex = i;
		}
		[self setLikedPatch:[l listByRemovingURIs:remove]];
	}
	if (delta && _library.likedLength >= 0) [self setLibraryPatch:[_library libraryWithLikedLength:MAX(0, _library.likedLength + delta)]];
	for (NSString *u in changed) [_saveOps[u] setCountSeq:_librarySeq];
	if (changed.count) [self post:ENCatalogKindLiked info:@{ ENCatalogURIsKey: changed }];
	[self sendSaves:send];
}

// One POST /v1/library per wanted state, 50 uris at most each.
- (void)sendSaves:(NSArray *)uris {
	NSMutableArray *yes = [NSMutableArray array], *no = [NSMutableArray array];
	for (NSString *u in uris) {
		ENSaveOp *op = _saveOps[u];
		if (!op || op.inFlight) continue;
		[(op.wanted ? yes : no) addObject:u];
	}
	for (NSArray *group in @[yes, no]) {
		for (NSUInteger i = 0; i < group.count; i += 50)
			[self sendSave:[group subarrayWithRange:NSMakeRange(i, MIN((NSUInteger)50, group.count - i))] saved:(group == yes)];
	}
}

- (void)sendSave:(NSArray *)uris saved:(BOOL)saved {
	NSMutableArray *rows = [NSMutableArray array];
	for (NSString *u in uris) {
		ENSaveOp *op = _saveOps[u];
		op.inFlight = YES;
		op.sent = saved;
		if (saved && op.track.name) [rows addObject:[op.track rowJSON]];   // lets the gateway patch its stored Liked listing
	}
	NSMutableDictionary *body = [NSMutableDictionary dictionary];
	body[@"uris"] = uris;
	body[@"saved"] = saved ? @YES : @NO;                       // a JSON boolean: the gateway refuses 1/0
	if (rows.count) body[@"rows"] = rows;
	[self beginRequest];
	[[ENGateway shared] sendMethod:@"POST" path:@"/v1/library" json:body timeout:ENWriteTimeout completion:^(id j, NSInteger st, NSError *err) {
		[self endRequest];
		if (st == 200 && ENJDict(j)) [self saves:uris answered:j];
		else [self saves:uris failed:[ENCatalog errorWithJSON:j status:st error:err]];
	}];
}

- (void)saves:(NSArray *)uris answered:(NSDictionary *)j {
	NSDictionary *items = ENJDict(j[@"items"]);
	NSDate *now = [NSDate date];
	NSMutableArray *again = [NSMutableArray array], *settled = [NSMutableArray array];
	for (NSString *u in uris) {
		ENSaveOp *op = _saveOps[u];
		if (!op || !op.inFlight) continue;
		op.inFlight = NO;
		op.server = items[u] ? ENJInt(items[u], 0) == 1 : op.sent;
		op.serverKnown = YES;
		_wroteAt[u] = now;
		if (op.wanted != op.server) { [again addObject:u]; continue; }     // tapped again meanwhile: send the newest
		[_saveOps removeObjectForKey:u];
		_saved[u] = op.server ? @YES : @NO;
		if (op.server && op.track) _wroteRows[u] = op.track;              // for a Liked body asked for before this landed
		else [_wroteRows removeObjectForKey:u];
		[settled addObject:op];
	}
	NSInteger len = ENJInt(j[@"liked_len"], -1);
	if (len >= 0 && !_saveOps.count && _library && _library.likedLength != len) {
		_librarySeq++;
		[self setLibraryPatch:[_library libraryWithLikedLength:len]];     // the server's count, once nothing else is pending
	}
	for (ENSaveOp *op in settled) for (ENSaveCall *c in op.calls) [c settle:nil];
	[self sendSaves:again];
}

- (void)saves:(NSArray *)uris failed:(NSError *)e {
	NSMutableArray *changed = [NSMutableArray array], *readd = [NSMutableArray array], *settled = [NSMutableArray array];
	NSMutableArray *moot = [NSMutableArray array];
	NSMutableSet *drop = [NSMutableSet set];
	NSInteger delta = 0;
	for (NSString *u in uris) {
		ENSaveOp *op = _saveOps[u];
		if (!op) continue;
		[_saveOps removeObjectForKey:u];
		// tapped back meanwhile: what it shows is what the server has, so the newest call got its way (no alert)
		if (op.wanted == op.server) { [moot addObject:op]; continue; }
		[settled addObject:op];
		// back to the server's state: hearts, the Liked rows, the count
		NSNumber *back = op.serverKnown ? (op.server ? @YES : @NO) : op.before;
		if (back) _saved[u] = back;
		else [_saved removeObjectForKey:u];
		[changed addObject:u];
		if (op.countSeq == _librarySeq) delta += op.server ? 1 : -1;  // unless the server's count came in since
		if (op.server) { if (op.removedRow) [readd addObject:op]; }
		else [drop addObject:u];
	}
	if (_likedList && (drop.count || readd.count)) {
		ENTrackList *l = [_likedList listByRemovingURIs:drop];
		NSArray *ordered = [readd sortedArrayUsingComparator:^NSComparisonResult(ENSaveOp *a, ENSaveOp *b) {
			return a.removedIndex < b.removedIndex ? NSOrderedAscending : a.removedIndex > b.removedIndex ? NSOrderedDescending : NSOrderedSame;
		}];
		for (ENSaveOp *op in ordered) l = [l listByInsertingTrack:op.removedRow atIndex:op.removedIndex];
		[self setLikedPatch:l];
	}
	if (delta && _library.likedLength >= 0) [self setLibraryPatch:[_library libraryWithLikedLength:MAX(0, _library.likedLength + delta)]];
	if (changed.count) [self post:ENCatalogKindLiked info:@{ ENCatalogURIsKey: changed }];
	ENLog(@"like/unlike of %lu song(s) failed: %@", (unsigned long)uris.count, [ENCatalog logTextForError:e]);
	for (ENSaveOp *op in moot) for (ENSaveCall *c in op.calls) [c settle:nil];
	for (ENSaveOp *op in settled) for (ENSaveCall *c in op.calls) [c settle:e];
}

#pragma mark - 0.9: albums in Your Library (optimistic, DESIGN-0.9 §1)

// A 404 / 400 from a route new in gateway 0.9.0 while an older gateway runs says so (ENUpdateBridgeText, D8: one message for
// every old-bridge case, so `what` is no longer shown; instead of "Encore Bridge error 404.").
- (NSError *)errorWithJSON:(id)j status:(NSInteger)st error:(NSError *)err needs09:(NSString *)what {
	if ((st == 404 || st == 400) && _gatewayVersion && ENVersionBelow(_gatewayVersion, 0, 9, 0))
		return [NSError errorWithDomain:ENCatalogErrorDomain code:st userInfo:@{ ENCatalogErrorCodeKey: @"gateway_too_old",
			NSLocalizedDescriptionKey: ENUpdateBridgeL }];
	return [ENCatalog errorWithJSON:j status:st error:err];
}

- (NSNumber *)albumSavedStateForURI:(NSString *)uri {
	return ENJStr(uri) ? _albumSaved[uri] : nil;
}

- (void)checkAlbumSaved:(NSString *)uri done:(void (^)(void))done {
	void (^d)(void) = [done copy];
	if (!ENIsAlbumURI(uri)) {
		if (d) dispatch_async(dispatch_get_main_queue(), d);
		return;
	}
	NSMutableArray *waiting = _albumChecks[uri];
	if (waiting) {                         // one check per album at a time: this call joins it
		if (d) [waiting addObject:d];
		return;
	}
	waiting = [NSMutableArray array];
	if (d) [waiting addObject:d];
	_albumChecks[uri] = waiting;
	NSDate *sent = [NSDate date];
	NSString *path = [@"/v1/me/albums/contains?uris=" stringByAppendingString:[ENGateway escape:uri] ?: @""];
	[self beginRequest];
	[[ENGateway shared] fetchData:path etag:nil timeout:ENContainsTimeout completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		[self endRequest];
		dispatch_async(self->_parseQueue, ^{
			NSDictionary *items = st == 200 ? ENJDict(ENJDict(ENParseJSON(data))[@"items"]) : nil;
			dispatch_async(dispatch_get_main_queue(), ^{
				NSArray *blocks = self->_albumChecks[uri];
				[self->_albumChecks removeObjectForKey:uri];
				if (!items) ENLog(@"album saved-state check failed (%ld)", (long)st);
				else if ([self takeAlbumState:items[uri] uri:uri asked:sent]) [self post:ENCatalogKindAlbums info:@{ ENCatalogURIsKey: @[uri] }];
				for (void (^b)(void) in blocks) b();
			});
		});
	}];
}

// A contains answer (asked for at `asked`): taken unless our own save of that album is in flight or was answered after
// the check went out (the answer may predate it). YES when the state changed.
- (BOOL)takeAlbumState:(id)value uri:(NSString *)uri asked:(NSDate *)asked {
	if (!value || _albumOps[uri]) return NO;
	NSDate *w = _albumWroteAt[uri];
	if (w && [w compare:asked] != NSOrderedAscending) return NO;
	NSNumber *s = ENJInt(value, 0) == 1 ? @YES : @NO;
	if ([_albumSaved[uri] isEqual:s]) return NO;
	_albumSaved[uri] = s;
	return YES;
}

- (void)setAlbum:(NSString *)uri saved:(BOOL)saved done:(void (^)(NSError *error))done {
	void (^d)(NSError *) = [done copy];
	if (!ENIsAlbumURI(uri)) {
		NSError *e = [NSError errorWithDomain:ENCatalogErrorDomain code:400
		                             userInfo:@{ ENCatalogErrorCodeKey: @"bad_request", NSLocalizedDescriptionKey: ENL(@"Only albums can be added to Your Library here.") }];
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(e); });
		return;
	}
	ENAlbumOp *op = _albumOps[uri];
	if (!op) {
		op = [[ENAlbumOp alloc] init];
		op.uri = uri;
		op.before = _albumSaved[uri];
		op.server = op.before ? [op.before boolValue] : !saved;     // unknown: take it that this call changes it
		op.wanted = op.server;
		op.calls = [NSMutableArray array];
		_albumOps[uri] = op;
	}
	if (d) [op.calls addObject:d];
	if (op.wanted != saved) {              // at once: the heart
		op.wanted = saved;
		_albumSaved[uri] = saved ? @YES : @NO;
		[self post:ENCatalogKindAlbums info:@{ ENCatalogURIsKey: @[uri] }];
	}
	if (!op.inFlight) [self sendAlbum:op];
}

- (void)sendAlbum:(ENAlbumOp *)op {
	op.inFlight = YES;
	op.sent = op.wanted;
	NSDictionary *body = @{ @"uris": @[op.uri], @"saved": op.sent ? @YES : @NO };     // a JSON boolean, as for the likes
	[self beginRequest];
	[[ENGateway shared] sendMethod:@"POST" path:@"/v1/me/albums" json:body timeout:ENWriteTimeout completion:^(id j, NSInteger st, NSError *err) {
		[self endRequest];
		if (st == 200 && ENJDict(j)) [self album:op answered:j];
		else [self album:op failed:[self errorWithJSON:j status:st error:err needs09:@"to add albums to Your Library"]];
	}];
}

- (void)album:(ENAlbumOp *)op answered:(NSDictionary *)j {
	op.inFlight = NO;
	id v = ENJDict(j[@"items"])[op.uri];
	op.server = v ? ENJInt(v, 0) == 1 : op.sent;
	op.serverKnown = YES;
	NSDate *now = [NSDate date];
	_albumWroteAt[op.uri] = now;
	_albumsWroteAt = now;
	if (op.wanted != op.server) { [self sendAlbum:op]; return; }     // tapped again meanwhile: send the newest
	[_albumOps removeObjectForKey:op.uri];
	NSNumber *s = op.server ? @YES : @NO;
	BOOL changed = ![_albumSaved[op.uri] isEqual:s];
	_albumSaved[op.uri] = s;
	ENLog(@"album %@ Your Library", op.server ? @"added to" : @"removed from");
	if (changed) [self post:ENCatalogKindAlbums info:@{ ENCatalogURIsKey: @[op.uri] }];
	[self dropSavedAlbums];
	[self post:ENCatalogKindAlbums info:nil];                      // the list changed: Library reloads it
	for (void (^b)(NSError *) in op.calls) b(nil);
}

- (void)album:(ENAlbumOp *)op failed:(NSError *)e {
	op.inFlight = NO;
	[_albumOps removeObjectForKey:op.uri];
	// tapped back meanwhile: what the heart shows is what the server has, so the newest call got its way (no error)
	BOOL moot = op.wanted == op.server;
	if (!moot) {
		NSNumber *back = op.serverKnown ? (op.server ? @YES : @NO) : op.before;
		if (back) _albumSaved[op.uri] = back;
		else [_albumSaved removeObjectForKey:op.uri];
		[self post:ENCatalogKindAlbums info:@{ ENCatalogURIsKey: @[op.uri] }];
		ENLog(@"album add/remove failed: %@", [ENCatalog logTextForError:e]);
	}
	if (op.serverKnown) {                  // an earlier request of this op did land: the list changed all the same
		[self dropSavedAlbums];
		[self post:ENCatalogKindAlbums info:nil];
	}
	for (void (^b)(NSError *) in op.calls) b(moot ? nil : e);
}

// The saved albums list changed on the gateway: its memory copy goes, so the next loadSavedAlbums: delivers no old copy
// and asks without If-None-Match (the disk file stays until a new body replaces it; it isn't read again meanwhile).
- (void)dropSavedAlbums {
	ENCatalogRoute *r = _routes[@"my_albums"];
	if (!r) return;
	r.model = nil;
	r.etag = nil;
	r.diskTried = YES;
}

#pragma mark - add to playlist, new playlist (not optimistic, §6.5)

- (void)addTrackURIs:(NSArray *)uris toPlaylist:(ENPlaylist *)pl allowDuplicates:(BOOL)allowDuplicates
                done:(void (^)(ENPlaylist *updated, NSError *error))done {
	void (^d)(ENPlaylist *, NSError *) = [done copy];
	if (!ENValidID(pl.playlistID) || !ENJArr(uris).count) {
		NSError *e = [NSError errorWithDomain:ENCatalogErrorDomain code:400
		                             userInfo:@{ ENCatalogErrorCodeKey: @"bad_request", NSLocalizedDescriptionKey: ENL(@"Nothing to add.") }];
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(nil, e); });
		return;
	}
	NSDictionary *body = @{ @"op": @"add", @"uris": uris, @"allow_duplicates": allowDuplicates ? @YES : @NO };
	NSString *path = [NSString stringWithFormat:@"/v1/playlists/%@/items", pl.playlistID];
	[self beginRequest];
	[[ENGateway shared] sendMethod:@"POST" path:path json:body timeout:ENWriteTimeout completion:^(id j, NSInteger st, NSError *err) {
		[self endRequest];
		if (st != 200 || !ENJDict(j)) {
			NSError *e = [ENCatalog errorWithJSON:j status:st error:err];
			ENLog(@"add to playlist failed: %ld %@", (long)st, [ENCatalog codeOfError:e] ?: @"");
			if (d) d(nil, e);
			return;
		}
		ENPlaylist *upd = [ENPlaylist playlistWithJSON:ENJDict(j[@"playlist"]) meName:self->_library.rawMeName] ?: pl;
		ENLog(@"added %ld song(s) to a playlist (now %ld)", (long)ENJInt(j[@"added"], 0), (long)upd.length);
		if (self->_library) [self setLibraryPatch:[self->_library libraryByReplacingPlaylist:upd]];
		[self post:ENCatalogKindList info:@{ ENCatalogURIKey: upd.uri }];
		if (d) d(upd, nil);
	}];
}

// (0.9) the same request with op remove (the "Saved in" sheet's unticked playlists)
- (void)removeTrackURIs:(NSArray *)uris fromPlaylist:(ENPlaylist *)pl done:(void (^)(ENPlaylist *updated, NSError *error))done {
	void (^d)(ENPlaylist *, NSError *) = [done copy];
	if (!ENValidID(pl.playlistID) || !ENJArr(uris).count) {
		NSError *e = [NSError errorWithDomain:ENCatalogErrorDomain code:400
		                             userInfo:@{ ENCatalogErrorCodeKey: @"bad_request", NSLocalizedDescriptionKey: ENL(@"Nothing to remove.") }];
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(nil, e); });
		return;
	}
	NSDictionary *body = @{ @"op": @"remove", @"uris": uris };
	NSString *path = [NSString stringWithFormat:@"/v1/playlists/%@/items", pl.playlistID];
	[self beginRequest];
	[[ENGateway shared] sendMethod:@"POST" path:path json:body timeout:ENWriteTimeout completion:^(id j, NSInteger st, NSError *err) {
		[self endRequest];
		if (st != 200 || !ENJDict(j)) {
			NSError *e = [self errorWithJSON:j status:st error:err needs09:@"to remove songs from a playlist"];
			ENLog(@"remove from playlist failed: %ld %@", (long)st, [ENCatalog codeOfError:e] ?: @"");
			if (d) d(nil, e);
			return;
		}
		ENPlaylist *upd = [ENPlaylist playlistWithJSON:ENJDict(j[@"playlist"]) meName:self->_library.rawMeName] ?: pl;
		ENLog(@"removed %lu song(s) from a playlist (now %ld)", (unsigned long)uris.count, (long)upd.length);
		if (self->_library) [self setLibraryPatch:[self->_library libraryByReplacingPlaylist:upd]];
		[self post:ENCatalogKindList info:@{ ENCatalogURIKey: upd.uri ?: pl.uri }];
		if (d) d(upd, nil);
	}];
}

// (0.9) the "Saved in" sheet's checks; no cache, no joining (the sheet asks again itself while `pending` > 0)
- (void)loadPlaylistsContaining:(NSString *)trackURI done:(void (^)(NSDictionary *states, NSInteger pending, NSError *e))done {
	void (^d)(NSDictionary *, NSInteger, NSError *) = [done copy];
	if (![ENJStr(trackURI) hasPrefix:@"spotify:track:"] || !ENValidID(ENIDFromURI(trackURI))) {
		NSError *e = [NSError errorWithDomain:ENCatalogErrorDomain code:400
		                             userInfo:@{ ENCatalogErrorCodeKey: @"bad_request", NSLocalizedDescriptionKey: ENL(@"Only songs can be in a playlist.") }];
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(nil, 0, e); });
		return;
	}
	NSString *path = [@"/v1/playlists/containing?uri=" stringByAppendingString:[ENGateway escape:trackURI] ?: @""];
	[self beginRequest];
	[[ENGateway shared] fetchData:path etag:nil timeout:ENGetTimeout completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		[self endRequest];
		dispatch_async(self->_parseQueue, ^{
			id j = ENParseJSON(data);
			NSDictionary *items = st == 200 ? ENJDict(ENJDict(j)[@"items"]) : nil;
			NSMutableDictionary *states = nil;
			NSInteger pending = 0;
			NSError *e = nil;
			if (items) {
				states = [NSMutableDictionary dictionaryWithCapacity:items.count];
				for (id u in items) if (ENJStr(u)) states[u] = ENJInt(items[u], 0) == 1 ? @YES : @NO;
				pending = MAX(0, ENJInt(ENJDict(j)[@"pending"], 0));
			} else if (st == 200) {
				e = [NSError errorWithDomain:ENCatalogErrorDomain code:502
				                    userInfo:@{ ENCatalogErrorCodeKey: @"unreadable", NSLocalizedDescriptionKey: ENUnreadableText }];
			}
			dispatch_async(dispatch_get_main_queue(), ^{
				NSError *fail = e;
				if (!states && !fail) {
					fail = [self errorWithJSON:j status:st error:err needs09:@"to see which playlists have this song"];
					ENLog(@"playlist membership check failed: %ld %@", (long)st, [ENCatalog codeOfError:fail] ?: @"");
				}
				if (d) d(states, pending, fail);
			});
		});
	}];
}

#pragma mark - 0.9.4: dates added (DESIGN-DATE-ADDED)

// the revision of the catalog's copy of a playlist (nil: no copy yet, or it has none)
- (NSString *)listRevisionOfPlaylist:(NSString *)pid {
	id m = [(ENCatalogRoute *)_routes[[@"pl_" stringByAppendingString:pid]] model];
	return [m isKindOfClass:[ENTrackList class]] ? [(ENTrackList *)m revision] : nil;
}

// Still good for the list as the catalog has it now: not dropped since, and its copy is still at the revision they were asked
// for (or at the gateway's v); a playlist without a revision (Spotify's own) for 10 min. The gateway's saved copy: never.
- (BOOL)addedCurrent:(ENAddedEntry *)e playlist:(NSString *)pid {
	if (e.dropped || e.stale) return NO;
	if (!e.v && -[e.at timeIntervalSinceNow] > ENAddedTTL) return NO;
	NSString *cur = [self listRevisionOfPlaylist:pid];
	return !cur || ENSameTag(cur, e.listRev) || ENSameTag(cur, e.v);
}

// A kind list for uri (an event, our add / remove): its dates are asked for again before any use, and a request in flight
// may predate the change (later calls don't join it).
- (void)dropAddedDates:(NSString *)uri {
	NSString *pid = ENIDFromURI(ENJStr(uri));
	if (!pid) return;
	[(ENAddedEntry *)_addedDates[pid] setDropped:YES];
	[(ENAddedFlight *)_addedFlights[pid] setSuperseded:YES];
}

// Any thread: the gateway's items [[uri, ms], ...] -> @[uri, NSNumber ms] each; one per item whatever it holds (a missing uri
// becomes @"", a missing or bad date 0), so the positions stay the playlist's.
+ (NSArray *)addedEntriesFromItems:(NSArray *)items {
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:items.count];
	for (id it in items) {
		NSArray *a = ENJArr(it);
		NSString *u = a.count ? ENJStr(a[0]) : nil;
		id ms = a.count > 1 ? a[1] : nil;
		long long t = [ms isKindOfClass:[NSNumber class]] ? [(NSNumber *)ms longLongValue] : 0;
		[out addObject:@[ u ?: @"", @(MAX(0LL, t)) ]];
	}
	return [out copy];                     // (immutable: the entry's copy is this very object, so screens can compare them)
}

- (void)loadAddedDates:(NSString *)playlistURI done:(void (^)(NSArray *entries, NSError *error))done {
	void (^d)(NSArray *, NSError *) = [done copy];
	NSString *pid = ENIDFromURI(ENJStr(playlistURI));
	if (![ENJStr(playlistURI) hasPrefix:@"spotify:playlist:"] || !ENValidID(pid)) {
		NSError *e = [NSError errorWithDomain:ENCatalogErrorDomain code:400
		                             userInfo:@{ ENCatalogErrorCodeKey: @"bad_request", NSLocalizedDescriptionKey: ENL(@"Only playlists have dates added.") }];
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(nil, e); });
		return;
	}
	ENAddedEntry *have = _addedDates[pid];
	if (have && [self addedCurrent:have playlist:pid]) {
		NSArray *entries = have.entries;
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(entries, nil); });
		return;
	}
	ENAddedFlight *f = _addedFlights[pid];
	if (f && !f.superseded) {              // one request per playlist: this call joins it
		if (d) [f.waiters addObject:d];
		return;
	}
	f = [[ENAddedFlight alloc] init];
	f.waiters = [NSMutableArray array];
	if (d) [f.waiters addObject:d];
	_addedFlights[pid] = f;
	NSString *listRev = [self listRevisionOfPlaylist:pid];
	NSString *sent = have.etag;            // an older copy (dropped, or of another revision): a 304 says it still holds
	NSString *path = [NSString stringWithFormat:@"/v1/playlists/%@/added", pid];
	CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
	[self beginRequest];
	[[ENGateway shared] fetchData:path etag:sent timeout:ENAddedTimeout completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		[self endRequest];
		dispatch_async(self->_parseQueue, ^{
			id j = ENParseJSON(data);
			NSArray *items = st == 200 ? ENJArr(ENJDict(j)[@"items"]) : nil;
			NSArray *entries = items ? [ENCatalog addedEntriesFromItems:items] : nil;
			NSString *v = items ? ENJStr(ENJDict(j)[@"v"]) : nil;
			BOOL stale = items && ENJFlag(ENJDict(j)[@"stale"]);    // the gateway's saved copy: Spotify failed just now
			dispatch_async(dispatch_get_main_queue(), ^{
				// (no ids, no names)
				ENLog(@"catalog dates added: %ld, %lu entries in %.0f ms%@", (long)st, (unsigned long)entries.count,
					(CFAbsoluteTimeGetCurrent() - t0) * 1000, stale ? @" (saved copy)" : @"");
				NSError *fail = nil;
				if (!entries && st != 304) {
					NSString *code = ENJStr(ENJDict(ENJDict(j)[@"error"])[@"code"]);
					if (st == 200)
						fail = [NSError errorWithDomain:ENCatalogErrorDomain code:502
						                       userInfo:@{ ENCatalogErrorCodeKey: @"unreadable", NSLocalizedDescriptionKey: ENUnreadableText }];
					else if (st == 404 && [code isEqualToString:@"not_found"])     // a gateway from before the route
						fail = [NSError errorWithDomain:ENCatalogErrorDomain code:404 userInfo:@{ ENCatalogErrorCodeKey: @"gateway_too_old",
							NSLocalizedDescriptionKey: ENUpdateBridgeL }];
					else fail = [ENCatalog errorWithJSON:j status:st error:err];
				}
				[self addedAnswered:pid flight:f entries:entries v:v stale:stale etag:etag sent:sent listRev:listRev status:st error:fail];
			});
		});
	}];
}

- (void)addedAnswered:(NSString *)pid flight:(ENAddedFlight *)f entries:(NSArray *)entries v:(NSString *)v stale:(BOOL)stale
                 etag:(NSString *)etag sent:(NSString *)sent listRev:(NSString *)listRev status:(NSInteger)st error:(NSError *)fail {
	if (_addedFlights[pid] == f) [_addedFlights removeObjectForKey:pid];
	ENAddedEntry *e = _addedDates[pid];
	if (!fail && st == 304) {
		if (!e || !ENSameTag(e.etag, sent)) {
			// the copy it confirms went meanwhile (a memory warning): once more, without an ETag (the first call starts it)
			NSString *uri = [@"spotify:playlist:" stringByAppendingString:pid];
			for (void (^b)(NSArray *, NSError *) in f.waiters) [self loadAddedDates:uri done:b];
			return;
		}
		entries = e.entries;
		stale = e.stale;                   // (the same answer: a saved copy still is one)
		if (f.superseded && !e.dropped) e = nil;   // a later request (after the change) has confirmed them already
	} else if (!fail) {
		// a request that went out before the list changed doesn't replace what a later one brought (it is still delivered)
		if (f.superseded && e && !e.dropped) e = nil;
		else {
			e = [[ENAddedEntry alloc] init];
			e.entries = entries;
			e.v = v;
			e.etag = etag;
			e.stale = stale;
			_addedDates[pid] = e;
		}
	}
	if (!fail && e) {
		e.listRev = listRev;
		e.at = [NSDate date];
		e.dropped = f.superseded;          // may predate the change: asked again (a 304 then keeps them)
	}
	if (fail) ENLog(@"dates added failed: %ld %@", (long)st, [ENCatalog codeOfError:fail] ?: @"");
	// a saved copy comes with an error saying so (the screen sorts by it, says so, and asks again on a pull to refresh)
	NSError *saved = !fail && stale ? [NSError errorWithDomain:ENCatalogErrorDomain code:200 userInfo:@{ ENCatalogErrorCodeKey: @"saved_copy",
		NSLocalizedDescriptionKey: ENL(@"Showing a saved copy of when the songs were added.") }] : nil;
	for (void (^b)(NSArray *, NSError *) in f.waiters) b(fail ? nil : entries, fail ?: saved);
}

- (void)createPlaylistNamed:(NSString *)name trackURIs:(NSArray *)uris
                       done:(void (^)(ENPlaylist *created, NSString *addError, NSError *error))done {
	void (^d)(ENPlaylist *, NSString *, NSError *) = [done copy];
	NSDictionary *body = @{ @"name": ENJStr(name) ?: @"", @"uris": ENJArr(uris) ?: @[] };
	[self beginRequest];
	[[ENGateway shared] sendMethod:@"POST" path:@"/v1/playlists" json:body timeout:ENWriteTimeout completion:^(id j, NSInteger st, NSError *err) {
		[self endRequest];
		ENPlaylist *pl = st == 200 ? [ENPlaylist playlistWithJSON:ENJDict(ENJDict(j)[@"playlist"]) meName:self->_library.rawMeName] : nil;
		if (!pl) {
			NSError *e = st == 200 ? [NSError errorWithDomain:ENCatalogErrorDomain code:502
			                                         userInfo:@{ ENCatalogErrorCodeKey: @"unreadable", NSLocalizedDescriptionKey: ENUnreadableText }]
			                       : [ENCatalog errorWithJSON:j status:st error:err];
			ENLog(@"new playlist failed: %ld %@", (long)st, [ENCatalog codeOfError:e] ?: @"");
			if (d) d(nil, nil, e);
			return;
		}
		NSString *addError = ENJStr(ENJDict(j)[@"add_error"]);
		ENLog(@"new playlist made (%ld song(s))%@", (long)ENJInt(j[@"added"], 0), addError ? @", but the add failed" : @"");
		if (self->_library) [self setLibraryPatch:[self->_library libraryByInsertingPlaylist:pl]];
		if (d) d(pl, addError, nil);
	}];
}

#pragma mark - 0.11: other people's profiles (DESIGN-PROFILES §4.3)

// (any thread) a people route's error: a 404 not_found is a gateway from before the routes (the 0.9.4 pattern); 404
// user_not_found, 501 and 503 keep the gateway's message
+ (NSError *)profilesError:(NSError *)e {
	if (e.code == 404 && [[ENCatalog codeOfError:e] isEqualToString:@"not_found"])
		return [NSError errorWithDomain:ENCatalogErrorDomain code:404
		                       userInfo:@{ ENCatalogErrorCodeKey: @"gateway_too_old", NSLocalizedDescriptionKey: ENUpdateBridgeL }];
	return e;
}

// (main thread) after a people route's error: gateway_too_old turns profilesAvailable off until the next version answer
// (every entry point hides: kind user without a uri)
- (void)noteProfilesError:(NSError *)e {
	if (![[ENCatalog codeOfError:e] isEqualToString:@"gateway_too_old"] || _profilesMissing) return;
	BOOL was = self.profilesAvailable;
	_profilesMissing = YES;
	ENLog(@"profiles: the gateway has no profile routes (needs 0.10.0)");
	if (was) [self post:ENCatalogKindUser info:nil];
}

- (NSError *)peopleCallError:(NSString *)uri {
	if (!ENUserIDFromURI(uri))
		return [NSError errorWithDomain:ENCatalogErrorDomain code:400
		                       userInfo:@{ ENCatalogErrorCodeKey: @"bad_request", NSLocalizedDescriptionKey: ENNotProfileText }];
	if (!self.profilesAvailable)
		return [NSError errorWithDomain:ENCatalogErrorDomain code:404
		                       userInfo:@{ ENCatalogErrorCodeKey: @"gateway_too_old", NSLocalizedDescriptionKey: ENUpdateBridgeL }];
	return nil;
}

// The memory-only route of one of a person's pages: name <prefix>_<safe id><tail>, path /v1/users/<escaped id><pathTail>.
// nil (and done(error), async) for a uri that isn't a person's or while profiles aren't available.
- (ENCatalogRoute *)peopleRoute:(NSString *)prefix uri:(NSString *)uri tail:(NSString *)tail pathTail:(NSString *)pathTail
                           type:(ENRouteType)type done:(ENCatalogBlock)done {
	NSError *e = [self peopleCallError:uri];
	if (e) {
		if (done) dispatch_async(dispatch_get_main_queue(), ^{ done(nil, NO, e); });
		return nil;
	}
	NSString *uid = ENUserIDFromURI(uri);
	NSString *name = [NSString stringWithFormat:@"%@_%@%@", prefix, ENSafeUserID(uid), tail ?: @""];
	ENCatalogRoute *r = _routes[name];
	if (!r) {
		NSString *path = [NSString stringWithFormat:@"/v1/users/%@%@", [ENGateway escape:uid] ?: @"", pathTail ?: @""];
		r = [self routeNamed:name path:path type:type uri:ENUserKey(uri)];
		r.memoryOnly = YES;
		r.diskTried = YES;                 // nothing on disk to read: the first call asks the gateway at once
	}
	return r;
}

- (void)loadUser:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done {
	ENCatalogRoute *r = [self peopleRoute:@"user" uri:uri tail:nil pathTail:nil type:ENRouteUser done:done];
	if (r) [self load:r fresh:fresh poll:NO done:done];
}

- (void)loadUserPlaylists:(NSString *)uri offset:(NSInteger)offset fresh:(BOOL)fresh done:(ENCatalogBlock)done {
	NSInteger off = MAX(0, MIN(950, offset));
	off -= off % 50;
	ENCatalogRoute *r = [self peopleRoute:@"upl" uri:uri tail:[NSString stringWithFormat:@"_%ld", (long)off]
	                             pathTail:[NSString stringWithFormat:@"/playlists?offset=%ld", (long)off] type:ENRouteUserPlaylists done:done];
	if (r) [self load:r fresh:fresh poll:NO done:done];
}

- (void)loadFollowers:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done {
	ENCatalogRoute *r = [self peopleRoute:@"ufo" uri:uri tail:nil pathTail:@"/followers" type:ENRoutePeople done:done];
	if (r) [self load:r fresh:fresh poll:NO done:done];
}

- (void)loadFollowing:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done {
	ENCatalogRoute *r = [self peopleRoute:@"ufi" uri:uri tail:nil pathTail:@"/following" type:ENRoutePeople done:done];
	if (r) [self load:r fresh:fresh poll:NO done:done];
}

// a people route's memory copy goes (it changed on the gateway): the next load asks without an old copy
- (void)dropPeopleRoute:(NSString *)name {
	ENCatalogRoute *r = _routes[name];
	if (!r) return;
	r.model = nil;
	r.etag = nil;
	r.diskTried = YES;
}

#pragma mark - 0.11: people search (memory only, like -search:offset:done:)

- (void)searchUsers:(NSString *)q offset:(NSInteger)offset done:(ENCatalogBlock)done {
	NSString *t = [(ENJStr(q) ?: @"") stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	if (!t.length) { [self fail:done status:400 code:@"bad_request" message:ENL(@"Type something to search for.")]; return; }
	if (!self.profilesAvailable) { [self fail:done status:404 code:@"gateway_too_old" message:ENUpdateBridgeL]; return; }
	if (t.length > 100) {                  // never cut a surrogate pair in half
		unichar c = [t characterAtIndex:99];
		t = [t substringToIndex:(c >= 0xD800 && c <= 0xDBFF) ? 99 : 100];
	}
	NSInteger off = MAX(0, MIN(90, offset));
	off -= off % 10;
	NSString *key = [NSString stringWithFormat:@"%@|%ld", [t lowercaseString], (long)off];
	ENSearchEntry *hit = _userSearches[key];
	if (hit && -[hit.at timeIntervalSinceNow] < ENSearchTTL) {
		[_userSearchOrder removeObject:key];
		[_userSearchOrder addObject:key];
		id res = hit.result;
		if (done) dispatch_async(dispatch_get_main_queue(), ^{ done(res, YES, nil); });
		return;
	}
	NSMutableArray *ws = _userSearchWaiters[key];
	if (ws) { if (done) [ws addObject:[done copy]]; return; }
	ws = [NSMutableArray array];
	if (done) [ws addObject:[done copy]];
	_userSearchWaiters[key] = ws;
	NSString *path = [NSString stringWithFormat:@"/v1/search/users?q=%@&offset=%ld", [ENGateway escape:t] ?: @"", (long)off];
	CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
	[self beginRequest];
	[[ENGateway shared] fetchData:path etag:nil timeout:ENSearchTimeout completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		[self endRequest];
		dispatch_async(self->_parseQueue, ^{
			id j = ENParseJSON(data);
			ENRowList *res = st == 200 ? [ENRowList listWithJSON:j kind:ENRowListUsers] : nil;
			NSError *e = nil;
			if (!res) e = st == 200 ? [NSError errorWithDomain:ENCatalogErrorDomain code:502
			                                          userInfo:@{ ENCatalogErrorCodeKey: @"unreadable", NSLocalizedDescriptionKey: ENUnreadableText }]
			                        : [ENCatalog profilesError:[ENCatalog errorWithJSON:j status:st error:err]];
			dispatch_async(dispatch_get_main_queue(), ^{
				// (the status and the count only: never the query)
				ENLog(@"catalog people search: %ld, %lu found in %.0f ms", (long)st, (unsigned long)res.items.count,
					(CFAbsoluteTimeGetCurrent() - t0) * 1000);
				[self noteProfilesError:e];
				[self userSearch:key answered:res error:e];
			});
		});
	}];
}

- (void)userSearch:(NSString *)key answered:(ENRowList *)res error:(NSError *)e {
	NSArray *blocks = _userSearchWaiters[key];
	[_userSearchWaiters removeObjectForKey:key];
	if (res && !res.stale) {
		ENSearchEntry *entry = [[ENSearchEntry alloc] init];
		entry.result = res;
		entry.at = [NSDate date];
		_userSearches[key] = entry;
		[_userSearchOrder removeObject:key];
		[_userSearchOrder addObject:key];
		while (_userSearchOrder.count > ENSearchMax) {
			[_userSearches removeObjectForKey:_userSearchOrder[0]];
			[_userSearchOrder removeObjectAtIndex:0];
		}
	}
	for (ENCatalogBlock b in blocks) b(res, NO, e);
}

#pragma mark - 0.11: following people (optimistic, like the albums)

- (NSNumber *)followStateForUser:(NSString *)uri {
	NSString *key = ENUserKey(uri);
	return key ? _userFollow[key] : nil;
}

- (void)setUser:(NSString *)uri following:(BOOL)following done:(void (^)(NSError *error))done {
	void (^d)(NSError *) = [done copy];
	NSString *key = ENUserKey(uri);
	NSError *bad = [self peopleCallError:uri];
	if (bad || !key) {
		if (!bad) bad = [NSError errorWithDomain:ENCatalogErrorDomain code:400
		                                userInfo:@{ ENCatalogErrorCodeKey: @"bad_request", NSLocalizedDescriptionKey: ENNotProfileText }];
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(bad); });
		return;
	}
	ENFollowOp *op = _followOps[key];
	if (!op) {
		op = [[ENFollowOp alloc] init];
		op.uri = key;
		op.before = _userFollow[key];
		op.server = op.before ? [op.before boolValue] : !following;     // unknown: take it that this call changes it
		op.wanted = op.server;
		op.calls = [NSMutableArray array];
		_followOps[key] = op;
	}
	if (d) [op.calls addObject:d];
	if (op.wanted != following) {          // at once: the button and the count
		op.wanted = following;
		_userFollow[key] = following ? @YES : @NO;
		[self post:ENCatalogKindUser info:@{ ENCatalogURIKey: key }];
	}
	if (!op.inFlight) [self sendFollow:op];
}

- (void)sendFollow:(ENFollowOp *)op {
	op.inFlight = YES;
	op.sent = op.wanted;
	NSString *path = [NSString stringWithFormat:@"/v1/users/%@/follow", [ENGateway escape:ENUserIDFromURI(op.uri)] ?: @""];
	NSDictionary *body = @{ @"following": op.sent ? @YES : @NO };    // a JSON boolean, as for the likes
	[self beginRequest];
	[[ENGateway shared] sendMethod:@"POST" path:path json:body timeout:ENWriteTimeout completion:^(id j, NSInteger st, NSError *err) {
		[self endRequest];
		if (st == 200 && ENJDict(j)) {
			[self follow:op answered:j];
			return;
		}
		NSError *e = [ENCatalog profilesError:[ENCatalog errorWithJSON:j status:st error:err]];
		[self noteProfilesError:e];
		[self follow:op failed:e];
	}];
}

- (void)follow:(ENFollowOp *)op answered:(NSDictionary *)j {
	op.inFlight = NO;
	id f = j[@"f"];
	op.server = [f isKindOfClass:[NSNumber class]] ? [(NSNumber *)f integerValue] == 1 : op.sent;
	op.serverKnown = YES;
	if (op.wanted != op.server) { [self sendFollow:op]; return; }     // tapped again meanwhile: send the newest
	[_followOps removeObjectForKey:op.uri];
	_userFollow[op.uri] = op.server ? @YES : @NO;
	// the catalog's copy of that profile follows (opened again, it shows the new state at once); their followers list, my own
	// profile and my following list changed on the gateway: asked for again without an old copy
	NSString *safe = ENSafeUserID(ENUserIDFromURI(op.uri));
	ENCatalogRoute *r = _routes[[@"user_" stringByAppendingString:safe]];
	if ([r.model isKindOfClass:[ENUserProfile class]])
		r.model = [(ENUserProfile *)r.model profileWithFollowing:op.server followers:ENJInt(j[@"fol"], -1)];
	[self dropPeopleRoute:[@"ufo_" stringByAppendingString:safe]];
	NSString *me = ENJStr(_library.meID);
	if (me) {
		[self dropPeopleRoute:[@"user_" stringByAppendingString:ENSafeUserID(me)]];
		[self dropPeopleRoute:[@"ufi_" stringByAppendingString:ENSafeUserID(me)]];
	}
	ENLog(@"profiles: %@ a person", op.server ? @"followed" : @"unfollowed");
	[self post:ENCatalogKindUser info:@{ ENCatalogURIKey: op.uri }];
	for (void (^b)(NSError *) in op.calls) b(nil);
}

- (void)follow:(ENFollowOp *)op failed:(NSError *)e {
	op.inFlight = NO;
	[_followOps removeObjectForKey:op.uri];
	// tapped back meanwhile: what the button shows is what the server has, so the newest call got its way (no error)
	BOOL moot = op.wanted == op.server;
	NSNumber *back = op.serverKnown ? (op.server ? @YES : @NO) : op.before;
	NSNumber *now = _userFollow[op.uri];
	if (back) _userFollow[op.uri] = back;
	else [_userFollow removeObjectForKey:op.uri];
	if (!((now == back) || [now isEqual:back])) [self post:ENCatalogKindUser info:@{ ENCatalogURIKey: op.uri }];
	if (!moot) ENLog(@"profiles: follow / unfollow failed: %ld %@", (long)e.code, [ENCatalog codeOfError:e] ?: @"");
	for (void (^b)(NSError *) in op.calls) b(moot ? nil : e);
}

#pragma mark - 0.11: saving someone else's playlist (optimistic, like the albums)

- (NSNumber *)playlistSavedStateForURI:(NSString *)uri {
	if (!ENJStr(uri)) return nil;
	ENFollowOp *op = _plSaveOps[uri];
	if (op) return op.wanted ? @YES : @NO;
	NSDate *at = _plSavedAt[uri];
	if (at && -[at timeIntervalSinceNow] < ENPlaylistSaveHold && _plSaved[uri]) return _plSaved[uri];
	if (!_library) return nil;
	return [_library playlistForURI:uri] ? @YES : @NO;
}

- (void)setPlaylist:(ENPlaylist *)pl saved:(BOOL)saved done:(void (^)(NSError *error))done {
	void (^d)(NSError *) = [done copy];
	NSString *uri = pl.uri;
	NSError *bad = nil;
	if (![uri hasPrefix:@"spotify:playlist:"] || !ENValidID(pl.playlistID))
		bad = [NSError errorWithDomain:ENCatalogErrorDomain code:400 userInfo:@{ ENCatalogErrorCodeKey: @"bad_request",
			NSLocalizedDescriptionKey: ENL(@"Only playlists (spotify:playlist:…) can be saved here.") }];
	else if (!self.profilesAvailable)
		bad = [NSError errorWithDomain:ENCatalogErrorDomain code:404
		                      userInfo:@{ ENCatalogErrorCodeKey: @"gateway_too_old", NSLocalizedDescriptionKey: ENUpdateBridgeL }];
	if (bad) {
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(bad); });
		return;
	}
	ENFollowOp *op = _plSaveOps[uri];
	if (!op) {
		op = [[ENFollowOp alloc] init];
		op.uri = uri;
		op.before = [self playlistSavedStateForURI:uri];
		op.server = op.before ? [op.before boolValue] : !saved;         // unknown: take it that this call changes it
		op.wanted = op.server;
		op.calls = [NSMutableArray array];
		_plSaveOps[uri] = op;
	}
	if (d) [op.calls addObject:d];
	if (op.wanted != saved) {              // at once: the bar button (it follows kind library)
		op.wanted = saved;
		[self post:ENCatalogKindLibrary info:nil];
	}
	if (!op.inFlight) [self sendPlaylistSave:op];
}

- (void)sendPlaylistSave:(ENFollowOp *)op {
	op.inFlight = YES;
	op.sent = op.wanted;
	NSDictionary *body = @{ @"uri": op.uri, @"saved": op.sent ? @YES : @NO };
	[self beginRequest];
	[[ENGateway shared] sendMethod:@"POST" path:@"/v1/me/playlists" json:body timeout:ENWriteTimeout completion:^(id j, NSInteger st, NSError *err) {
		[self endRequest];
		if (st == 200 && ENJDict(j)) {
			[self playlistSave:op answered:j];
			return;
		}
		NSError *e = [ENCatalog profilesError:[ENCatalog errorWithJSON:j status:st error:err]];
		[self noteProfilesError:e];
		[self playlistSave:op failed:e];
	}];
}

- (void)playlistSave:(ENFollowOp *)op answered:(NSDictionary *)j {
	op.inFlight = NO;
	id v = j[@"saved"];
	op.server = [v isKindOfClass:[NSNumber class]] ? [(NSNumber *)v integerValue] == 1 : op.sent;
	op.serverKnown = YES;
	_plSaved[op.uri] = op.server ? @YES : @NO;
	_plSavedAt[op.uri] = [NSDate date];
	if (op.wanted != op.server) { [self sendPlaylistSave:op]; return; }     // tapped again meanwhile: send the newest
	[_plSaveOps removeObjectForKey:op.uri];
	ENLog(@"profiles: a playlist %@ Your Library", op.server ? @"added to" : @"removed from");
	[self post:ENCatalogKindLibrary info:nil];
	[self revalidateLibrary];              // (the gateway's rebuild also pushes `playlists`)
	for (void (^b)(NSError *) in op.calls) b(nil);
}

- (void)playlistSave:(ENFollowOp *)op failed:(NSError *)e {
	op.inFlight = NO;
	[_plSaveOps removeObjectForKey:op.uri];
	BOOL moot = op.wanted == op.server;    // tapped back meanwhile: the newest call got its way (no error)
	if (op.serverKnown) {                  // an earlier request of this op did land: the library changed all the same
		_plSaved[op.uri] = op.server ? @YES : @NO;
		_plSavedAt[op.uri] = [NSDate date];
		[self revalidateLibrary];
	}
	if (e.code == 501 && _canSavePlaylists) {      // the gateway turned the capability off: every page's button goes
		_canSavePlaylists = NO;
		[self post:ENCatalogKindUser info:nil];
	}
	[self post:ENCatalogKindLibrary info:nil];     // back to the server's state
	if (!moot) ENLog(@"profiles: playlist save failed: %ld %@", (long)e.code, [ENCatalog codeOfError:e] ?: @"");
	for (void (^b)(NSError *) in op.calls) b(moot ? nil : e);
}

#pragma mark - gateway events (from ENPlayback)

- (void)listChanged:(NSString *)uri active:(BOOL)active {
	if (active) [self post:ENCatalogKindList info:@{ ENCatalogURIKey: uri }];
	else {
		[self dropAddedDates:uri];         // (0.9.4) at once: the kind list itself waits for the next activation
		[_staleLists addObject:uri];
	}
}

- (void)handleEvent:(NSDictionary *)event {
	NSString *type = ENJStr(ENJDict(event)[@"type"]);
	NSDictionary *d = ENJDict(event[@"data"]);
	BOOL active = [UIApplication sharedApplication].applicationState == UIApplicationStateActive;
	if ([type isEqualToString:@"playlists"]) {                 // the library body changed on the gateway
		if (active) [self revalidateLibrary];
		else _libraryStale = YES;
	} else if ([type isEqualToString:@"playlist"]) {           // a listing changed (our add, or a new revision)
		NSString *u = ENJStr(d[@"u"]);
		if (!u) return;
		NSInteger len = ENJInt(d[@"len"], -1);
		ENPlaylist *p = [_library playlistForURI:u];
		if (p && len >= 0 && p.length != len) [self setLibraryPatch:[_library libraryByReplacingPlaylist:[p playlistWithLength:len]]];
		[self listChanged:u active:active];
	} else if ([type isEqualToString:@"liked"]) {              // likes (ours, or the current-song check found a change)
		NSMutableDictionary *states = [NSMutableDictionary dictionary];
		NSMutableSet *gone = [NSMutableSet set];
		BOOL elsewhere = NO;                                   // a change we didn't make: the Liked list is read again
		for (id it in ENJArr(d[@"items"])) {
			NSString *u = ENJStr(ENJDict(it)[@"u"]);
			if (!u || _saveOps[u]) continue;                    // (our own write, still in flight)
			BOOL s = ENJInt(it[@"s"], 0) == 1;
			// the echo of our own write (answered just now, the same state): .likedList already has it
			NSDate *w = _wroteAt[u];
			if (!(w && -[w timeIntervalSinceNow] < ENWriteEcho && [_saved[u] isEqual:(s ? @YES : @NO)])) elsewhere = YES;
			states[u] = s ? @1 : @0;
			if (!s) [gone addObject:u];
		}
		NSMutableArray *changed = [NSMutableArray arrayWithArray:[self applyStates:states]];
		if (gone.count && _likedList) {
			ENTrackList *l = [_likedList listByRemovingURIs:gone];
			if (l != _likedList) {
				[self setLikedPatch:l];
				if (!changed.count) [changed addObjectsFromArray:[gone allObjects]];
			}
		}
		NSInteger len = ENJInt(d[@"len"], -1);
		if (len >= 0 && !_saveOps.count && _library && _library.likedLength != len) {
			_librarySeq++;
			[self setLibraryPatch:[_library libraryWithLikedLength:len]];
		}
		if (changed.count) [self post:ENCatalogKindLiked info:@{ ENCatalogURIsKey: changed }];
		if (elsewhere) [self listChanged:ENLikedListURI active:active];
	} else if ([type isEqualToString:@"albums"]) {             // (0.9) Your Library's albums changed on the gateway
		// the echo of our own save (still in flight, or answered just now): its state and the list reload are done already
		if (_albumOps.count || (_albumsWroteAt && -[_albumsWroteAt timeIntervalSinceNow] < ENWriteEcho)) return;
		// a change made elsewhere (another phone): the states we know may be wrong now; a page on screen checks its own again
		[_albumSaved removeAllObjects];
		[self dropSavedAlbums];
		if (active) [self post:ENCatalogKindAlbums info:nil];
		else _albumsStale = YES;
	} else if ([type isEqualToString:@"reset"]) {            // the gateway restarted
		// perhaps as another version (a deploy): ask again now, so ENJam's `available` and jamSocialState follow it
		_versionStale = YES;
		[self checkVersion];
		if (active) {
			[self post:ENCatalogKindReset info:nil];
			[self revalidateLibrary];
		} else {
			_resetPending = YES;
			_libraryStale = YES;
		}
	}
}

#pragma mark - errors

+ (NSError *)errorWithJSON:(id)json status:(NSInteger)status error:(NSError *)err {
	NSDictionary *e = ENJDict(ENJDict(json)[@"error"]);
	NSInteger code = err ? 0 : status;
	NSMutableDictionary *ui = [NSMutableDictionary dictionary];
	NSString *c = ENJStr(e[@"code"]);
	if (c) ui[ENCatalogErrorCodeKey] = c;
	id ra = e[@"retry_after"];
	if ([ra isKindOfClass:[NSNumber class]] && [(NSNumber *)ra doubleValue] > 0) ui[ENCatalogRetryAfterKey] = ra;
	NSArray *uris = ENJArr(e[@"uris"]);
	if (uris) ui[ENCatalogErrorURIsKey] = uris;
	if (err) ui[NSUnderlyingErrorKey] = err;
	NSString *m = ENJStr(e[@"message"]);
	ui[NSLocalizedDescriptionKey] = code == 0 ? ENNoGatewayText : code == 401 ? ENUnpairText
		: (m ?: [NSString stringWithFormat:ENL(@"Encore Bridge error %ld."), (long)code]);
	return [NSError errorWithDomain:ENCatalogErrorDomain code:code userInfo:ui];
}

+ (NSString *)messageForError:(NSError *)error {
	if (!error) return nil;
	if (![error.domain isEqualToString:ENCatalogErrorDomain]) return error.localizedDescription ?: ENL(@"Something went wrong.");
	if (error.code == 401) return ENUnpairText;
	if (error.code == 0) return ENNoGatewayText;
	if (error.code == 404 && [ENCatalog shared].gatewayTooOld) return ENUpdateBridgeL;
	NSString *m = ENJStr(error.userInfo[NSLocalizedDescriptionKey]);
	// (R2a) a bridge text that names a person, a device or a playlist: the app's own words while Anonymous Mode is on
	if (m) m = [ENAnon bridgeText:m code:ENJStr(error.userInfo[ENCatalogErrorCodeKey])];
	return m ?: [NSString stringWithFormat:ENL(@"Encore Bridge error %ld."), (long)error.code];
}

+ (NSString *)logTextForError:(NSError *)error {
	if (!error) return @"";
	if (![error.domain isEqualToString:ENCatalogErrorDomain]) return [NSString stringWithFormat:@"%@ %ld", error.domain, (long)error.code];
	NSString *code = ENJStr(error.userInfo[ENCatalogErrorCodeKey]);
	return code ? [NSString stringWithFormat:@"%ld %@", (long)error.code, code] : [NSString stringWithFormat:@"%ld", (long)error.code];
}

+ (NSString *)codeOfError:(NSError *)error {
	if (![error.domain isEqualToString:ENCatalogErrorDomain]) return nil;
	return ENJStr(error.userInfo[ENCatalogErrorCodeKey]);
}

+ (NSTimeInterval)retryAfterOfError:(NSError *)error {
	if (![error.domain isEqualToString:ENCatalogErrorDomain]) return 0;
	id ra = error.userInfo[ENCatalogRetryAfterKey];
	return [ra isKindOfClass:[NSNumber class]] ? MAX(0.0, [(NSNumber *)ra doubleValue]) : 0;
}

@end

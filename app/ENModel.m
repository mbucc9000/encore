#import "ENModel.h"
#import "ENUtil.h"
#import "ENAnon.h"
#import "ENCatalog.h"
#import "ENJam.h"

// Immutable model objects (see ENModel.h). Built on ENCatalog's parse queue: nothing here may touch UIKit or shared state.
// The ...With... / ...By... copies build a new object field by field (ivars of the same class), never change one in place.
// (R2a) The [anon] getters run where the value is shown (the main thread); they read ENAnon (any thread) and, on the main
// thread only, the catalog's library and ENJam's title.

static NSArray *ENStringArray(id v) {          // an array of non-empty strings, nil if none
	NSArray *a = ENJArr(v);
	if (!a.count) return nil;
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:a.count];
	for (id x in a) if (ENJStr(x)) [out addObject:x];
	return out.count ? [out copy] : nil;
}

static NSString *ENJoin(NSString *a, NSString *b) {   // "a · b", or whichever part exists
	if (a.length && b.length) return [NSString stringWithFormat:@"%@ · %@", a, b];
	return a.length ? a : (b.length ? b : @"");
}

// ---------------------------------------------------------------------------------------------------------------- 0.11 user ids

// the gateway's rule for a user id (DESIGN-PROFILES §2.2): ^[^\s/\\:?#%]{1,64}$ after decoding
static BOOL ENValidUserID(NSString *s) {
	if (![s isKindOfClass:[NSString class]] || s.length < 1 || s.length > 64) return NO;
	if ([s rangeOfCharacterFromSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].location != NSNotFound) return NO;
	for (NSUInteger i = 0; i < s.length; i++) {
		unichar c = [s characterAtIndex:i];
		if (c == '/' || c == '\\' || c == ':' || c == '?' || c == '#' || c == '%') return NO;
	}
	return YES;
}

NSString *ENUserIDFromURI(NSString *uri) {
	NSString *u = ENJStr(uri);
	static NSString *const prefix = @"spotify:user:";
	if (![u hasPrefix:prefix] || u.length == prefix.length) return nil;
	NSString *rest = [u substringFromIndex:prefix.length];
	if ([rest rangeOfString:@":"].location != NSNotFound) return nil;      // spotify:user:<x>:collection and the like
	NSString *dec = [rest stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];     // nil for a broken escape
	return ENValidUserID(dec) ? dec : nil;
}

NSString *ENUserURIFromID(NSString *userID) {
	if (!ENValidUserID(userID)) return nil;
	NSString *esc = (__bridge_transfer NSString *)CFURLCreateStringByAddingPercentEscapes(NULL, (__bridge CFStringRef)userID, NULL,
		CFSTR("!*'();:@&=+$,/?%#[]\" <>{}|\\^`"), kCFStringEncodingUTF8);
	return esc.length ? [@"spotify:user:" stringByAppendingString:esc] : nil;
}

NSString *ENUserURIFromLink(NSString *text) {
	NSString *t = [ENJStr(text) stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	if (!t.length) return nil;
	static NSRegularExpression *web, *uri;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		web = [NSRegularExpression regularExpressionWithPattern:@"^(?:https?://)?open\\.spotify\\.com/(?:intl-[A-Za-z-]+/)?user/([^/?#\\s]+)"
		                                                options:NSRegularExpressionCaseInsensitive error:NULL];
		uri = [NSRegularExpression regularExpressionWithPattern:@"^spotify:user:([^:\\s]+)$" options:NSRegularExpressionCaseInsensitive error:NULL];
	});
	NSRange all = NSMakeRange(0, t.length);
	NSTextCheckingResult *m = [web firstMatchInString:t options:0 range:all] ?: [uri firstMatchInString:t options:0 range:all];
	if (!m || [m rangeAtIndex:1].location == NSNotFound) return nil;      // (both patterns have exactly one group)
	NSString *u = [@"spotify:user:" stringByAppendingString:[t substringWithRange:[m rangeAtIndex:1]]];
	return ENUserIDFromURI(u) ? u : nil;
}

// ---------------------------------------------------------------------------------------------------------------- PL
@implementation ENPlaylist {
	NSString *_meName;                         // for the "Made for" / "by <me>" lines when the subline is rebuilt
}

// (R2a) the [anon] getters below are our own: their ivars are named here
@synthesize name = _name, image = _image, owner = _owner, folder = _folder, desc = _desc, subline = _subline, linkLine = _linkLine;

// (R2a) a Blend (D2: its name and cover show people): the bridge's flag, else Spotify's own (not Made For You) named
// "A + B" or described as a blend
static BOOL ENLooksLikeBlend(ENPlaylist *p, NSDictionary *j) {
	if (ENJFlag(j[@"bl"])) return YES;
	if (p->_madeForMe) return NO;
	BOOL spotify = [p->_ownerURI isEqualToString:@"spotify:user:spotify"] || (!p->_ownerURI && [p->_owner isEqualToString:@"Spotify"]);
	if (!spotify) return NO;
	if (p->_name && [p->_name rangeOfString:@" + "].location != NSNotFound) return YES;
	return p->_desc && [p->_desc rangeOfString:@"blend" options:NSCaseInsensitiveSearch].location != NSNotFound;
}

+ (instancetype)playlistWithJSON:(NSDictionary *)j meName:(NSString *)meName {
	j = ENJDict(j);
	NSString *u = ENJStr(j[@"u"]);
	if (!u) return nil;
	ENPlaylist *p = [[ENPlaylist alloc] init];
	p->_uri = [u copy];
	p->_playlistID = [ENIDFromURI(u) copy];
	p->_name = [ENJStr(j[@"n"]) copy];
	p->_image = [ENJStr(j[@"i"]) copy];
	p->_owner = [ENJStr(j[@"o"]) copy];
	p->_own = ENJFlag(j[@"own"]);
	p->_editable = ENJFlag(j[@"ed"]);
	p->_collaborative = ENJFlag(j[@"c"]);
	p->_madeForMe = ENJFlag(j[@"mf"]);
	p->_length = ENJInt(j[@"len"], -1);
	if (p->_length < -1) p->_length = -1;
	p->_folder = ENStringArray(j[@"f"]);
	p->_revision = [ENJStr(j[@"v"]) copy];
	p->_desc = [ENJStr(j[@"d"]) copy];
	p->_ownerURI = [ENJStr(j[@"ou"]) copy];             // (0.11) gateway 0.10.0
	p->_followers = ENJInt(j[@"fol"], -1);
	if (p->_followers < -1) p->_followers = -1;
	p->_customCover = ENJFlag(j[@"ugc"]);              // (R2a) the bridge's flags (R2b); absent = NO
	p->_blend = ENLooksLikeBlend(p, j);
	p->_meName = [ENJStr(meName) copy];
	[p buildLines];
	return p;
}

#pragma mark - (R2a) Anonymous Mode: what the rows show (ENAnon.h)

- (NSString *)rawName { return _name; }
- (NSString *)rawOwner { return _owner; }
- (NSString *)rawImage { return _image; }

- (BOOL)spotifyOwned {
	return [_ownerURI isEqualToString:@"spotify:user:spotify"] || (!_ownerURI && [_owner isEqualToString:@"Spotify"]);
}

- (NSString *)name {
	if (!_name || ![ENAnon on]) return _name;
	if (_blend) return @"Blend";
	if ([ENAnon hidesPlaylists] && [ENAnon isMyPlaylist:self]) return [ENAnon myPlaylistTitleForURI:_uri];
	return _name;
}

- (NSString *)owner {
	if (!_owner || ![ENAnon on] || [self spotifyOwned]) return _owner;
	if (_own || (_ownerURI && [ENAnon isMe:_ownerURI])) return @"You";
	return [ENAnon nameForUser:_ownerURI fallbackName:_owner];
}

- (NSString *)image {
	if (!_image || ![ENAnon on]) return _image;
	if (_blend) return nil;
	if (_customCover && [ENAnon hidesPlaylists] && [ENAnon isMyPlaylist:self]) return nil;
	return _image;
}

- (NSArray *)folder { return [ENAnon hidesPlaylists] ? nil : _folder; }

- (NSString *)desc {
	if (!_desc || ![ENAnon on]) return _desc;
	if (_blend) return nil;
	if ([ENAnon isMyPlaylist:self]) return [ENAnon hidesPlaylists] ? nil : _desc;
	return [self spotifyOwned] ? _desc : nil;          // other people's descriptions can name people
}

// the "who" part of both lines, masked: "Made for you", "Collaborative" (the sub-line only), "by you", "by <masked owner>"
- (NSString *)anonWho:(BOOL)subline {
	if (_madeForMe) return @"Made for you";
	if (subline && _collaborative) return @"Collaborative";
	if (_own) return @"by you";
	NSString *o = self.owner;
	if (!o) return nil;
	return [o isEqualToString:@"You"] ? @"by you" : [@"by " stringByAppendingString:o];
}

- (NSString *)subline {
	if (![ENAnon on]) return _subline;
	return ENJoin([self anonWho:YES], _length >= 0 ? ENCountText(_length, @"song", @"songs") : nil);
}

- (NSString *)linkLine {
	if (![ENAnon on]) return _linkLine;
	return [self anonWho:NO];
}

- (void)buildLines {
	NSString *me = _meName ?: @"you";
	NSString *who = nil;
	if (_madeForMe) who = [@"Made for " stringByAppendingString:me];
	else if (_collaborative) who = @"Collaborative";
	else if (_own) who = [@"by " stringByAppendingString:me];
	else if (_owner) who = [@"by " stringByAppendingString:_owner];
	_subline = ENJoin(who, _length >= 0 ? ENCountText(_length, @"song", @"songs") : nil);
	if (_madeForMe) _linkLine = [@"Made for " stringByAppendingString:me];
	else if (_own) _linkLine = [@"by " stringByAppendingString:me];
	else if (_owner) _linkLine = [@"by " stringByAppendingString:_owner];
	else _linkLine = nil;
}

- (instancetype)playlistWithLength:(NSInteger)length {
	ENPlaylist *p = [[ENPlaylist alloc] init];
	p->_uri = _uri;
	p->_playlistID = _playlistID;
	p->_name = _name;
	p->_image = _image;
	p->_owner = _owner;
	p->_own = _own;
	p->_editable = _editable;
	p->_collaborative = _collaborative;
	p->_madeForMe = _madeForMe;
	p->_length = length < 0 ? -1 : length;
	p->_folder = _folder;
	p->_revision = _revision;
	p->_desc = _desc;
	p->_ownerURI = _ownerURI;
	p->_followers = _followers;
	p->_customCover = _customCover;
	p->_blend = _blend;
	p->_meName = _meName;
	[p buildLines];
	return p;
}

- (NSString *)description { return [NSString stringWithFormat:@"<ENPlaylist %@ \"%@\" %ld>", _uri, _name, (long)_length]; }

@end

// ---------------------------------------------------------------------------------------------------------------- TR
@interface ENTrack ()
// image = the cover for a row without i (album-page rows: the album's, from h.i)
+ (instancetype)trackWithJSON:(NSDictionary *)j defaultImage:(NSString *)image;
@end

@implementation ENTrack

+ (instancetype)trackWithJSON:(NSDictionary *)j { return [self trackWithJSON:j defaultImage:nil]; }

+ (instancetype)trackWithJSON:(NSDictionary *)j defaultImage:(NSString *)image {
	j = ENJDict(j);
	NSString *u = ENJStr(j[@"u"]);
	if (!u) return nil;
	ENTrack *t = [[ENTrack alloc] init];
	t->_uri = [u copy];
	t->_name = [ENJStr(j[@"n"]) copy];
	t->_artists = [ENJStr(j[@"a"]) copy];
	NSRange r = t->_artists ? [t->_artists rangeOfString:@", "] : NSMakeRange(NSNotFound, 0);
	t->_artistName = r.location == NSNotFound ? t->_artists : [t->_artists substringToIndex:r.location];
	t->_artistURI = [ENJStr(j[@"ar"]) copy];
	t->_album = [ENJStr(j[@"al"]) copy];
	t->_albumURI = [ENJStr(j[@"alu"]) copy];
	t->_image = [(ENJStr(j[@"i"]) ?: ENJStr(image)) copy];
	t->_durationMs = MAX(0, ENJInt(j[@"d"], 0));
	t->_explicitSong = ENJFlag(j[@"e"]);
	t->_trackNumber = MAX(0, ENJInt(j[@"tn"], 0));
	t->_discNumber = MAX(0, ENJInt(j[@"dn"], 0));
	t->_loading = ENJFlag(j[@"x"]);
	t->_unavailable = ENJFlag(j[@"un"]);
	t->_uid = [ENJStr(j[@"uid"]) copy];                 // 0.6 QR keys (Up Next)
	t->_byMemberID = [ENJStr(j[@"by"]) copy];
	long long pa = ENJLong(j[@"pa"], 0);                // 0.7 recently played
	if (pa > 0) t->_playedAt = [NSDate dateWithTimeIntervalSince1970:pa / 1000.0];
	[t buildLines];
	return t;
}

+ (instancetype)trackWithPlaybackTrack:(NSDictionary *)d {
	d = ENJDict(d);
	NSString *u = ENJStr(d[@"context_track_uri"]) ?: ENJStr(d[@"uri"]);
	if (!u) return nil;
	ENTrack *t = [[ENTrack alloc] init];
	t->_uri = [u copy];
	t->_name = [ENJStr(d[@"name"]) copy];
	NSArray *artists = ENStringArray(d[@"artists"]);
	t->_artists = artists.count ? [artists componentsJoinedByString:@", "] : nil;
	t->_artistName = artists.count ? artists[0] : nil;
	NSArray *aus = ENStringArray(d[@"artist_uris"]);
	t->_artistURI = aus.count ? aus[0] : nil;
	t->_album = [ENJStr(d[@"album"]) copy];
	t->_albumURI = [ENJStr(d[@"album_uri"]) copy];
	t->_image = [ENJStr(d[@"img"]) copy];
	t->_durationMs = MAX(0, ENJInt(d[@"duration_ms"], 0));
	[t buildLines];
	return t;
}

- (void)buildLines {
	_subline = _artists ?: @"";
	_timeText = _durationMs > 0 ? ENTimeText(_durationMs) : @"";
	NSMutableArray *parts = [NSMutableArray arrayWithCapacity:3];
	if (_name) [parts addObject:_name];
	if (_artists) [parts addObject:_artists];
	if (_album) [parts addObject:_album];
	_filterKey = [[parts componentsJoinedByString:@" "] lowercaseString];
	// the gateway's songKey (player.js): name + whole seconds, Math.round
	_songKey = [NSString stringWithFormat:@"%@|%ld", _name ?: @"", (long)floor(_durationMs / 1000.0 + 0.5)];
}

- (BOOL)playable { return !_loading && !_unavailable; }

- (NSDictionary *)rowJSON {
	NSMutableDictionary *r = [NSMutableDictionary dictionaryWithCapacity:9];
	r[@"u"] = _uri;
	if (_name) r[@"n"] = _name;
	if (_artists) r[@"a"] = _artists;
	if (_artistURI) r[@"ar"] = _artistURI;
	if (_album) r[@"al"] = _album;
	if (_albumURI) r[@"alu"] = _albumURI;
	if (_image) r[@"i"] = _image;
	if (_durationMs > 0) r[@"d"] = @(_durationMs);
	if (_explicitSong) r[@"e"] = @1;
	return r;
}

- (NSString *)description { return [NSString stringWithFormat:@"<ENTrack %@ \"%@\">", _uri, _name]; }

@end

// ---------------------------------------------------------------------------------------------------------------- AL / AR
@implementation ENAlbumRow

+ (instancetype)albumWithJSON:(NSDictionary *)j {
	j = ENJDict(j);
	NSString *u = ENJStr(j[@"u"]);
	if (!u) return nil;
	ENAlbumRow *a = [[ENAlbumRow alloc] init];
	a->_uri = [u copy];
	a->_name = [ENJStr(j[@"n"]) copy];
	a->_image = [ENJStr(j[@"i"]) copy];
	a->_artist = [ENJStr(j[@"ar"]) copy];
	a->_artistURI = [ENJStr(j[@"aru"]) copy];
	a->_year = MAX(0, ENJInt(j[@"y"], 0));
	a->_type = [ENJStr(j[@"t"]) copy];
	a->_copyright = [ENJStr(j[@"cp"]) copy];
	a->_length = ENJInt(j[@"len"], -1);
	if (a->_length < -1) a->_length = -1;
	a->_yearText = a->_year > 0 ? [NSString stringWithFormat:@"%ld", (long)a->_year] : @"";
	a->_artistYearText = ENJoin(a->_artist, a->_yearText);
	return a;
}

@end

@implementation ENArtistRow

+ (instancetype)artistWithJSON:(NSDictionary *)j {
	j = ENJDict(j);
	NSString *u = ENJStr(j[@"u"]);
	if (!u) return nil;
	ENArtistRow *a = [[ENArtistRow alloc] init];
	a->_uri = [u copy];
	a->_name = [ENJStr(j[@"n"]) copy];
	a->_image = [ENJStr(j[@"i"]) copy];
	return a;
}

@end

static NSArray *ENTracks(id v, NSString *image) {     // image: for rows without i (album pages)
	NSArray *items = ENJArr(v);
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:items.count];
	for (id x in items) { ENTrack *t = [ENTrack trackWithJSON:x defaultImage:image]; if (t) [out addObject:t]; }
	return [out copy];
}

static NSArray *ENAlbums(id v) {
	NSArray *items = ENJArr(v);
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:items.count];
	for (id x in items) { ENAlbumRow *a = [ENAlbumRow albumWithJSON:x]; if (a) [out addObject:a]; }
	return [out copy];
}

static NSArray *ENArtists(id v) {
	NSArray *items = ENJArr(v);
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:items.count];
	for (id x in items) { ENArtistRow *a = [ENArtistRow artistWithJSON:x]; if (a) [out addObject:a]; }
	return [out copy];
}

// ---------------------------------------------------------------------------------------------------------------- lists
@implementation ENTrackList

@synthesize title = _title;      // (R2a) its getter is our own

// (R2a) a playlist page's title: its header's masked name while on (a Blend, Hide My Playlist Names)
- (NSString *)title {
	if (_kind == ENListPlaylist && _playlist && [ENAnon on]) return _playlist.name ?: _title;
	return _title;
}

+ (instancetype)listWithJSON:(NSDictionary *)j { return [self listWithJSON:j meName:nil]; }

+ (instancetype)listWithJSON:(NSDictionary *)j meName:(NSString *)meName {
	j = ENJDict(j);
	NSString *k = ENJStr(j[@"k"]), *ctx = ENJStr(j[@"ctx"]);
	if (!k || !ctx) return nil;
	ENTrackList *l = [[ENTrackList alloc] init];
	l->_kind = [k isEqualToString:@"liked"] ? ENListLiked : [k isEqualToString:@"album"] ? ENListAlbum : ENListPlaylist;
	l->_ctx = [ctx copy];
	l->_revision = [ENJStr(j[@"v"]) copy];
	NSDictionary *h = ENJDict(j[@"h"]);
	l->_title = [ENJStr(h[@"n"]) copy];
	if (l->_kind == ENListPlaylist) l->_playlist = [ENPlaylist playlistWithJSON:h meName:meName];
	if (l->_kind == ENListAlbum) l->_album = [ENAlbumRow albumWithJSON:h];
	// the gateway sends album-page rows without i (webRow): they carry the album's cover, so a like from the album page
	// (rows of POST /v1/library), the Liked prepend and the Add-to strip have one
	l->_tracks = ENTracks(j[@"items"], l->_kind == ENListAlbum ? ENJStr(h[@"i"]) : nil);
	l->_length = ENJInt(j[@"len"], -1);
	if (l->_length < -1) l->_length = -1;
	l->_done = ENJFlag(j[@"done"]);
	l->_wait = ENJFlag(j[@"wait"]);
	NSInteger have = ENJInt(j[@"have"], -1);
	if (have < 0) {                            // a wait answer has no have: count what is here
		have = 0;
		for (ENTrack *t in l->_tracks) if (t.playable) have++;
	}
	l->_have = have;
	l->_retry = l->_done ? 0 : MAX(0.5, ENJInt(j[@"retry_ms"], 2500) / 1000.0);
	l->_truncated = ENJFlag(j[@"trunc"]);
	l->_totalMs = MAX(0LL, ENJLong(j[@"ms"], 0));
	l->_stale = ENJFlag(j[@"stale"]);
	return l;
}

- (ENTrackList *)copyWithTracks:(NSArray *)tracks {
	ENTrackList *l = [[ENTrackList alloc] init];
	l->_kind = _kind;
	l->_ctx = _ctx;
	l->_revision = _revision;
	l->_title = _title;
	l->_playlist = _playlist;
	l->_album = _album;
	l->_tracks = [tracks copy];
	l->_length = _length;
	l->_have = _have;
	l->_done = _done;
	l->_wait = _wait;
	l->_retry = _retry;
	l->_truncated = _truncated;
	l->_totalMs = _totalMs;
	l->_stale = _stale;
	return l;
}

- (ENTrackList *)listByInsertingTrack:(ENTrack *)track atIndex:(NSUInteger)index {
	if (!track.uri || [self indexOfURI:track.uri] != NSNotFound) return self;
	NSMutableArray *rows = [NSMutableArray arrayWithArray:_tracks ?: @[]];
	if (!_wait) [rows insertObject:track atIndex:MIN(index, rows.count)];     // a wait list has no rows yet: only the count
	ENTrackList *l = [self copyWithTracks:rows];
	if (_length >= 0) l->_length = _length + 1;
	if (track.playable) l->_have = _have + 1;
	l->_totalMs = _totalMs + track.durationMs;
	return l;
}

- (ENTrackList *)listByPrepending:(ENTrack *)track { return [self listByInsertingTrack:track atIndex:0]; }

- (ENTrackList *)listByRemovingURIs:(NSSet *)uris {
	if (!uris.count) return self;
	NSMutableArray *keep = [NSMutableArray arrayWithCapacity:_tracks.count];
	NSInteger gone = 0, goneHave = 0;
	long long goneMs = 0;
	for (ENTrack *t in _tracks) {
		if ([uris containsObject:t.uri]) {
			gone++;
			if (t.playable) goneHave++;
			goneMs += t.durationMs;
		} else [keep addObject:t];
	}
	if (!gone) return self;
	ENTrackList *l = [self copyWithTracks:keep];
	if (_length >= 0) l->_length = MAX(0, _length - gone);
	l->_have = MAX(0, _have - goneHave);
	l->_totalMs = MAX(0LL, _totalMs - goneMs);
	return l;
}

- (NSUInteger)indexOfURI:(NSString *)uri {
	if (!uri) return NSNotFound;
	NSUInteger i = 0;
	for (ENTrack *t in _tracks) {
		if ([t.uri isEqualToString:uri]) return i;
		i++;
	}
	return NSNotFound;
}

- (NSString *)description {
	return [NSString stringWithFormat:@"<ENTrackList %@ %lu rows, len %ld%@%@>", _ctx, (unsigned long)_tracks.count, (long)_length,
		_done ? @" done" : @"", _wait ? @" wait" : @""];
}

@end

// ---------------------------------------------------------------------------------------------------------------- library
@implementation ENLibrary

@synthesize meName = _meName;    // (R2a) its getter is our own

- (NSString *)meName { return [ENAnon on] ? nil : _meName; }
- (NSString *)rawMeName { return _meName; }

+ (instancetype)libraryWithJSON:(NSDictionary *)j checkedAt:(NSDate *)checkedAt {
	j = ENJDict(j);
	NSArray *items = ENJArr(j[@"items"]);
	if (!items) return nil;
	ENLibrary *lib = [[ENLibrary alloc] init];
	NSDictionary *me = ENJDict(j[@"me"]);
	lib->_meID = [ENJStr(me[@"id"]) copy];
	lib->_meName = [ENJStr(me[@"n"]) copy];
	NSDictionary *liked = ENJDict(j[@"liked"]);
	lib->_likedCtx = [ENJStr(liked[@"ctx"]) copy];
	lib->_likedLength = ENJInt(liked[@"len"], -1);
	if (lib->_likedLength < -1) lib->_likedLength = -1;
	NSMutableArray *pls = [NSMutableArray arrayWithCapacity:items.count];
	for (id x in items) { ENPlaylist *p = [ENPlaylist playlistWithJSON:x meName:lib->_meName]; if (p) [pls addObject:p]; }
	lib->_playlists = [pls copy];
	lib->_checkedAt = checkedAt;
	lib->_stale = ENJFlag(j[@"stale"]);
	return lib;
}

- (ENLibrary *)copyWithPlaylists:(NSArray *)pls {
	ENLibrary *lib = [[ENLibrary alloc] init];
	lib->_meID = _meID;
	lib->_meName = _meName;
	lib->_likedCtx = _likedCtx;
	lib->_likedLength = _likedLength;
	lib->_playlists = [pls copy];
	lib->_checkedAt = _checkedAt;
	lib->_stale = _stale;
	return lib;
}

- (NSArray *)editablePlaylists {
	NSMutableArray *out = [NSMutableArray array];
	for (ENPlaylist *p in _playlists) if (p.editable) [out addObject:p];
	return out;
}

- (ENPlaylist *)playlistForURI:(NSString *)uri {
	if (!uri) return nil;
	for (ENPlaylist *p in _playlists) if ([p.uri isEqualToString:uri]) return p;
	return nil;
}

- (NSInteger)ownCount {
	NSInteger n = 0;
	for (ENPlaylist *p in _playlists) if (p.own) n++;
	return n;
}

- (NSString *)defaultNewPlaylistName { return [NSString stringWithFormat:@"My Playlist #%ld", (long)([self ownCount] + 1)]; }

- (ENLibrary *)libraryWithLikedLength:(NSInteger)len {
	ENLibrary *lib = [self copyWithPlaylists:_playlists];
	lib->_likedLength = len < 0 ? -1 : len;
	return lib;
}

- (ENLibrary *)libraryByReplacingPlaylist:(ENPlaylist *)pl {
	if (!pl.uri) return self;
	NSMutableArray *pls = [NSMutableArray arrayWithArray:_playlists ?: @[]];
	NSUInteger i = 0;
	for (ENPlaylist *p in _playlists) {
		if ([p.uri isEqualToString:pl.uri]) break;
		i++;
	}
	if (i < pls.count) [pls replaceObjectAtIndex:i withObject:pl];
	else [pls addObject:pl];
	return [self copyWithPlaylists:pls];
}

- (ENLibrary *)libraryByInsertingPlaylist:(ENPlaylist *)pl {
	if (!pl.uri) return self;
	NSMutableArray *pls = [NSMutableArray arrayWithCapacity:_playlists.count + 1];
	[pls addObject:pl];
	for (ENPlaylist *p in _playlists) if (![p.uri isEqualToString:pl.uri]) [pls addObject:p];
	return [self copyWithPlaylists:pls];
}

- (ENLibrary *)libraryWithCheckedAt:(NSDate *)date {
	ENLibrary *lib = [self copyWithPlaylists:_playlists];
	lib->_checkedAt = date;
	return lib;
}

@end

// ---------------------------------------------------------------------------------------------------------------- artist
@implementation ENArtistPage

+ (instancetype)pageWithJSON:(NSDictionary *)j {
	j = ENJDict(j);
	ENArtistRow *a = [ENArtistRow artistWithJSON:j[@"a"]];
	if (!a) return nil;
	ENArtistPage *p = [[ENArtistPage alloc] init];
	p->_artist = a;
	p->_popular = ENTracks(j[@"top"], nil);
	p->_albums = ENAlbums(j[@"albums"]);
	p->_singles = ENAlbums(j[@"singles"]);
	p->_stale = ENJFlag(j[@"stale"]);
	return p;
}

@end

// ---------------------------------------------------------------------------------------------------------------- search
@implementation ENSearchResult

+ (instancetype)resultWithJSON:(NSDictionary *)j offset:(NSInteger)offset {
	j = ENJDict(j);
	NSString *q = ENJStr(j[@"q"]);
	if (!q) return nil;
	ENSearchResult *r = [[ENSearchResult alloc] init];
	r->_query = [q copy];
	r->_songsOnly = offset > 0;
	NSDictionary *top = ENJDict(j[@"top"]);
	NSString *k = ENJStr(top[@"k"]);
	if ([k isEqualToString:@"artist"]) r->_top = [ENArtistRow artistWithJSON:top[@"o"]];
	else if ([k isEqualToString:@"track"]) r->_top = [ENTrack trackWithJSON:top[@"o"]];
	else if ([k isEqualToString:@"album"]) r->_top = [ENAlbumRow albumWithJSON:top[@"o"]];
	r->_topKind = !r->_top ? ENSearchTopNone : [k isEqualToString:@"artist"] ? ENSearchTopArtist
		: [k isEqualToString:@"track"] ? ENSearchTopTrack : ENSearchTopAlbum;
	NSDictionary *tracks = ENJDict(j[@"tracks"]);
	r->_tracks = ENTracks(tracks[@"items"], nil);
	r->_tracksTotal = MAX(0, ENJInt(tracks[@"total"], (NSInteger)r->_tracks.count));
	r->_tracksOffset = MAX(0, offset);
	r->_tracksNext = ENJInt(tracks[@"next"], -1);
	if (r->_tracksNext < 0) r->_tracksNext = -1;
	r->_artists = ENArtists(j[@"artists"]);
	r->_albums = ENAlbums(j[@"albums"]);
	NSMutableArray *pls = [NSMutableArray array];
	for (id x in ENJArr(j[@"playlists"])) { ENPlaylist *p = [ENPlaylist playlistWithJSON:x meName:nil]; if (p) [pls addObject:p]; }
	r->_playlists = [pls copy];
	r->_stale = ENJFlag(j[@"stale"]);
	r->_empty = !r->_top && !r->_tracks.count && !r->_artists.count && !r->_albums.count && !r->_playlists.count;
	return r;
}

@end

// ---------------------------------------------------------------------------------------------------------------- 0.6 Jam
@implementation ENJamMember

@synthesize name = _name, imageToken = _imageToken, displayName = _displayName, initials = _initials;   // (R2a) our getters

- (NSString *)rawName { return _name; }

- (NSString *)name {
	if (![ENAnon on]) return _name;
	return _isMe ? @"You" : [ENAnon nameForUser:_memberID];
}

- (NSString *)imageToken { return [ENAnon on] ? nil : _imageToken; }

- (NSString *)displayName { return [ENAnon on] ? self.name : _displayName; }

- (NSString *)initials { return [ENAnon on] ? [ENAnon initialOf:self.name] : _initials; }

- (NSString *)avatarKey { return [ENAnon on] ? [ENAnon avatarKeyForUser:_memberID] : _memberID; }

+ (instancetype)memberWithJSON:(NSDictionary *)j {
	j = ENJDict(j);
	NSString *mid = ENJStr(j[@"id"]);
	if (!mid) return nil;
	ENJamMember *m = [[ENJamMember alloc] init];
	m->_memberID = [mid copy];
	m->_name = [(ENJStr(j[@"n"]) ?: mid) copy];
	m->_imageToken = [ENJStr(j[@"i"]) copy];
	m->_isHost = ENJFlag(j[@"h"]);
	m->_isMe = ENJFlag(j[@"me"]);
	m->_displayName = m->_isMe ? @"You" : m->_name;
	NSString *n = [m->_name stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	m->_initials = n.length ? [[n substringWithRange:[n rangeOfComposedCharacterSequenceAtIndex:0]] uppercaseString] : @"?";
	return m;
}

// no ids in descriptions: they could reach a log line
- (NSString *)description { return [NSString stringWithFormat:@"<ENJamMember%@%@>", _isHost ? @" host" : @"", _isMe ? @" me" : @""]; }

@end

@implementation ENQueue

@synthesize contextName = _contextName;    // (R2a) its getter is our own

// (R2a) while on: a Jam's context is ENJam's (masked) title ("Your Jam", "Mia’s Jam"); a playlist the library has, its
// masked name (Hide My Playlist Names, a Blend); anything else as the engine named it. Off the main thread: no lookups.
- (NSString *)contextName {
	if (!_contextName || ![ENAnon on]) return _contextName;
	if (![NSThread isMainThread]) return _jam ? @"the Jam" : _contextName;
	if (_jam) return [[ENJam shared] title] ?: @"the Jam";
	ENPlaylist *pl = [_contextURI hasPrefix:@"spotify:playlist:"] ? [[ENCatalog shared].library playlistForURI:_contextURI] : nil;
	return pl.name ?: _contextName;
}

+ (instancetype)queueWithJSON:(NSDictionary *)j {
	j = ENJDict(j);
	if (!j) return nil;
	ENQueue *q = [[ENQueue alloc] init];
	q->_now = [ENTrack trackWithJSON:j[@"now"]];
	q->_queued = ENTracks(j[@"q"], nil);
	q->_contextRows = ENTracks(j[@"cq"], nil);
	q->_autoplayRows = ENTracks(j[@"ap"], nil);
	NSDictionary *ctx = ENJDict(j[@"ctx"]);
	q->_contextName = [ENJStr(ctx[@"n"]) copy];
	q->_contextURI = [ENJStr(ctx[@"u"]) copy];
	q->_jam = ENJFlag(j[@"jam"]);
	q->_retryMs = MAX(0, ENJInt(j[@"retry_ms"], 0));
	q->_rev = [ENJStr(j[@"rev"]) copy];
	q->_editable = q->_rev && ENJFlag(j[@"ed"]);
	q->_empty = !q->_now && !q->_queued.count && !q->_contextRows.count && !q->_autoplayRows.count;
	return q;
}

@end

// ---------------------------------------------------------------------------------------------------------------- 0.7
@implementation ENHomeTile

@synthesize title = _title, subtitle = _subtitle, image = _image;    // (R2a) our getters

// (R2a) a playlist card is built from its ENPlaylist where it is drawn while on: the masked name, owner and cover
- (ENPlaylist *)anonPlaylist {
	return _kind == ENHomeTilePlaylist && [_item isKindOfClass:[ENPlaylist class]] && [ENAnon on] ? _item : nil;
}

- (NSString *)title {
	ENPlaylist *pl = [self anonPlaylist];
	return pl ? (pl.name ?: @"Playlist") : _title;
}

- (NSString *)subtitle {
	ENPlaylist *pl = [self anonPlaylist];
	return pl ? (pl.madeForMe ? @"Made for you" : ENJoin(@"Playlist", pl.owner)) : _subtitle;
}

- (NSString *)image {
	ENPlaylist *pl = [self anonPlaylist];
	return pl ? pl.image : _image;
}

+ (instancetype)tileWithJSON:(NSDictionary *)j meName:(NSString *)meName {
	j = ENJDict(j);
	NSString *k = ENJStr(j[@"k"]);
	if ([k isEqualToString:@"liked"]) {
		ENHomeTile *t = [[ENHomeTile alloc] init];
		t->_kind = ENHomeTileLiked;
		t->_title = @"Liked Songs";
		NSInteger len = ENJInt(j[@"len"], -1);
		t->_subtitle = len >= 0 ? ENCountText(len, @"song", @"songs") : @"Playlist";
		return t;
	}
	if ([k isEqualToString:@"playlist"]) return [self tileWithItem:[ENPlaylist playlistWithJSON:j[@"o"] meName:meName]];
	if ([k isEqualToString:@"album"]) return [self tileWithItem:[ENAlbumRow albumWithJSON:j[@"o"]]];
	if ([k isEqualToString:@"artist"]) return [self tileWithItem:[ENArtistRow artistWithJSON:j[@"o"]]];
	return nil;
}

+ (instancetype)tileWithItem:(id)item {
	ENHomeTile *t = [[ENHomeTile alloc] init];
	t->_item = item;
	if ([item isKindOfClass:[ENPlaylist class]]) {
		ENPlaylist *pl = item;
		t->_kind = ENHomeTilePlaylist;
		t->_title = pl.rawName ?: @"Playlist";              // (R2a: the real values; the getters mask where drawn)
		t->_subtitle = pl.madeForMe ? @"Made for you" : ENJoin(@"Playlist", pl.rawOwner);
		t->_image = pl.rawImage;
	} else if ([item isKindOfClass:[ENAlbumRow class]]) {
		ENAlbumRow *al = item;
		t->_kind = ENHomeTileAlbum;
		t->_title = al.name ?: @"Album";
		NSString *type = [al.type isEqualToString:@"single"] ? @"Single" : [al.type isEqualToString:@"compilation"] ? @"Compilation" : @"Album";
		t->_subtitle = ENJoin(type, al.artist);
		t->_image = al.image;
	} else if ([item isKindOfClass:[ENArtistRow class]]) {
		ENArtistRow *ar = item;
		t->_kind = ENHomeTileArtist;
		t->_title = ar.name ?: @"Artist";
		t->_subtitle = @"Artist";
		t->_image = ar.image;
		t->_round = YES;
	} else {
		return nil;
	}
	return t;
}

@end

static NSArray *ENTiles(NSArray *items) {
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:items.count];
	for (id x in items) { ENHomeTile *t = [ENHomeTile tileWithItem:x]; if (t) [out addObject:t]; }
	return [out copy];
}

static NSArray *ENPlaylists(id v, NSString *meName) {
	NSArray *items = ENJArr(v);
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:items.count];
	for (id x in items) { ENPlaylist *p = [ENPlaylist playlistWithJSON:x meName:meName]; if (p) [out addObject:p]; }
	return [out copy];
}

@implementation ENHomePage

@synthesize meName = _meName, meImage = _meImage;    // (R2a) our getters

- (NSString *)meName { return [ENAnon on] ? nil : _meName; }
- (NSString *)meImage { return [ENAnon on] ? nil : _meImage; }
- (NSString *)rawMeImage { return _meImage; }

+ (instancetype)pageWithJSON:(NSDictionary *)j meName:(NSString *)meName {
	j = ENJDict(j);
	if (!j) return nil;
	ENHomePage *p = [[ENHomePage alloc] init];
	NSDictionary *me = ENJDict(j[@"me"]);
	p->_meName = [ENJStr(me[@"n"]) copy];
	p->_meImage = [ENJStr(me[@"i"]) copy];
	NSString *mn = meName ?: p->_meName;
	NSMutableArray *jump = [NSMutableArray array];
	for (id x in ENJArr(j[@"jump"])) { ENHomeTile *t = [ENHomeTile tileWithJSON:x meName:mn]; if (t) [jump addObject:t]; }
	p->_jump = [jump copy];
	p->_made = ENTiles(ENPlaylists(j[@"made"], mn));
	p->_artists = ENTiles(ENArtists(j[@"artists"]));
	p->_releases = ENTiles(ENAlbums(j[@"releases"]));
	p->_top = ENTracks(j[@"top"], nil);
	p->_stale = ENJFlag(j[@"stale"]);
	p->_empty = !p->_jump.count && !p->_made.count && !p->_artists.count && !p->_releases.count && !p->_top.count;
	return p;
}

@end

// (0.11) USER rows (people search, followers / following); people lists also hold artists (k "artist" -> ENArtistRow)
static NSArray *ENPeople(id v, BOOL artistsToo) {
	NSArray *items = ENJArr(v);
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:items.count];
	for (id x in items) {
		NSDictionary *d = ENJDict(x);
		id row = artistsToo && [ENJStr(d[@"k"]) isEqualToString:@"artist"] ? [ENArtistRow artistWithJSON:d] : [ENUserRow userWithJSON:d];
		if (row) [out addObject:row];
	}
	return [out copy];
}

@implementation ENRowList

+ (instancetype)listWithJSON:(NSDictionary *)j kind:(ENRowListKind)kind { return [self listWithJSON:j kind:kind meName:nil]; }

+ (instancetype)listWithJSON:(NSDictionary *)j kind:(ENRowListKind)kind meName:(NSString *)meName {
	j = ENJDict(j);
	NSArray *items = ENJArr(j[@"items"]);
	if (!items) return nil;
	ENRowList *l = [[ENRowList alloc] init];
	l->_kind = kind;
	switch (kind) {
		case ENRowListAlbums: l->_items = ENAlbums(items); break;
		case ENRowListArtists: l->_items = ENArtists(items); break;
		case ENRowListRecent: l->_items = ENTracks(items, nil); break;
		case ENRowListPlaylists: l->_items = ENPlaylists(items, meName); break;          // (0.11)
		case ENRowListPeople: l->_items = ENPeople(items, YES); break;
		case ENRowListUsers: l->_items = ENPeople(items, NO); break;
	}
	l->_total = kind == ENRowListRecent ? (NSInteger)l->_items.count : MAX(ENJInt(j[@"total"], -1), -1);
	l->_stale = ENJFlag(j[@"stale"]);
	l->_offset = MAX(0, ENJInt(j[@"offset"], 0));                 // (0.11) paging (absent: 0 / -1 / NO / nil)
	l->_next = ENJInt(j[@"next"], -1);
	if (l->_next < 0) l->_next = -1;
	l->_truncated = ENJFlag(j[@"trunc"]);
	l->_query = [ENJStr(j[@"q"]) copy];
	return l;
}

@end

@implementation ENProfile

@synthesize name = _name, image = _image, followers = _followers, following = _following;    // (R2a) our getters

- (NSString *)name { return [ENAnon on] ? @"You" : _name; }
- (NSString *)image { return [ENAnon on] ? nil : _image; }
- (NSInteger)followers { return [ENAnon on] ? -1 : _followers; }
- (NSInteger)following { return [ENAnon on] ? -1 : _following; }
- (NSString *)rawName { return _name; }
- (NSString *)rawImage { return _image; }

+ (instancetype)profileWithJSON:(NSDictionary *)j meName:(NSString *)meName {
	j = ENJDict(j);
	NSDictionary *me = ENJDict(j[@"me"]);
	if (!me) return nil;
	ENProfile *p = [[ENProfile alloc] init];
	p->_uri = [ENJStr(me[@"u"]) copy];
	p->_name = [(ENJStr(me[@"n"]) ?: meName ?: @"You") copy];
	p->_image = [ENJStr(me[@"i"]) copy];
	p->_followers = MAX(ENJInt(me[@"fol"], -1), -1);
	p->_following = MAX(ENJInt(me[@"fing"], -1), -1);
	p->_artists = ENArtists(j[@"artists"]);
	p->_top = ENTracks(j[@"top"], nil);
	p->_playlists = ENPlaylists(j[@"playlists"], meName ?: p->_name);
	p->_stale = ENJFlag(j[@"stale"]);
	return p;
}

@end

// ---------------------------------------------------------------------------------------------------------------- 0.11
@implementation ENUserRow

@synthesize name = _name, image = _image, followers = _followers;    // (R2a) our getters

- (NSString *)name { return [ENAnon on] ? ([ENAnon nameForUser:_userID] ?: @"Profile") : _name; }
- (NSString *)image { return [ENAnon on] ? nil : _image; }
- (NSInteger)followers { return [ENAnon on] ? -1 : _followers; }
- (NSString *)rawName { return _name; }
- (NSString *)rawImage { return _image; }

+ (instancetype)userWithJSON:(NSDictionary *)j {
	j = ENJDict(j);
	NSString *u = ENJStr(j[@"u"]);
	NSString *fromURI = ENUserIDFromURI(u);
	if (!fromURI) return nil;
	NSString *uid = ENValidUserID(ENJStr(j[@"id"])) ? ENJStr(j[@"id"]) : fromURI;
	ENUserRow *r = [[ENUserRow alloc] init];
	r->_uri = [u copy];
	r->_userID = [uid copy];
	r->_name = [(ENJStr(j[@"n"]) ?: uid) copy];
	r->_image = [ENJStr(j[@"i"]) copy];
	r->_followers = ENJInt(j[@"fol"], -1);
	if (r->_followers < -1) r->_followers = -1;
	r->_following = ENJFlag(j[@"f"]);
	r->_isArtist = [ENJStr(j[@"k"]) isEqualToString:@"artist"];
	return r;
}

// no ids or names in descriptions: they could reach a log line
- (NSString *)description { return [NSString stringWithFormat:@"<ENUserRow%@>", _following ? @" following" : @""]; }

@end

@implementation ENUserProfile

+ (instancetype)profileWithJSON:(NSDictionary *)j { return [self profileWithJSON:j meName:nil]; }

+ (instancetype)profileWithJSON:(NSDictionary *)j meName:(NSString *)meName {
	j = ENJDict(j);
	ENUserRow *user = [ENUserRow userWithJSON:j];
	if (!user) return nil;
	ENUserProfile *p = [[ENUserProfile alloc] init];
	p->_user = user;
	p->_followers = MAX(0, ENJInt(j[@"fol"], 0));
	p->_following = MAX(0, ENJInt(j[@"fing"], 0));
	p->_playlists = ENPlaylists(j[@"pl"], meName);
	p->_playlistsTotal = MAX((NSInteger)p->_playlists.count, ENJInt(j[@"plt"], 0));
	p->_artists = ENArtists(j[@"ar"]);
	p->_isMe = ENJFlag(j[@"me"]);
	p->_verified = ENJFlag(j[@"vf"]);
	p->_isFollowing = ENJFlag(j[@"f"]);
	p->_canFollow = ENJFlag(j[@"cf"]);
	p->_stale = ENJFlag(j[@"stale"]);
	return p;
}

- (instancetype)profileWithFollowing:(BOOL)f { return [self profileWithFollowing:f followers:-1]; }

- (instancetype)profileWithFollowing:(BOOL)f followers:(NSInteger)followers {
	ENUserProfile *p = [[ENUserProfile alloc] init];
	p->_user = _user;
	p->_followers = followers >= 0 ? followers : (f == _isFollowing ? _followers : MAX(0, _followers + (f ? 1 : -1)));
	p->_following = _following;
	p->_playlists = _playlists;
	p->_playlistsTotal = _playlistsTotal;
	p->_artists = _artists;
	p->_isMe = _isMe;
	p->_verified = _verified;
	p->_isFollowing = f;
	p->_canFollow = _canFollow;
	p->_stale = _stale;
	return p;
}

- (NSString *)description {
	return [NSString stringWithFormat:@"<ENUserProfile %lu playlists%@%@>", (unsigned long)_playlists.count, _isMe ? @" me" : @"", _stale ? @" stale" : @""];
}

@end

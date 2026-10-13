#import "ENLyrics.h"
#import "ENModel.h"
#import "ENGateway.h"
#import "ENCatalog.h"
#import "ENUtil.h"
#import "ENDiag.h"
#import "ENL.h"

// Synced lyrics (DESIGN-LYRICS.md §2). The answer is parsed on ENCatalog's parse queue (never the main queue) into
// immutable objects; the memory cache and the in-flight table are touched on the main thread only. Every `done` goes
// through dispatch_async(main), so it never runs inside the call itself. Logs carry kinds and counts, never a line's text.

static const NSTimeInterval ENLyricsTimeout = 15;
static const NSUInteger ENLyricsMemory = 30;            // NSCache countLimit: songs kept in memory
static const NSUInteger ENLyricsMaxText = 300;          // the gateway takes n / a / al of at most 300 characters

typedef void (^ENLyricsBlock)(ENLyrics *lyrics, NSError *error);

static NSCache *sCache;                     // uri -> ENLyrics (every kind; errors are never kept)
static NSMutableDictionary *sFlights;       // uri -> NSMutableArray of ENLyricsBlock (a request in flight; later calls join)

static NSError *ENLyricsError(NSInteger status, NSString *code, NSString *message) {
	return [ENCatalog errorWithJSON:@{ @"error": @{ @"code": code, @"message": message } } status:status error:nil];
}

static NSString *ENLyricsKindName(ENLyricsKind k) {     // for the log line only
	switch (k) {
		case ENLyricsSynced: return @"synced";
		case ENLyricsPlain: return @"plain";
		case ENLyricsInstrumental: return @"instrumental";
		case ENLyricsNone: return @"none";
	}
	return @"?";
}

// at most `max` UTF-16 units (the gateway counts JS string length, the same unit); never cuts a surrogate pair in half
static NSString *ENLyricsClip(NSString *s, NSUInteger max) {
	if (s.length <= max) return s;
	unichar c = [s characterAtIndex:max - 1];
	return [s substringToIndex:(c >= 0xD800 && c <= 0xDBFF) ? max - 1 : max];
}

// ---------------------------------------------------------------------------------------------------------------- line
@interface ENLyricLine ()
+ (instancetype)lineAt:(double)timeMs text:(NSString *)text;
@end

@implementation ENLyricLine

+ (instancetype)lineAt:(double)timeMs text:(NSString *)text {
	ENLyricLine *l = [[ENLyricLine alloc] init];
	l->_timeMs = timeMs;
	l->_text = [text copy];
	return l;
}

@end

// ---------------------------------------------------------------------------------------------------------------- lyrics
@implementation ENLyrics

+ (instancetype)lyricsWithJSON:(NSDictionary *)j {
	j = ENJDict(j);
	NSString *u = ENJStr(j[@"u"]);
	if (!u) return nil;
	ENLyrics *l = [[ENLyrics alloc] init];
	l->_uri = [u copy];
	l->_source = [ENJStr(j[@"src"]) copy];
	l->_lines = @[];
	if (ENJFlag(j[@"inst"])) { l->_kind = ENLyricsInstrumental; return l; }
	BOOL synced = ENJFlag(j[@"s"]);
	NSArray *a = ENJFlag(j[@"none"]) ? nil : ENJArr(j[@"lines"]);
	NSMutableArray *lines = [NSMutableArray arrayWithCapacity:a.count];
	BOOL ascending = YES;
	double last = 0;
	for (id x in a) {
		NSDictionary *d = ENJDict(x);
		if (!d) continue;
		NSString *text = [d[@"l"] isKindOfClass:[NSString class]] ? d[@"l"] : @"";    // "" kept: a gap / a stanza break
		double t = -1;
		if (synced) {
			long long ms = ENJLong(d[@"t"], -1);
			if (ms < 0) continue;              // a synced line without a time can't be placed
			t = (double)ms;
			if (t < last) ascending = NO;
			last = t;
		}
		[lines addObject:[ENLyricLine lineAt:t text:text]];
	}
	if (!ascending)                            // the gateway sorts; lineIndexAtMs: relies on it, so make sure (stable)
		[lines sortWithOptions:NSSortStable usingComparator:^NSComparisonResult(ENLyricLine *x, ENLyricLine *y) {
			return x.timeMs < y.timeMs ? NSOrderedAscending : x.timeMs > y.timeMs ? NSOrderedDescending : NSOrderedSame;
		}];
	if (!lines.count) { l->_kind = ENLyricsNone; return l; }     // {none}, or an answer without one usable line
	l->_kind = synced ? ENLyricsSynced : ENLyricsPlain;
	l->_lines = [lines copy];
	return l;
}

- (NSInteger)lineIndexAtMs:(double)ms {
	if (_kind != ENLyricsSynced) return -1;
	NSInteger lo = 0, hi = (NSInteger)_lines.count - 1, found = -1;
	while (lo <= hi) {
		NSInteger mid = lo + (hi - lo) / 2;
		if ([(ENLyricLine *)_lines[mid] timeMs] <= ms) { found = mid; lo = mid + 1; }
		else hi = mid - 1;
	}
	return found;
}

#pragma mark - loading

+ (void)loadForTrack:(ENTrack *)track fresh:(BOOL)fresh done:(void (^)(ENLyrics *lyrics, NSError *error))done {
	ENLyricsBlock d = [done copy];
	NSString *uri = ENJStr(track.uri), *name = ENJStr(track.name), *artist = ENJStr(track.artistName);
	if (!uri || !name || !artist) {
		NSError *e = ENLyricsError(400, @"bad_request", ENL(@"There's no song to find lyrics for."));
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(nil, e); });
		return;
	}
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		sCache = [[NSCache alloc] init];
		sCache.countLimit = ENLyricsMemory;
		sFlights = [NSMutableDictionary dictionary];
	});
	if (!fresh) {
		ENLyrics *hit = [sCache objectForKey:uri];
		if (hit) {
			if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(hit, nil); });
			return;
		}
	}
	NSMutableArray *waiters = sFlights[uri];
	if (waiters) { if (d) [waiters addObject:d]; return; }

	// u, n, a always; al only when it fits the gateway's 300 (a clipped album would never match, and al is optional);
	// d only when known. escape: nil only for text that isn't valid UTF-16.
	NSString *u = [ENGateway escape:uri];
	NSString *n = [ENGateway escape:ENLyricsClip(name, ENLyricsMaxText)];
	NSString *a = [ENGateway escape:ENLyricsClip(artist, ENLyricsMaxText)];
	if (!u || !n || !a) {
		NSError *e = ENLyricsError(400, @"bad_request", ENL(@"This song's details can't be sent to your Encore Bridge."));
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(nil, e); });
		return;
	}
	NSMutableString *path = [NSMutableString stringWithFormat:@"/v1/lyrics?u=%@&n=%@&a=%@", u, n, a];
	NSString *album = ENJStr(track.album);
	NSString *al = album && album.length <= ENLyricsMaxText ? [ENGateway escape:album] : nil;   // (escape: nil would crash CF)
	if (al) [path appendFormat:@"&al=%@", al];
	if (track.durationMs > 0) [path appendFormat:@"&d=%ld", (long)track.durationMs];
	if (fresh) [path appendString:@"&fresh=1"];

	waiters = [NSMutableArray array];
	if (d) [waiters addObject:d];
	sFlights[uri] = waiters;
	CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
	[[ENGateway shared] fetchData:path etag:nil timeout:ENLyricsTimeout completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		[[ENCatalog shared] parseOnQueue:^{
			id j = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
			ENLyrics *l = st == 200 ? [ENLyrics lyricsWithJSON:j] : nil;
			NSError *e = nil;
			if (!l) e = st == 200 ? ENLyricsError(502, @"unreadable", ENL(@"Your Encore Bridge sent an answer Encore can't read."))
			                      : [ENCatalog errorWithJSON:j status:st error:err];
			dispatch_async(dispatch_get_main_queue(), ^{ [ENLyrics finish:uri lyrics:l error:e started:t0]; });
		}];
	}];
}

+ (void)finish:(NSString *)uri lyrics:(ENLyrics *)l error:(NSError *)e started:(CFAbsoluteTime)t0 {
	NSArray *blocks = sFlights[uri];
	[sFlights removeObjectForKey:uri];
	double ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000;
	if (l) {
		[sCache setObject:l forKey:uri];
		ENLog(@"lyrics: %@, %lu lines in %.0f ms", ENLyricsKindName(l.kind), (unsigned long)l.lines.count, ms);
	} else {
		ENLog(@"lyrics: failed (%ld %@) in %.0f ms", (long)e.code, [ENCatalog codeOfError:e] ?: @"-", ms);
	}
	for (ENLyricsBlock b in blocks) b(l, e);
}

@end

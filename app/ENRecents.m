#import "ENRecents.h"
#import "ENModel.h"
#import "ENUtil.h"
#import "ENDiag.h"

NSString *const ENRecentsChangedNotification = @"ENRecentsChangedNotification";

static NSString *const ENRecentsKey = @"encore.recentItems";
static NSString *const ENRecentsOldKey = @"recentSearches";       // 0.9.4: the query texts (no longer shown)
static const NSUInteger ENRecentsMax = 20;

static void ENPut(NSMutableDictionary *d, NSString *key, id value) { if (value) d[key] = value; }

// item -> its stored entry: the kind and only the row keys its model parses back (nil for anything else). (R2a) Always the
// real values (the raw... accessors): Anonymous Mode masks them where the rows are drawn, never in what is stored; a
// playlist also keeps its owner's uri and `own`, so its owner shows as the same made-up name (or "you") as everywhere else.
static NSDictionary *ENRecentEntry(id item) {
	NSMutableDictionary *d = nil;
	if ([item isKindOfClass:[ENTrack class]]) {
		ENTrack *t = item;
		if (!t.playable || !t.uri.length) return nil;
		d = [[t rowJSON] mutableCopy];
		d[@"kind"] = @"track";
	} else if ([item isKindOfClass:[ENArtistRow class]]) {
		ENArtistRow *ar = item;
		if (!ar.uri.length) return nil;
		d = [NSMutableDictionary dictionaryWithObjectsAndKeys:@"artist", @"kind", ar.uri, @"u", nil];
		ENPut(d, @"n", ar.name);
		ENPut(d, @"i", ar.image);
	} else if ([item isKindOfClass:[ENAlbumRow class]]) {
		ENAlbumRow *al = item;
		if (!al.uri.length) return nil;
		d = [NSMutableDictionary dictionaryWithObjectsAndKeys:@"album", @"kind", al.uri, @"u", nil];
		ENPut(d, @"n", al.name);
		ENPut(d, @"i", al.image);
		ENPut(d, @"ar", al.artist);
		ENPut(d, @"aru", al.artistURI);
		if (al.year > 0) d[@"y"] = @(al.year);
		ENPut(d, @"t", al.type);
	} else if ([item isKindOfClass:[ENPlaylist class]]) {
		ENPlaylist *pl = item;
		if (!pl.uri.length) return nil;
		d = [NSMutableDictionary dictionaryWithObjectsAndKeys:@"playlist", @"kind", pl.uri, @"u", nil];
		ENPut(d, @"n", pl.rawName);
		ENPut(d, @"i", pl.rawImage);
		ENPut(d, @"o", pl.rawOwner);
		ENPut(d, @"ou", pl.ownerURI);
		if (pl.own) d[@"own"] = @1;
	} else if ([item isKindOfClass:[ENUserRow class]]) {      // (0.11) a person (Search's Profiles)
		ENUserRow *u = item;
		if (!u.uri.length) return nil;
		d = [NSMutableDictionary dictionaryWithObjectsAndKeys:@"user", @"kind", u.uri, @"u", nil];
		ENPut(d, @"id", u.userID);
		ENPut(d, @"n", u.rawName);
		ENPut(d, @"i", u.rawImage);
	}
	return d;
}

// a stored entry -> its model, through the models' own constructors (nil: another kind, or nothing they can use)
static id ENRecentItem(NSDictionary *d) {
	NSString *k = ENJStr(d[@"kind"]);
	if ([k isEqualToString:@"track"]) {
		ENTrack *t = [ENTrack trackWithJSON:d];
		return t.playable ? t : nil;
	}
	if ([k isEqualToString:@"artist"]) return [ENArtistRow artistWithJSON:d];
	if ([k isEqualToString:@"album"]) return [ENAlbumRow albumWithJSON:d];
	if ([k isEqualToString:@"playlist"]) return [ENPlaylist playlistWithJSON:d meName:nil];
	if ([k isEqualToString:@"user"]) return [ENUserRow userWithJSON:d];          // (0.11)
	return nil;
}

@implementation ENRecents

// the first use drops the 0.9.4 list of query texts (once: it is gone afterwards)
+ (NSUserDefaults *)defaults {
	static BOOL migrated;
	NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
	if (!migrated) {
		migrated = YES;
		if ([ud objectForKey:ENRecentsOldKey]) {
			[ud removeObjectForKey:ENRecentsOldKey];
			[ud synchronize];
			ENLog(@"recents: dropped the 0.9.4 recent query texts");
		}
	}
	return ud;
}

// what is stored, cleaned up on the way out (a hand-edited or damaged value never reaches the screen): dictionaries with a
// kind and a uri, each uri once (its newest entry), newest first
+ (NSMutableArray *)entries {
	NSMutableArray *out = [NSMutableArray array];
	NSMutableSet *seen = [NSMutableSet set];
	for (id x in [[self defaults] arrayForKey:ENRecentsKey]) {
		NSDictionary *d = ENJDict(x);
		NSString *u = ENJStr(d[@"u"]);
		if (!u || !ENJStr(d[@"kind"]) || [seen containsObject:u]) continue;
		[seen addObject:u];
		[out addObject:d];
	}
	return out;
}

+ (void)save:(NSArray *)list {
	NSUserDefaults *ud = [self defaults];
	if (list.count) [ud setObject:list forKey:ENRecentsKey];
	else [ud removeObjectForKey:ENRecentsKey];
	[ud synchronize];          // on disk now: iOS 6 saves on a timer / in the background, a crash or killall -9 would lose it
	[[NSNotificationCenter defaultCenter] postNotificationName:ENRecentsChangedNotification object:nil];
}

+ (NSArray *)items {
	NSMutableArray *out = [NSMutableArray array];
	for (NSDictionary *d in [self entries]) {
		id item = ENRecentItem(d);
		if (item) [out addObject:item];
	}
	return out;
}

+ (void)add:(id)item {
	NSDictionary *e = ENRecentEntry(item);
	if (!e) return;
	NSMutableArray *list = [self entries];
	if (list.count && [list[0] isEqual:e]) return;          // already the newest, unchanged
	NSString *u = e[@"u"];
	for (NSUInteger i = list.count; i-- > 0; ) {
		NSDictionary *d = list[i];
		if ([d[@"u"] isEqual:u]) [list removeObjectAtIndex:i];
	}
	[list insertObject:e atIndex:0];
	while (list.count > ENRecentsMax) [list removeLastObject];
	ENLog(@"recents: add %@ (%lu)", e[@"kind"], (unsigned long)list.count);
	[self save:list];
}

+ (void)removeURI:(NSString *)uri {
	if (!ENJStr(uri)) return;
	NSMutableArray *list = [self entries];
	NSUInteger before = list.count;
	for (NSUInteger i = list.count; i-- > 0; ) {
		NSDictionary *d = list[i];
		if ([d[@"u"] isEqual:uri]) [list removeObjectAtIndex:i];
	}
	if (list.count == before) return;
	ENLog(@"recents: remove (%lu left)", (unsigned long)list.count);
	[self save:list];
}

+ (void)clear {
	if (![[self defaults] objectForKey:ENRecentsKey]) return;
	ENLog(@"recents: clear");
	[self save:nil];
}

@end

#import "ENPins.h"
#import "ENModel.h"
#import "ENDiag.h"

NSString *const ENPinsChangedNotification = @"ENPinsChangedNotification";

static NSString *const ENPinsKey = @"encore.pinnedPlaylists";
static const NSUInteger ENPinsMax = 10;

@implementation ENPins

// NSUserDefaults keeps its own memory copy, so reading it each time is cheap; whatever is stored is cleaned up on the way
// out (a hand-edited or damaged value never reaches the screens)
+ (NSArray *)pinnedURIs {
	NSMutableArray *out = [NSMutableArray array];
	for (id u in [[NSUserDefaults standardUserDefaults] arrayForKey:ENPinsKey])
		if ([u isKindOfClass:[NSString class]] && ((NSString *)u).length && ![out containsObject:u]) [out addObject:u];
	return out;
}

+ (BOOL)isPinned:(NSString *)uri {
	return uri.length && [[self pinnedURIs] containsObject:uri];
}

+ (void)setPinned:(BOOL)pinned forURI:(NSString *)uri {
	[self setPinned:pinned forURI:uri shownIn:nil];
}

+ (void)setPinned:(BOOL)pinned forURI:(NSString *)uri shownIn:(NSArray *)playlists {
	if (![uri isKindOfClass:[NSString class]] || !uri.length) return;
	NSMutableArray *list = [[self pinnedURIs] mutableCopy];
	BOOL has = [list containsObject:uri];
	if (pinned ? has : !has) return;
	if (pinned) {
		[list insertObject:[uri copy] atIndex:0];
		if (list.count > ENPinsMax) {
			// the oldest pins of playlists that aren't shown (deleted, unfollowed: they can't be unpinned) go first, then
			// the oldest shown one; no playlists = all count as not shown = simply the oldest
			NSMutableSet *shown = [NSMutableSet setWithCapacity:playlists.count];
			for (ENPlaylist *pl in playlists) if (pl.uri.length) [shown addObject:pl.uri];
			for (NSUInteger i = list.count - 1; i > 0 && list.count > ENPinsMax; i--)
				if (![shown containsObject:list[i]]) [list removeObjectAtIndex:i];
			while (list.count > ENPinsMax) [list removeLastObject];
		}
	} else [list removeObject:uri];
	NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
	[ud setObject:list forKey:ENPinsKey];
	[ud synchronize];          // on disk now: iOS 6 saves on a timer / in the background, a crash or killall -9 would lose it
	ENLog(@"pins: %@ (%lu pinned)", pinned ? @"pin" : @"unpin", (unsigned long)list.count);
	[[NSNotificationCenter defaultCenter] postNotificationName:ENPinsChangedNotification object:nil];
}

+ (NSArray *)orderPlaylists:(NSArray *)playlists pinnedCount:(NSUInteger *)pinnedCount {
	if (pinnedCount) *pinnedCount = 0;
	NSArray *pins = [self pinnedURIs];
	if (!pins.count || !playlists.count) return playlists;
	NSMutableDictionary *byURI = [NSMutableDictionary dictionaryWithCapacity:playlists.count];
	for (ENPlaylist *pl in playlists)
		if (pl.uri.length && !byURI[pl.uri]) byURI[pl.uri] = pl;          // a uri listed twice: its first row leads
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:playlists.count];
	NSMutableSet *lead = [NSMutableSet set];
	for (NSString *u in pins) {
		ENPlaylist *pl = byURI[u];
		if (!pl) continue;                                                  // not in this list (deleted, unfollowed, not editable)
		[out addObject:pl];
		[lead addObject:u];
	}
	if (!out.count) return playlists;
	if (pinnedCount) *pinnedCount = out.count;
	for (ENPlaylist *pl in playlists)
		if (!(pl.uri.length && [lead containsObject:pl.uri])) [out addObject:pl];
	return out;
}

@end

#import <Foundation/Foundation.h>

// Pinned playlists (app 0.9; owner: DATA; DESIGN-0.9 §2). Per phone, nothing on the gateway: NSUserDefaults
// `encore.pinnedPlaylists` = an NSArray of playlist uris, most recently pinned FIRST, at most 10 (an 11th pin drops the
// oldest). Pins of playlists that are no longer in the library stay stored (they come back with the playlist) but are
// never shown; an 11th pin made with shownIn: drops the oldest of those hidden ones before any shown one. The Playlists
// tab lists them right under Liked Songs (pin order, with a green pin glyph) and pins / unpins with a long press; the
// Add-to sheet lists the editable ones first. Uris are never logged. Main thread only.

extern NSString *const ENPinsChangedNotification;     // posted on the main thread after every change; object nil, no userInfo

@interface ENPins : NSObject

+ (NSArray *)pinnedURIs;                               // most recently pinned first (strings only, each once; may be empty)
+ (BOOL)isPinned:(NSString *)uri;
// Pinning puts uri first (an 11th pin drops the oldest); unpinning removes it. Nothing happens (and nothing is posted)
// when the state is already right (pinning a pinned uri doesn't move it) or uri is empty. Written to disk at once.
+ (void)setPinned:(BOOL)pinned forURI:(NSString *)uri;
// The same; `playlists` (ENPlaylist, may be nil) = the library as shown: when a pin overflows, the oldest pin that isn't
// among them goes before the oldest one that is (the Playlists tab passes its library).
+ (void)setPinned:(BOOL)pinned forURI:(NSString *)uri shownIn:(NSArray *)playlists;

// (UI addition) `playlists` (ENPlaylist, sidebar order) with the pinned ones it holds first, in pin order, then every other
// one in its order (a pinned playlist is not repeated, even when the sidebar holds its uri twice). *pinnedCount (may be
// NULL) = how many lead. Returns `playlists` itself when none of them is pinned.
+ (NSArray *)orderPlaylists:(NSArray *)playlists pinnedCount:(NSUInteger *)pinnedCount;

@end

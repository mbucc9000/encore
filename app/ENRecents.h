#import <Foundation/Foundation.h>

// Recent searches (app 0.9.5; owner: DATA): the items tapped in Search's results, like Spotify's "Recent searches". Per
// phone, nothing on the gateway: NSUserDefaults `encore.recentItems` = an NSArray of dictionaries, NEWEST FIRST, at most
// 20, one per uri (adding a uri that is already there moves it to the top). Each dictionary is {kind, <row keys>}: kind
// "track" | "artist" | "album" | "playlist", then only the keys the models already parse:
//   track    -[ENTrack rowJSON]        {u, n, a, ar, al, alu, i, d, e}
//   artist   ENArtistRow               {u, n, i}
//   album    ENAlbumRow                {u, n, i, ar, aru, y, t}
//   playlist ENPlaylist (search rows)  {u, n, i, o, ou, own}   (ou, own: 1.1.0, R2a)
//   user     ENUserRow                 {u, id, n, i}     (0.11 profiles, DESIGN-PROFILES §4.4; owner: PROFILES-APP, additive)
// Read back with the models' own +...WithJSON: constructors; an entry they can't parse (or of another kind) is dropped (an
// app before 0.11 drops the user entries the same way).
// The 0.9.4 query-text list (NSUserDefaults `recentSearches`) is removed on first use. Names and uris are never logged.
// (R2a) Entries always hold the real values; Search leaves the people out of the list while Anonymous Mode is on.
// Main thread only.

extern NSString *const ENRecentsChangedNotification;  // posted on the main thread after every change; object nil, no userInfo

@interface ENRecents : NSObject

+ (NSArray *)items;                                    // ENTrack / ENArtistRow / ENAlbumRow / ENPlaylist / (0.11) ENUserRow, newest first
// Puts `item` (one of the five; a song only when playable) first, dropping its older entry and anything past 20. Anything
// else is ignored (nothing posted). Written to disk at once.
+ (void)add:(id)item;
+ (void)removeURI:(NSString *)uri;                     // nothing happens (nothing posted) when uri isn't there
+ (void)clear;

@end

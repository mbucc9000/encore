#import <Foundation/Foundation.h>
#import "ENModel.h"

// The app's catalog (app 0.5; owner: DATA): the gateway's library, song lists, artist pages, search, liked states and the
// writes (like, add to playlist, create playlist), with a disk cache so screens draw at once (DESIGN-3 §5.3, §6).
// 0.11 (DESIGN-PROFILES §4.3; owner tonight: PROFILES-APP): other people's profiles, people search, following people and
// saving other people's playlists (the block at the end), and /v1/status `profiles`.
//
// Threading: call everything on the MAIN thread; every block is called on the main thread. JSON is parsed and the models
// are built on ENCatalog's own serial parse queue, never on the main queue. Disk writes happen on a background queue.
//
// How loads call back (loadLibrary / loadList / loadArtist): `done` can run SEVERAL times for one call:
//   1. at once-ish with the cached copy, if there is one (memory, else the disk file): fromCache YES. A copy from memory is
//      the very object delivered before, so a screen can skip it with `if (result == _shown) return;`;
//   2. once for every network 200 whose ETag differs from the last body delivered for that route (partial lists included):
//      fromCache NO.
//   A 304 delivers nothing (it only records the check time). An error calls done(nil, NO, error) once; the screen keeps
//   what it shows and adds a banner ([ENCatalog messageForError:]). If-None-Match is sent only with the ETag of a copy this
//   same call delivered, so a first-time caller always gets a body.
// At most one request per route is in flight; a second call joins it (and still gets its own cached delivery first).

extern NSString *const ENCatalogErrorDomain;        // NSError domain. code = HTTP status; 0 = couldn't reach the gateway
extern NSString *const ENCatalogErrorCodeKey;       // userInfo: the gateway's error.code ("duplicate", "rate_limited", ...)
extern NSString *const ENCatalogRetryAfterKey;      // userInfo: NSNumber, seconds (error.retry_after) when the gateway sent it
extern NSString *const ENCatalogErrorURIsKey;       // userInfo: NSArray of uris (409 duplicate: the ones already there)
// (NSLocalizedDescriptionKey = the gateway's human-readable error.message, or a network text)

// D8: the one on-screen message for a bridge too old for what was asked (app and bridge share one version number):
// "Update your Encore Bridge." (alerts, empty states, errors) and the same words without the full stop (a row's value or
// detail, a banner). Users see the gateway as "Encore Bridge" (D7).
extern NSString *const ENUpdateBridgeText;
extern NSString *const ENUpdateBridgeShortText;

extern NSString *const ENCatalogChangedNotification;    // posted on the main thread; object: [ENCatalog shared]
extern NSString *const ENCatalogKindKey;                // userInfo: one of the kinds below
extern NSString *const ENCatalogURIKey;                 // userInfo (kind list): the playlist/album uri whose list changed
extern NSString *const ENCatalogURIsKey;                // userInfo (kind liked): NSArray of uris whose saved state changed
extern NSString *const ENCatalogKindLibrary;            // .library is a new object (network, `playlists` event, a local patch,
                                                        // a 304's new checkedAt)
extern NSString *const ENCatalogKindList;               // that list changed on the gateway (`playlist` event, our own add;
                                                        // a `liked` event for a change made elsewhere -> uri ENLikedListURI;
                                                        // the echo of our own like isn't one): a VISIBLE screen showing it
                                                        // calls loadList:fresh:NO again, a hidden one on its next appearance
extern NSString *const ENCatalogKindLiked;              // saved states changed (hearts redraw) and/or .likedList was patched
extern NSString *const ENCatalogKindReset;              // the gateway restarted: every visible screen revalidates
extern NSString *const ENCatalogKindAlbums;             // (0.9) Your Library's albums. With ENCatalogURIsKey: the album uris
                                                        // whose saved state changed (a check, a save or its revert): hearts
                                                        // redraw. Without it: the saved albums LIST changed on the gateway
                                                        // (our save landed, or an `albums` event for a change made
                                                        // elsewhere): Library reloads it (fresh)

extern NSString *const ENCatalogKindUser;              // (0.11 profiles) our follow / unfollow of a person changed its state (optimistic,
                                                        // confirmed or reverted): ENCatalogURIKey = that spotify:user: uri. Profile screens
                                                        // redraw the button and the followers count. Without ENCatalogURIKey:
                                                        // profilesAvailable or canSavePlaylists changed (entry points show / hide)

extern NSString *const ENLikedListURI;                  // @"encore:liked": loadList: key for Liked Songs (any
                                                        // spotify:user:<me>:collection uri works too)

extern NSString *const ENCatalogVersionNotification;    // (0.6) posted on the main thread each time /v1/status answered with a
                                                        // gateway.version (gatewayVersion is set by then): ENJam's `available`

typedef void (^ENCatalogBlock)(id result, BOOL fromCache, NSError *error);

@interface ENCatalog : NSObject

+ (instancetype)shared;

// First line of -application:didFinishLaunchingWithOptions: (before any request): installs the zero-size shared
// NSURLCache (§5.2: iOS keeps no second copy in Cache.db, and a 304 can't be swapped for a stored 200) and creates the
// cache folders. No network.
+ (void)prepareAtLaunch;

// After the first frame is up (ENTabBarController's first viewDidAppear): starts observing (memory warning, app active /
// background, ENPlaybackChangedNotification), checks /v1/status gateway.version once (again after every `reset` event: the
// gateway restarted, maybe as another version; and on becoming active once the last answer is 6 h old), and schedules
// ENImageCache's prune. Each answer's `update` goes to ENUpdateNotice (the new-version notice).
- (void)start;

@property (nonatomic, readonly) ENLibrary *library;         // last known (cache or network, with local patches); nil if none
@property (nonatomic, readonly) ENTrackList *likedList;     // last Liked list delivered (with local like patches), else nil
@property (nonatomic, readonly) BOOL loading;               // a JSON request is in flight (ENImageCache drops to 1 download)
@property (nonatomic, readonly, copy) NSString *gatewayVersion;   // from /v1/status; nil until known; re-read after a reset
@property (nonatomic, readonly) BOOL gatewayTooOld;         // version known and < 0.5.0: Playlists shows the
                                                            // ENUpdateBridgeShortText banner (posted as kind library)
// (0.6) /v1/status jam.sc at that same check (DESIGN-4b §4.3): 1 = social-connect usable, 0 = refused, -1 = unknown (not
// yet checked by L0, or a gateway before 0.6.0). Only the Jam screen's "not available" footer reads it.
@property (nonatomic, readonly) NSInteger jamSocialState;

// (0.6, DATA-internal) runs `block` on the catalog's serial parse queue (ENPlayback's Up Next parse, DESIGN-4b §6.3).
- (void)parseOnQueue:(void (^)(void))block;

// Launch path only (§5.7): reads + parses <cache>/json/playlists.json on the CALLER's thread (~15 KB, 2-5 ms), sets
// .library, returns it (nil if no file). The Playlists root calls it in viewDidLoad. No network.
- (ENLibrary *)cachedLibrarySync;

// GET /v1/playlists[?fresh=1] -> ENLibrary. fresh = pull-to-refresh.
- (void)loadLibrary:(BOOL)fresh done:(ENCatalogBlock)done;

// A song list -> ENTrackList. uri: spotify:playlist:<id> (/v1/playlists/<id>), spotify:album:<id> (/v1/albums/<id>),
// ENLikedListURI or spotify:user:<me>:collection (/v1/liked). fresh = pull-to-refresh (fresh=1; albums: revalidate even
// when the cached file is under a day old). Albums are revalidated only when their file is older than 1 day.
// Partial answers (!done) are delivered but never written to disk; the SCREEN polls them (pollList:) — see ARCH-0.5.md.
- (void)loadList:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done;

// Polling a partial list: no cached delivery; If-None-Match with the last body delivered for the route; done(list, NO,
// nil) only for a 200 with a new ETag, done(nil, NO, error) on an error, nothing on a 304.
- (void)pollList:(NSString *)uri done:(ENCatalogBlock)done;

// GET /v1/artists/<id> -> ENArtistPage. uri: spotify:artist:<id>. Revalidated only when the cached file is older than 1 day
// (or fresh), except a page without Popular songs (the gateway's top-tracks search failed): that one on every call.
- (void)loadArtist:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done;

// GET /v1/search -> ENSearchResult. offset 0: the full first page (q only); offset 10, 20 ... 990: a See-all-songs page
// (type=track&offset=N). Memory cache only (30 entries, 10 min): a hit calls done once with fromCache YES and no request.
// done is called exactly once. q is sent trimmed (1-100 characters); the caller drops answers for an older query.
- (void)search:(NSString *)q offset:(NSInteger)offset done:(ENCatalogBlock)done;

// ---- 0.7 (gateway 0.7.0, personal.js): Home, Your Library's lists, your profile. Same delivery rules as loadLibrary:
// (cached copy first, then the network when its ETag differs; fresh = pull to refresh). Every copy is kept on disk.
- (void)loadHome:(BOOL)fresh done:(ENCatalogBlock)done;            // GET /v1/home -> ENHomePage
- (void)loadProfile:(BOOL)fresh done:(ENCatalogBlock)done;         // GET /v1/me -> ENProfile
- (void)loadSavedAlbums:(BOOL)fresh done:(ENCatalogBlock)done;     // GET /v1/me/albums -> ENRowList (ENAlbumRow)
- (void)loadFollowedArtists:(BOOL)fresh done:(ENCatalogBlock)done; // GET /v1/me/artists -> ENRowList (ENArtistRow)
- (void)loadRecentlyPlayed:(BOOL)fresh done:(ENCatalogBlock)done;  // GET /v1/recent -> ENRowList (ENTrack with playedAt)
// your picture's image token, from the last Home / profile copy taken (the nav bars' profile button); nil until known, and
// (R2a) nil while Anonymous Mode is on
@property (nonatomic, readonly, copy) NSString *meImageToken;

// ---- 0.9 (gateway 0.9.0, DESIGN-0.9 §1): albums in Your Library, keyed by spotify:album: uri
- (NSNumber *)albumSavedStateForURI:(NSString *)uri;        // @YES / @NO / nil = unknown. Fed by checks and our saves; an
                                                            // `albums` event for a change made elsewhere forgets them all
                                                            // (kind albums without uris: a page on screen checks again)
// GET /v1/me/albums/contains?uris=<uri>, even for a known state (a re-check). Fills the state, posts kind albums (uris
// @[uri]) when it changed, then done() — also after an error (the state stays as it was). A second check of the same album
// while one is in flight joins it. done may be nil.
- (void)checkAlbumSaved:(NSString *)uri done:(void (^)(void))done;
// Add to / remove from Your Library, OPTIMISTIC: at once flips the state and posts kind albums (uris @[uri]); then POST
// /v1/me/albums {"uris":[uri],"saved":true|false}, serialized per album like the likes (while one is in flight a further
// call only changes the wanted state, and the newest is sent when it returns). Once the server has it: the saved albums
// route's memory copy is dropped (the next loadSavedAlbums: revalidates without an old copy) and kind albums is posted
// without uris. On failure the state goes back and is posted again. done(nil) once the server has the state this call
// asked for (or a later call superseded it); done(error) after a revert — the caller shows [ENCatalog messageForError:].
// May be nil.
- (void)setAlbum:(NSString *)uri saved:(BOOL)saved done:(void (^)(NSError *error))done;

// ---- saved ("liked") states, keyed by uri (a row's u, or for the song being heard context_track_uri ?: uri)
- (NSNumber *)savedStateForURI:(NSString *)uri;             // @YES / @NO / nil = unknown. Fed by contains answers, `liked`
                                                            // events, our writes, each snapshot track's `liked` and the
                                                            // Liked list (a @YES a whole network copy lacks: re-checked)
// GET /v1/library/contains (batches of <= 50), even for known uris (a re-check). Fills the states, posts kind liked for the
// ones that changed, then done() — also after an error (states stay as they were). done may be nil.
- (void)checkSaved:(NSArray *)uris done:(void (^)(void))done;

// ---- writes (3c). All take the gateway's 45 s timeout.
// Like / unlike, OPTIMISTIC (§6.4): at once flips the states, patches .likedList (prepends the tracks / removes their rows),
// adjusts .library's liked count by the number that changed, and posts kind liked (+ kind library). The request
// (POST /v1/library {uris, saved: true|false, rows: [track.rowJSON...]}) is serialized per uri: while one is in flight a
// further call only changes the wanted state, and when it returns the app sends again only if wanted != the server's.
// On failure everything is reverted (and posted again). done(nil) once the server has the state this call asked for (or a
// later call superseded it); done(error) after a revert — the caller shows [ENCatalog messageForError:]. May be nil.
- (void)setSaved:(BOOL)saved tracks:(NSArray *)tracks done:(void (^)(NSError *error))done;

// POST /v1/playlists/<id>/items {"op":"add","uris":[...],"allow_duplicates":true|false}. NOT optimistic. On success the
// updated PL replaces pl in .library (kind library) and kind list is posted for pl.uri; done(updatedPlaylist, nil).
// 409 with ENCatalogErrorCodeKey "duplicate" = the Already Added case (ENCatalogErrorURIsKey lists them).
- (void)addTrackURIs:(NSArray *)uris toPlaylist:(ENPlaylist *)pl allowDuplicates:(BOOL)allowDuplicates
                done:(void (^)(ENPlaylist *updated, NSError *error))done;

// (0.9, DESIGN-0.9 §3) POST /v1/playlists/<id>/items {"op":"remove","uris":[1-50 song uris]} (every occurrence goes). NOT
// optimistic. On success like an add: the updated PL (pl itself when the answer has none) replaces pl in .library (kind
// library) and kind list is posted for its uri; done(updatedPlaylist, nil). 403 not_editable: a playlist you can't edit.
- (void)removeTrackURIs:(NSArray *)uris fromPlaylist:(ENPlaylist *)pl done:(void (^)(ENPlaylist *updated, NSError *error))done;

// (0.9, DESIGN-0.9 §3) GET /v1/playlists/containing?uri=<spotify:track:…>, the "Saved in" sheet's checks: states = playlist
// uri -> @YES / @NO for the editable playlists the gateway's membership index has read; pending = how many it hasn't read
// yet (left out of states: ask again in a moment). No cache; done is called exactly once: done(states, pending, nil) or
// done(nil, 0, error).
- (void)loadPlaylistsContaining:(NSString *)trackURI done:(void (^)(NSDictionary *states, NSInteger pending, NSError *e))done;

// (0.9.4, DESIGN-DATE-ADDED) GET /v1/playlists/<id>/added: when each song was added, for the Date added sorts. entries = the
// gateway's items array in the PLAYLIST's order, one per playlist item (a song in it twice: two entries): each an NSArray
// @[track uri (NSString, @"" if the gateway sent none), added_at (NSNumber, ms since 1970; 0 = unknown)]. playlistURI:
// spotify:playlist:<id> only. Memory cache per playlist (no disk copy): a call answers from it while it is current: the
// catalog's copy of that list is still at the revision the dates were asked for (or at the gateway's `v`), and for a playlist
// without a revision (Spotify's own) for 10 min. Any kind list for that uri (an event, our add / remove) drops it; the next
// call asks again (with the old ETag: a 304 keeps the entries). One request per playlist at a time: a call joins it unless
// the list changed since it went out. done is called exactly once, on the main thread, never inside the call: done(entries,
// nil) or done(nil, error) — a 404 not_available ("Spotify doesn't share when songs were added to this playlist."), and a
// gateway without the route: ENUpdateBridgeText — or done(entries, error) with error code
// saved_copy: the gateway's saved copy of them (stale: Spotify failed just now). Usable, but never current: the next call
// asks again.
- (void)loadAddedDates:(NSString *)playlistURI done:(void (^)(NSArray *entries, NSError *error))done;

// POST /v1/playlists {"name","uris"} (private). name must already be trimmed and 1-100 characters (the caller supplies
// "My Playlist #N" for an empty one). On success the new PL goes to the top of .library (kind library). addError: the
// gateway's add_error when the playlist was made but the songs weren't added (nil otherwise).
- (void)createPlaylistNamed:(NSString *)name trackURIs:(NSArray *)uris
                       done:(void (^)(ENPlaylist *created, NSString *addError, NSError *error))done;

// ---- 0.11 (gateway 0.10.0, DESIGN-PROFILES §4.3; owner: PROFILES-APP): other people's profiles.
// Errors on these routes follow errorWithJSON:, except a 404 with code not_found (a gateway from before the routes): code
// gateway_too_old, ENUpdateBridgeText, and profilesAvailable becomes NO. 404 user_not_found,
// 501 and 503 keep the gateway's message. While profilesAvailable is NO every call below fails at once with that error (no
// request). No log line carries an id, a name or a query: route kinds, statuses and counts only.
@property (nonatomic, readonly) BOOL profilesAvailable;  // NO only once /v1/status said a gateway < 0.10.0, or a profile route
                                                        // answered 404 not_found (then until the next reset / version check)
@property (nonatomic, readonly) BOOL canSavePlaylists;  // /v1/status profiles.sp == 1 (NO until known; NO after a 501 on a save,
                                                        // until the next version check)
// GET /v1/users/<id> -> ENUserProfile; /v1/users/<id>/playlists?offset=N -> ENRowList (Playlists); /followers, /following ->
// ENRowList (People). uri: spotify:user:<id>. Route machinery (cached copy first, ETag revalidation, one request per route,
// fresh = fresh=1). (Implementation note: every playlists page, the first too, carries ?offset=N, and fresh=1 is then joined
// with '&'.) MEMORY ONLY: -shouldWrite: stays NO for these models (no disk growth from browsing people). Route names
// "user_<safe id>", "upl_<safe id>_<offset>", "ufo_<safe id>", "ufi_<safe id>" (safe = every character outside
// [A-Za-z0-9._-] -> '_', plus 8 hex of the id's SHA-1 when any was replaced, so two ids never share a route); -labelOfRoute:
// gives "user", "user playlists", "followers", "following" (never the id).
- (void)loadUser:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done;
- (void)loadUserPlaylists:(NSString *)uri offset:(NSInteger)offset fresh:(BOOL)fresh done:(ENCatalogBlock)done;
- (void)loadFollowers:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done;
- (void)loadFollowing:(NSString *)uri fresh:(BOOL)fresh done:(ENCatalogBlock)done;
// GET /v1/search/users?q=&offset=N -> ENRowList (Users). Like -search:offset:done: (memory cache 30 entries / 10 min, done
// exactly once, q trimmed to 1-100 characters, offset 0..90 step 10).
- (void)searchUsers:(NSString *)q offset:(NSInteger)offset done:(ENCatalogBlock)done;
// Follow / unfollow a person, OPTIMISTIC like setAlbum:saved:done: (state map, kind user posted at once, serialized per uri,
// the newest wanted state sent when one returns, reverted + posted on failure). POST /v1/users/<id>/follow {"following":…}.
// Once confirmed, the catalog's copy of that profile is patched (f, the gateway's fol) and its copies of my own profile and
// following list are dropped (asked for again without an old copy).
- (NSNumber *)followStateForUser:(NSString *)uri;        // @YES / @NO while a write is pending or since one confirmed; nil = the
                                                         // profile's own `f`
- (void)setUser:(NSString *)uri following:(BOOL)following done:(void (^)(NSError *error))done;
// Follow / unfollow someone else's playlist (adds it to Your Library), OPTIMISTIC the same way; POST /v1/me/playlists
// {"uri","saved"}. The state is the library's (a PL in .library) unless a write is pending or confirmed in the last 30 s; on
// success the library is revalidated (the gateway also pushes `playlists`). Each change of the state posts kind library (the
// playlist page's bar button follows it). A 501 also turns canSavePlaylists off (kind user without a uri).
- (NSNumber *)playlistSavedStateForURI:(NSString *)uri; // nil while .library is unknown
- (void)setPlaylist:(ENPlaylist *)pl saved:(BOOL)saved done:(void (^)(NSError *error))done;

// ---- fed by ENPlayback (DATA-internal, main thread)
- (void)handleEvent:(NSDictionary *)event;                  // a /v1/events entry of type playlists | playlist | liked | reset
                                                            // | albums (0.9)
- (void)noteSnapshotTrack:(NSDictionary *)track;            // each snapshot `track`: its `liked` (1/0) under context_track_uri ?: uri

// ---- errors, for every screen and alert
+ (NSString *)messageForError:(NSError *)error;             // what to show: 401 -> "The gateway doesn't know this phone any more.
                                                            // Unpair and pair again." (ONLY for 401); the gateway's message;
                                                            // network -> "Can't reach the gateway."
// (R2a) while Anonymous Mode is on, a bridge text that names a person, a device or a playlist is replaced by the app's own
// (+[ENAnon bridgeText:code:]); the error's own userInfo keeps the bridge's text
+ (NSString *)codeOfError:(NSError *)error;                 // the gateway's error.code, nil if none
+ (NSString *)logTextForError:(NSError *)error;             // (R2a) for ENLog lines: "<status> <code>", never the bridge's text
                                                            // (it can name people, devices or playlists)
+ (NSTimeInterval)retryAfterOfError:(NSError *)error;       // retry_after seconds, 0 if none

// DATA-internal (ENPlayback's addToQueue:done: uses it too): an ENCatalogErrorDomain error from a gateway reply.
// json = the parsed body ({"error":{code,message,retry_after?,uris?}} or anything), status = HTTP status (0 = network),
// err = the transport error. Any thread.
+ (NSError *)errorWithJSON:(id)json status:(NSInteger)status error:(NSError *)err;

@end

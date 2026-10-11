#import <Foundation/Foundation.h>

// The catalog's model objects (app 0.5; owner: DATA). They map the gateway's row objects (DESIGN-3 §3.2; the deployed
// gateway/src/catalog.js is the truth) and are IMMUTABLE once built: ENCatalog builds them on its parse queue and hands them
// to the main thread, so they are safe to share between threads. A "patch" (a like, an add) makes a new object with the
// ...By... / ...With... methods below; nothing is ever changed in place.
//
// Every property that maps a key the gateway may leave out is nil / NO / -1 / 0 when absent, as noted. Strings the screens
// draw for every row (subline, timeText, filterKey...) are precomputed here, off the main thread, so cellForRow does no work.
//
// 0.11 (gateway 0.10.0, DESIGN-PROFILES §4.2; owner: PROFILES-APP, additive): other people's profiles. ENPlaylist gains the
// owner's uri (`ou`) and its follower count (`fol`); ENUserRow (a person in search results and people lists), ENUserProfile
// (GET /v1/users/<id>), three new ENRowList kinds (a profile's public playlists page, followers / following, people search)
// with offset / next / truncated / query, and the C helpers below for spotify:user: uris and pasted profile links. User ids
// and names are never logged: the new classes' -description carries neither.
//
// 1.1.0 (R2a, Anonymous Mode, ENAnon.h; RELEASE-PLAN D1-D3): the getters marked [anon] mask AT DISPLAY TIME while
// +[ENAnon on] (people's names and pictures, counts, your own playlists with "Hide My Playlist Names", Blends): the stored
// values stay real, so a cached model and a live switch both follow the mode on the next draw. Ids and uris are never
// masked. The raw... accessors give the real values for code that stores or compares them (Recent searches, ENCatalog's
// parse inputs, Settings), never for display.

typedef enum { ENListPlaylist = 0, ENListLiked, ENListAlbum } ENListKind;   // the gateway's "k"

// ---- (0.11 profiles) spotify:user: uris. A user id is the Spotify username: what follows "spotify:user:", percent-decoded,
// 1-64 characters with no whitespace and none of / \ : ? # % (the gateway's rule, DESIGN-PROFILES §2.2). Any thread.
NSString *ENUserIDFromURI(NSString *uri);      // spotify:user:<x> with no further ':' -> x percent-decoded; nil otherwise (also
                                               // for spotify:user:<x>:collection and for an id the gateway would refuse)
// The trimmed text against ^(?:https?://)?open\.spotify\.com/(?:intl-[A-Za-z-]+/)?user/([^/?#\s]+) (any ?si= or path after it
// ignored) or ^spotify:user:([^:\s]+)$ -> spotify:user:<x>; nil otherwise (or when ENUserIDFromURI refuses the result).
NSString *ENUserURIFromLink(NSString *text);
// (implementation addition) an id (a Jam member's, the library's me.id) -> spotify:user:<id percent-encoded>; nil for an id
// the gateway would refuse. ENUserIDFromURI of the result is the id again.
NSString *ENUserURIFromID(NSString *userID);
typedef enum { ENSearchTopNone = 0, ENSearchTopArtist, ENSearchTopTrack, ENSearchTopAlbum } ENSearchTopKind;

// ---------------------------------------------------------------------------------------------------------------- PL
@interface ENPlaylist : NSObject
@property (nonatomic, readonly, copy) NSString *uri;          // u: spotify:playlist:<id> (always set)
@property (nonatomic, readonly, copy) NSString *playlistID;   // the 22-char id from uri
@property (nonatomic, readonly, copy) NSString *name;         // n (nil only for a header the gateway sent as just {u}). [anon]
                                                              // a Blend: "Blend"; yours with Hide My Playlist Names: "My Playlist #n"
@property (nonatomic, readonly, copy) NSString *image;        // i: image token, nil = the placeholder tile. [anon] nil for a Blend,
                                                              // and for your custom-uploaded cover (ugc) with Hide My Playlist Names
@property (nonatomic, readonly, copy) NSString *owner;        // o: display name ("Spotify" for spotify); nil if absent. [anon] "You"
                                                              // for yours, "Spotify" kept, anyone else's made-up name (by ou)
@property (nonatomic, readonly) BOOL own;                     // own: I own it
@property (nonatomic, readonly) BOOL editable;                // ed: I can add to it (it is in the Add-to picker)
@property (nonatomic, readonly) BOOL collaborative;           // c: shared with me for editing
@property (nonatomic, readonly) BOOL madeForMe;               // mf
@property (nonatomic, readonly) NSInteger length;             // len: song count; -1 = unknown (search rows have none)
@property (nonatomic, readonly, copy) NSArray *folder;        // f: folder path (NSStrings), nil at top level (3b ignores it). [anon]
                                                              // nil with Hide My Playlist Names
@property (nonatomic, readonly, copy) NSString *revision;     // v (nil without engine patch 2)
@property (nonatomic, readonly, copy) NSString *desc;         // d: plain-text description (detail headers only), nil if empty.
                                                              // [anon] Spotify's kept; yours only without Hide My Playlist Names;
                                                              // other people's and Blends' nil (they can name people)
@property (nonatomic, readonly, copy) NSString *subline;      // row sub-line (§3.2): mf "Made for <me>" | c "Collaborative" |
                                                              // own "by <me>" | "by <o>" (no "by" part without o), then
                                                              // " · N songs" when length >= 0 (ENCountText)
@property (nonatomic, readonly, copy) NSString *linkLine;     // the green header line: "Made for <me>" | "by <me>" | "by <o>" | nil
                                                              // ([anon] both lines: "you" for me, the masked owner)
@property (nonatomic, readonly, copy) NSString *ownerURI;     // (0.11) ou: the owner's spotify:user:<id> (gateway 0.10.0); nil when absent
@property (nonatomic, readonly) NSInteger followers;          // (0.11) fol: the playlist's follower count (profile rows); -1 = absent
@property (nonatomic, readonly) BOOL customCover;             // (R2a) ugc: a custom-uploaded cover (the bridge's flag, R2b; NO when absent)
@property (nonatomic, readonly) BOOL blend;                   // (R2a) a Spotify Blend: the bridge's `bl` flag, else Spotify-owned (not
                                                              // Made For You) with "A + B" in its name or "blend" in its description
@property (nonatomic, readonly, copy) NSString *rawName, *rawOwner, *rawImage;   // (R2a) n, o, i unmasked (Recent searches store them)

// j = one PL object; meName = the library's me.n (for "Made for"/"by <me>"; nil -> "you"). nil when j has no valid u.
+ (instancetype)playlistWithJSON:(NSDictionary *)j meName:(NSString *)meName;
- (instancetype)playlistWithLength:(NSInteger)length;         // a copy with another song count (subline rebuilt)
@end

// ---------------------------------------------------------------------------------------------------------------- TR
@interface ENTrack : NSObject
@property (nonatomic, readonly, copy) NSString *uri;          // u: what to play, like or add (the context entry's uri)
@property (nonatomic, readonly, copy) NSString *name;         // n
@property (nonatomic, readonly, copy) NSString *artists;      // a: "A, B"
@property (nonatomic, readonly, copy) NSString *artistName;   // the first artist (exact for playback tracks; for TR rows the
                                                              // part of a before the first ", ") — Go to Artist's title
@property (nonatomic, readonly, copy) NSString *artistURI;    // ar: first artist's uri (nil -> no Go to Artist)
@property (nonatomic, readonly, copy) NSString *album;        // al
@property (nonatomic, readonly, copy) NSString *albumURI;     // alu (nil -> no Go to Album)
@property (nonatomic, readonly, copy) NSString *image;        // i: album cover token (album-page rows: the album's, h.i)
@property (nonatomic, readonly) NSInteger durationMs;         // d (0 = unknown)
@property (nonatomic, readonly) BOOL explicitSong;            // e: draw the E badge
@property (nonatomic, readonly) NSInteger trackNumber;        // tn (album page; 0 = none)
@property (nonatomic, readonly) NSInteger discNumber;         // dn (album page; 0 = none)
@property (nonatomic, readonly) BOOL loading;                 // x: metadata not in yet: only uri is set, draw "Loading…" grey
@property (nonatomic, readonly) BOOL unavailable;             // un: no metadata from Spotify: "Unavailable song", grey, no tap, no •••
@property (nonatomic, readonly) BOOL playable;                // !loading && !unavailable (tappable, has •••)
@property (nonatomic, readonly, copy) NSString *subline;      // artists ("" if none); the screen adds the E badge itself
@property (nonatomic, readonly, copy) NSString *timeText;     // ENTimeText(durationMs), "" when unknown
@property (nonatomic, readonly, copy) NSString *filterKey;    // lowercase "name artists album" (the list filter matches substrings)
@property (nonatomic, readonly, copy) NSString *songKey;      // "name|round(d/1000)": the playing-row fallback match (relinking)
@property (nonatomic, readonly, copy) NSString *uid;          // 0.6 Up Next rows (QR): the queue entry's uid; nil elsewhere
@property (nonatomic, readonly, strong) NSDate *playedAt;     // 0.7 /v1/recent rows: pa (ms since 1970); nil elsewhere
@property (nonatomic, readonly, copy) NSString *byMemberID;   // 0.6 QR `by`: the Jam member who added it (ENJamMember.memberID;
                                                              // never logged); nil = unknown, or not a Jam

+ (instancetype)trackWithJSON:(NSDictionary *)j;              // one TR (or QR); nil without a valid u
// A track dictionary from ENPlayback.track (the snapshot's or the stream marker's: uri, name, artists[], album, duration_ms,
// img, album_uri, artist_uris[], context_track_uri). uri = context_track_uri ?: uri (DESIGN-3 §3.5, §6.4). nil if no uri.
+ (instancetype)trackWithPlaybackTrack:(NSDictionary *)t;
- (NSDictionary *)rowJSON;                                    // the TR keys back (u, n, a, ar, al, alu, i, d, e; absent ones left
                                                              // out): the "rows" of POST /v1/library (§3.4)
@end

// ---------------------------------------------------------------------------------------------------------------- AL / AR
@interface ENAlbumRow : NSObject
@property (nonatomic, readonly, copy) NSString *uri;          // u: spotify:album:<id>
@property (nonatomic, readonly, copy) NSString *name;         // n
@property (nonatomic, readonly, copy) NSString *image;        // i (nil = placeholder)
@property (nonatomic, readonly, copy) NSString *artist;       // ar: primary artist's NAME (the AL key "ar" is a name, not a uri)
@property (nonatomic, readonly, copy) NSString *artistURI;    // aru
@property (nonatomic, readonly) NSInteger year;               // y (0 = unknown)
@property (nonatomic, readonly, copy) NSString *type;         // t: "album" | "single" | "compilation" (nil if absent)
@property (nonatomic, readonly, copy) NSString *copyright;    // cp (album page header only)
@property (nonatomic, readonly) NSInteger length;             // len (album page header only; -1 = unknown)
@property (nonatomic, readonly, copy) NSString *yearText;     // "1974", "" when unknown (artist page sub-line)
@property (nonatomic, readonly, copy) NSString *artistYearText;   // "Artist · 1974" (search sub-line; parts left out when absent)
+ (instancetype)albumWithJSON:(NSDictionary *)j;              // nil without a valid u
@end

@interface ENArtistRow : NSObject
@property (nonatomic, readonly, copy) NSString *uri;          // u: spotify:artist:<id>
@property (nonatomic, readonly, copy) NSString *name;         // n
@property (nonatomic, readonly, copy) NSString *image;        // i (nil = round placeholder)
+ (instancetype)artistWithJSON:(NSDictionary *)j;             // nil without a valid u
@end

// ---------------------------------------------------------------------------------------------------------------- answers
// GET /v1/playlists/<id>, /v1/liked, /v1/albums/<id>: one shape for all three (§3.3).
@interface ENTrackList : NSObject
@property (nonatomic, readonly) ENListKind kind;              // k
@property (nonatomic, readonly, copy) NSString *ctx;          // what Play/Shuffle/row taps play (Liked: spotify:user:<me>:collection)
@property (nonatomic, readonly, copy) NSString *revision;     // v (playlists only; nil otherwise)
@property (nonatomic, readonly, copy) NSString *title;        // h.n ("Liked Songs" for Liked); nil when the header was just {u}.
                                                              // [anon] a playlist's: its masked name
@property (nonatomic, readonly, strong) ENPlaylist *playlist; // kind playlist: h as a PL (+ desc); nil if h had no usable u
@property (nonatomic, readonly, strong) ENAlbumRow *album;    // kind album: h as an AL (+ copyright, length)
@property (nonatomic, readonly, copy) NSArray *tracks;        // ENTrack: every row when done; the first <= 100 when partial
                                                              // (x/un rows included); empty while wait
@property (nonatomic, readonly) NSInteger length;             // len; -1 = unknown (a wait answer may not know it)
@property (nonatomic, readonly) NSInteger have;               // rows with metadata (len minus un rows when done)
@property (nonatomic, readonly) BOOL done;                    // the whole list is here (no x rows)
@property (nonatomic, readonly) BOOL wait;                    // the engine hasn't enumerated yet: no rows, show a spinner
@property (nonatomic, readonly) NSTimeInterval retry;         // retry_ms / 1000 (2.5 s) for partial answers; 0 when done
@property (nonatomic, readonly) BOOL truncated;               // trunc: footer adds "Showing the first 5,000 songs"
@property (nonatomic, readonly) long long totalMs;            // ms (done answers)
@property (nonatomic, readonly) BOOL stale;                   // the gateway served its cache after an upstream failure
+ (instancetype)listWithJSON:(NSDictionary *)j;               // nil if j isn't a track-list answer (no k/ctx)
// Local patches for an optimistic like (§6.4); never written to the disk cache. Both keep done/wait/etc. and fix
// length/have/totalMs. Prepending a uri that is already there returns self.
- (ENTrackList *)listByPrepending:(ENTrack *)track;
- (ENTrackList *)listByRemovingURIs:(NSSet *)uris;
- (NSUInteger)indexOfURI:(NSString *)uri;                     // NSNotFound if absent
// DATA-internal (ENCatalog): meName for a playlist header's "Made for <me>" (listWithJSON: passes nil -> "you"), and
// putting back a row an unlike removed when that unlike fails (index clamped; a uri already there returns self).
+ (instancetype)listWithJSON:(NSDictionary *)j meName:(NSString *)meName;
- (ENTrackList *)listByInsertingTrack:(ENTrack *)track atIndex:(NSUInteger)index;
@end

// GET /v1/playlists: the library root (§3.3).
@interface ENLibrary : NSObject
@property (nonatomic, readonly, copy) NSString *meID;         // me.id (the Spotify username); nil while the gateway doesn't know it
@property (nonatomic, readonly, copy) NSString *meName;       // me.n. [anon] nil (the greeting drops the name; "you" elsewhere)
@property (nonatomic, readonly, copy) NSString *rawMeName;    // (R2a) me.n unmasked: what ENCatalog passes to the parsers
@property (nonatomic, readonly, copy) NSString *likedCtx;     // liked.ctx; nil while unknown (ENCatalog then loads Liked by route)
@property (nonatomic, readonly) NSInteger likedLength;        // liked.len; -1 = unknown (the Liked row shows no count)
@property (nonatomic, readonly, copy) NSArray *playlists;     // ENPlaylist, sidebar order (junk already filtered by the gateway)
@property (nonatomic, readonly, strong) NSDate *checkedAt;    // last time the gateway confirmed it (200 or 304): the footer's
                                                              // "updated <ENRelativeTime>"; nil if never
@property (nonatomic, readonly) BOOL stale;                   // stale:1
+ (instancetype)libraryWithJSON:(NSDictionary *)j checkedAt:(NSDate *)checkedAt;   // nil if j has no items array
- (NSArray *)editablePlaylists;                               // the ed ones, sidebar order (the Add-to picker)
- (ENPlaylist *)playlistForURI:(NSString *)uri;
- (NSInteger)ownCount;                                        // playlists with own (for "My Playlist #N")
- (NSString *)defaultNewPlaylistName;                         // "My Playlist #<ownCount + 1>" (§6.3)
// copies with one change (local patches, posted with ENCatalogChangedNotification)
- (ENLibrary *)libraryWithLikedLength:(NSInteger)len;
- (ENLibrary *)libraryByReplacingPlaylist:(ENPlaylist *)pl;  // same uri replaced in place; appended if absent
- (ENLibrary *)libraryByInsertingPlaylist:(ENPlaylist *)pl;  // at index 0 (a new playlist; any old row with its uri dropped)
- (ENLibrary *)libraryWithCheckedAt:(NSDate *)date;
@end

// GET /v1/artists/<id> (§3.3)
@interface ENArtistPage : NSObject
@property (nonatomic, readonly, strong) ENArtistRow *artist;  // a
@property (nonatomic, readonly, copy) NSArray *popular;       // top: ENTrack (<= 5, with covers)
@property (nonatomic, readonly, copy) NSArray *albums;        // ENAlbumRow (<= 20, newest first)
@property (nonatomic, readonly, copy) NSArray *singles;       // ENAlbumRow (<= 20)
@property (nonatomic, readonly) BOOL stale;
+ (instancetype)pageWithJSON:(NSDictionary *)j;               // nil without a usable a
@end

// GET /v1/search?q= (full first page) and ?q=&type=track&offset=N ("See all songs": songsOnly, only the tracks part) (§3.3)
@interface ENSearchResult : NSObject
@property (nonatomic, readonly, copy) NSString *query;        // q as the gateway echoed it (trimmed, lowercase)
@property (nonatomic, readonly) BOOL songsOnly;               // a See-all-songs page
@property (nonatomic, readonly) ENSearchTopKind topKind;      // top.k
@property (nonatomic, readonly, strong) id top;               // ENArtistRow | ENTrack | ENAlbumRow, nil with ENSearchTopNone
@property (nonatomic, readonly, copy) NSArray *tracks;        // ENTrack (<= 10)
@property (nonatomic, readonly) NSInteger tracksTotal;        // tracks.total
@property (nonatomic, readonly) NSInteger tracksOffset;       // the offset this page was asked for (0 for the first form)
@property (nonatomic, readonly) NSInteger tracksNext;         // tracks.next; -1 = no more pages
@property (nonatomic, readonly, copy) NSArray *artists;       // ENArtistRow (<= 3)
@property (nonatomic, readonly, copy) NSArray *albums;        // ENAlbumRow (<= 3)
@property (nonatomic, readonly, copy) NSArray *playlists;     // ENPlaylist (<= 3; u, n, i, o only: subline "by <o>")
@property (nonatomic, readonly) BOOL stale;
@property (nonatomic, readonly) BOOL empty;                   // no top, tracks, artists, albums or playlists ("Nothing found")
+ (instancetype)resultWithJSON:(NSDictionary *)j offset:(NSInteger)offset;   // nil if j has no q
@end

// ---------------------------------------------------------------------------------------------------------------- 0.6 Jam
// MEM of DESIGN-4b §4.2: one member of the Jam on Encore. memberID, like every Jam id, token and link, never goes into a
// log line or /v1/diag (§4.1 Privacy).
@interface ENJamMember : NSObject
@property (nonatomic, readonly, copy) NSString *memberID;     // id: opaque (the member's username)
@property (nonatomic, readonly, copy) NSString *name;         // n: display name, else the username. [anon] "You" for me, else the
                                                              // member's made-up name (by id)
@property (nonatomic, readonly, copy) NSString *imageToken;   // i: a /v1/img token (88 tier, round); nil -> initials. [anon] nil
@property (nonatomic, readonly) BOOL isHost;                  // h
@property (nonatomic, readonly) BOOL isMe;                    // me: this account
@property (nonatomic, readonly, copy) NSString *displayName;  // "You" for me, else name
@property (nonatomic, readonly, copy) NSString *initials;     // the avatar's fallback: the name's first letter, upper case ([anon]
                                                              // of the made-up name)
@property (nonatomic, readonly, copy) NSString *avatarKey;    // (R2a) what the initials' colour hashes from: memberID ([anon] a keyed
                                                              // hash of it, never the id)
@property (nonatomic, readonly, copy) NSString *rawName;      // (R2a) n unmasked (matching a Jam event's bare name to its member)
+ (instancetype)memberWithJSON:(NSDictionary *)j;             // nil without a valid id
@end

// GET /v1/player/queue: Up Next (DESIGN-4b §4.3), and the `queue` of an Up Next edit's reply (§4.4). Every row is an
// ENTrack with uid (and byMemberID in a Jam); a row the engine has no metadata for yet is a `loading` (x) row with only
// uri and uid.
@interface ENQueue : NSObject
@property (nonatomic, readonly, strong) ENTrack *now;         // now (nil when nothing is loaded)
@property (nonatomic, readonly, copy) NSArray *queued;        // q: provider "queue", engine order
@property (nonatomic, readonly, copy) NSString *contextName;  // ctx.n ("Sam’s Jam" in a Jam); nil when the engine has none. [anon]
                                                              // a Jam: ENJam's title; a library playlist: its masked name
@property (nonatomic, readonly, copy) NSString *contextURI;   // ctx.u
@property (nonatomic, readonly, copy) NSArray *contextRows;   // cq: provider "context"
@property (nonatomic, readonly, copy) NSArray *autoplayRows;  // ap: provider "autoplay"
@property (nonatomic, readonly) BOOL jam;                     // jam:1
@property (nonatomic, readonly) NSInteger retryMs;            // retry_ms (some row is x): ask once more after it; 0 = none
@property (nonatomic, readonly) BOOL empty;                   // no now and no rows
// (4b-c, DESIGN-4b §4.3) the engine's queue revision, sent back with every Up Next edit (never logged); nil from an
// engine without patch 3 item 11. editable: `ed`, this phone may remove and move q and cq rows now (host or no Jam); NO
// without a rev.
@property (nonatomic, readonly, copy) NSString *rev;
@property (nonatomic, readonly) BOOL editable;
+ (instancetype)queueWithJSON:(NSDictionary *)j;              // nil if j isn't an object
@end

// ---------------------------------------------------------------------------------------------------------------- 0.7
// Home (GET /v1/home), Your Library's lists (GET /v1/me/albums, /v1/me/artists, /v1/recent) and your profile (GET /v1/me):
// gateway/src/personal.js is the truth.
typedef enum { ENHomeTilePlaylist = 0, ENHomeTileAlbum, ENHomeTileArtist, ENHomeTileLiked } ENHomeTileKind;

// One card of a Home shelf.
@interface ENHomeTile : NSObject
@property (nonatomic, readonly) ENHomeTileKind kind;
@property (nonatomic, readonly, strong) id item;              // ENPlaylist / ENAlbumRow / ENArtistRow; nil for Liked Songs
@property (nonatomic, readonly, copy) NSString *title;        // [anon] a playlist tile's: its masked name
@property (nonatomic, readonly, copy) NSString *subtitle;     // "Playlist · Spotify", "Single · Artist", "Artist", "1,234 songs"
                                                              // ([anon] a playlist tile's owner masked)
@property (nonatomic, readonly, copy) NSString *image;        // token; nil = placeholder (Liked: the Liked tile). [anon] the playlist's
@property (nonatomic, readonly) BOOL round;                   // artists
+ (instancetype)tileWithJSON:(NSDictionary *)j meName:(NSString *)meName;   // a jump entry {k, o} / {k: liked, len}
+ (instancetype)tileWithItem:(id)item;                        // an ENPlaylist / ENAlbumRow / ENArtistRow; nil otherwise
@end

@interface ENHomePage : NSObject
@property (nonatomic, readonly, copy) NSString *meName;       // me.n (the greeting), nil if absent. [anon] nil
@property (nonatomic, readonly, copy) NSString *meImage;      // me.i (the nav bar's profile button). [anon] nil
@property (nonatomic, readonly, copy) NSString *rawMeImage;   // (R2a) me.i unmasked (ENCatalog's meImageToken)
@property (nonatomic, readonly, copy) NSArray *jump;          // ENHomeTile: Jump back in
@property (nonatomic, readonly, copy) NSArray *made;          // ENHomeTile: Made For You
@property (nonatomic, readonly, copy) NSArray *artists;       // ENHomeTile (round): Your top artists
@property (nonatomic, readonly, copy) NSArray *releases;      // ENHomeTile: New releases for you
@property (nonatomic, readonly, copy) NSArray *top;           // ENTrack: Your top tracks
@property (nonatomic, readonly) BOOL stale;
@property (nonatomic, readonly) BOOL empty;                   // every part empty
+ (instancetype)pageWithJSON:(NSDictionary *)j meName:(NSString *)meName;  // nil if j isn't an object
@end

// /v1/me/albums (ENAlbumRow), /v1/me/artists (ENArtistRow) or /v1/recent (ENTrack with playedAt).
// (0.11 profiles, appended) ENRowListPlaylists: GET /v1/users/<id>/playlists?offset=N (PAGE -> ENPlaylist); ENRowListPeople:
// /v1/users/<id>/followers | /following (PEOPLE -> ENUserRow, or ENArtistRow for k "artist"); ENRowListUsers:
// /v1/search/users (USERS -> ENUserRow).
typedef enum { ENRowListAlbums = 0, ENRowListArtists, ENRowListRecent, ENRowListPlaylists, ENRowListPeople, ENRowListUsers } ENRowListKind;
@interface ENRowList : NSObject
@property (nonatomic, readonly) ENRowListKind kind;
@property (nonatomic, readonly, copy) NSArray *items;
@property (nonatomic, readonly) NSInteger total;              // total (-1 unknown; recent: the row count)
@property (nonatomic, readonly) BOOL stale;
@property (nonatomic, readonly) NSInteger offset;             // (0.11) offset (PAGE; 0 when absent)
@property (nonatomic, readonly) NSInteger next;               // (0.11) next: the next page's offset; -1 = none
@property (nonatomic, readonly) BOOL truncated;               // (0.11) trunc: PEOPLE cut at the gateway's cap
@property (nonatomic, readonly, copy) NSString *query;        // (0.11) q: USERS, the query as the gateway echoed it; nil elsewhere
+ (instancetype)listWithJSON:(NSDictionary *)j kind:(ENRowListKind)kind;   // nil without an items array
// (0.11) the same; meName for the "by <me>" lines of ENRowListPlaylists rows (nil -> "you")
+ (instancetype)listWithJSON:(NSDictionary *)j kind:(ENRowListKind)kind meName:(NSString *)meName;
@end

@interface ENProfile : NSObject
@property (nonatomic, readonly, copy) NSString *uri;          // me.u: spotify:user:<id>
@property (nonatomic, readonly, copy) NSString *name;         // me.n. [anon] "You"
@property (nonatomic, readonly, copy) NSString *image;        // me.i (nil -> initials). [anon] nil
@property (nonatomic, readonly) NSInteger followers;          // me.fol (-1: Spotify no longer sends it). [anon] -1
@property (nonatomic, readonly) NSInteger following;          // me.fing: followed artists (-1 unknown). [anon] -1
@property (nonatomic, readonly, copy) NSString *rawName, *rawImage;    // (R2a) me.n, me.i unmasked (Settings, ENCatalog)
@property (nonatomic, readonly, copy) NSArray *artists;       // ENArtistRow: top artists this month
@property (nonatomic, readonly, copy) NSArray *top;           // ENTrack: top tracks this month
@property (nonatomic, readonly, copy) NSArray *playlists;     // ENPlaylist: your public playlists (as others see your profile)
@property (nonatomic, readonly) BOOL stale;
+ (instancetype)profileWithJSON:(NSDictionary *)j meName:(NSString *)meName;   // nil without me
@end

// ---------------------------------------------------------------------------------------------------------------- 0.11
// Other people (gateway 0.10.0 social.js; DESIGN-PROFILES §2.4, §4.2). Memory only: ENCatalog never writes them to disk.

// USER: a person in people search, a followers / following list or a recent search: {k: "user", u, id, n, i?, fol?, f?}.
@interface ENUserRow : NSObject
@property (nonatomic, readonly, copy) NSString *uri;          // u: spotify:user:<id> (always set, ENUserIDFromURI accepts it)
@property (nonatomic, readonly, copy) NSString *userID;       // id (decoded), else the id from u
@property (nonatomic, readonly, copy) NSString *name;         // n, else the id. [anon] "You" for me, else the made-up name (by id)
@property (nonatomic, readonly, copy) NSString *image;        // i: image token (88 tier, round); nil -> the round placeholder. [anon] nil
@property (nonatomic, readonly) NSInteger followers;          // fol; -1 = absent. [anon] -1
@property (nonatomic, readonly, copy) NSString *rawName, *rawImage;    // (R2a) n (else the id) and i unmasked (Recent searches)
@property (nonatomic, readonly) BOOL following;               // f: I follow them
@property (nonatomic, readonly) BOOL isArtist;                // k "artist" (people lists turn such JSON into ENArtistRow instead;
                                                              // their uri is no spotify:user:, so this stays NO in practice)
+ (instancetype)userWithJSON:(NSDictionary *)j;               // nil without a valid spotify:user: u
@end

// PROFILE: GET /v1/users/<id>: {u, id, n, i?, fol, fing, me?, vf?, f?, cf?, plt, pl: [PL <= 10], ar?: [AR <= 10], stale?}.
@interface ENUserProfile : NSObject
@property (nonatomic, readonly, strong) ENUserRow *user;      // u, id, n, i
@property (nonatomic, readonly) NSInteger followers;          // fol (0 when absent); real in Anonymous Mode too (the screens hide it)
@property (nonatomic, readonly) NSInteger following;          // fing (0 when absent); the same
@property (nonatomic, readonly, copy) NSArray *playlists;     // pl: ENPlaylist (<= 10; u, n, i, o, ou, fol, own)
@property (nonatomic, readonly) NSInteger playlistsTotal;     // plt (0 when absent; never below playlists.count)
@property (nonatomic, readonly, copy) NSArray *artists;       // ar: ENArtistRow, recently played (only when they share them)
@property (nonatomic, readonly) BOOL isMe;                    // me
@property (nonatomic, readonly) BOOL verified;                // vf
@property (nonatomic, readonly) BOOL isFollowing;             // f: I follow them
@property (nonatomic, readonly) BOOL canFollow;               // cf: the gateway can follow / unfollow them now
@property (nonatomic, readonly) BOOL stale;
+ (instancetype)profileWithJSON:(NSDictionary *)j;            // nil without a valid u
+ (instancetype)profileWithJSON:(NSDictionary *)j meName:(NSString *)meName;   // meName: the "by <me>" of my own playlists
// a patched copy (a confirmed follow / unfollow): isFollowing = f and followers +- 1 when that changed it
- (instancetype)profileWithFollowing:(BOOL)f;
// (DATA-internal) the same with the gateway's own count when it sent one (followers >= 0)
- (instancetype)profileWithFollowing:(BOOL)f followers:(NSInteger)followers;
@end


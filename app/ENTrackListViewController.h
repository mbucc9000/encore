#import "ENListViewController.h"
#import "ENModel.h"

// Playlist, Liked Songs and album screens (owner: UI; DESIGN-3 §5.5).
//   Header (136 pt, 0.11: or more; tableHeaderView): 108 pt framed cover at the 216 tier (Liked: ENTheme
//   likedTileLarge); title (2 lines, bigTitleFont); a green link line (playlist: pl.linkLine; album: the artist, tapping
//   pushes ENArtistViewController);
//   a meta line ("N songs · X hr Y min"; album "YYYY · N songs · X min"; "N songs" alone until done); a green Play and a
//   Shuffle button (they need only ctx, so they work while the list is partial); a description strip when pl.desc.
//   The opened-from row draws the header at once; the answer's h replaces it when it has a name.
//   Filter bar (44 pt UISearchBar in the tableHeaderView, below the header): filters filterKey on the main thread,
//   debounced 150 ms; disabled until done.
//   Rows: playlist ENCellArtNone; Liked ENCellArtCover; album ENCellArtNumber. x/un rows dimmed, untappable, no •••.
//   Tap = [ENPlayback playContext:list.ctx offsetURI:row.uri] (filtered rows keep their own uri).
//   Partial state: wait -> spinner under the header; else the rows so far + a footer "Loading songs… <have> of <len>"; the
//   screen polls [ENCatalog pollList:] every list.retry while visible and gives up after 2 minutes ("Still loading. Pull to
//   refresh."). A wait / partial answer while the screen already shows a done list (the gateway re-reading it: pull to
//   refresh, a like on another device, an add) never replaces it: the rows and the filter stay, the footer says "Updating… <have>
//   of <len>" with a spinner, and the done answer swaps in when the polls get it. "Showing a saved copy" / the give-up
//   banner go again with the next good answer. Playing row: green title + speaker ([ENPlayback isPlayingRow:]); a song
//   change only updates the visible cells' `playing`.
//   Footer when done: "N songs, X hr Y min" (+ " · Showing the first 5,000 songs" when truncated). "No songs yet" only when
//   done and length == 0.
//   Liked only: swipe to delete with the button titled "Remove" -> [ENTrackActions setTrack:saved:NO]; kind liked
//   notifications replace the rows with [ENCatalog shared].likedList.
//   kind list notification for this list (Liked: ENCatalogURIKey == ENLikedListURI) -> loadList:fresh:NO now if visible,
//   else on the next viewWillAppear.
// 0.9.2 (DESIGN-0.9.2):
//   §1 An editable playlist (own or collaborative; the library's PL `editable`): a song row's ••• has "Remove from This
//   Playlist" (ENTrackMenuRemoveFromPlaylist; the screen is the sheet's ENTrackMenuPlaylistScreen). Optimistic: every row of
//   the song fades out at once and the header / footer counts follow, then [ENTrackActions removeTrack:fromPlaylist:done:]
//   (HUD "Removed from <name>"); a failure brings the rows back and alerts. Until a network copy of the whole list settles
//   it, every copy shown has the removed song taken out (the catalog hands out the copy it had until the gateway's re-read
//   is done), on any page of that playlist.
//   §2 Playlists and Liked: a "Sort" button at the right end of the filter row (a bar-style one-segment control, the bar's
//   Cancel button look; "Sort: Title" when sorted; it fades out while the filter is typed in, enabled with the filter).
//   "Sort by" sheet: Custom order (Liked: Recently added) / Title / Artist / Album, "✓ " on the current one; kept per list
//   in NSUserDefaults "encore.sort.<list uri>". Case / diacritic-insensitive, stable (ties in the list's order); Artist =
//   artists, album, then the album's order when known; Loading… / Unavailable rows stay at the end in their order. The
//   filter works on the sorted rows. A row tap still plays the list's context from that song (in the list's own order), so
//   while sorted a small grey note under the rows says "Plays in the playlist's own order" (Liked: "Plays in Liked Songs' own
//   order"); the header's count and duration don't change. Albums have neither.
// 0.9.4 (DESIGN-DATE-ADDED): Sort by Date added. Playlists: "Date added (newest first)" / "Date added (oldest first)" after
//   the others ("Sort: Newest first" / "Sort: Oldest first"; stored "added_newest" / "added_oldest"). The dates come from
//   [ENCatalog loadAddedDates:]; until they do the rows keep the order they are in (a small spinner left of Sort), then they
//   sort: by position when the gateway's entries are the list's rows one for one (a song in it twice keeps each add's date),
//   else uri -> its latest date; rows without a date and Loading… / Unavailable rows last in the list's order; ties in the
//   list's order. Re-sorted whenever the list reloads; the dates are asked for again only when the list's revision changed or
//   the catalog dropped them (a kind list). A failure shows the banner and the list's own order (the choice stays; a pull to
//   refresh or choosing it again retries); the gateway's saved copy of them sorts the rows with "Showing a saved copy" and is
//   asked for again the same way. Liked Songs: "Recently added" (its own order) and "Date added (oldest first)" (that
//   order backwards, no request). The "Plays in … own order" note shows whenever the rows are in another order.
// 0.11 (DESIGN-5 §2.2, Drop 3b, the 0.10.0 bug "the play and shuffle buttons sometimes overlap the title"): the header's
//   cover block is 136 pt or taller. Its text column (title up to 2 lines, the second truncated; the link line; the meta
//   line) is measured and the Play / Shuffle row (and an album's ♥) goes at its old place, or 8 pt under the meta line when
//   the text reaches lower (a 2-line title: ~142-146 pt), never over the text; the table header is re-set when it grows.
// 0.11 profiles (gateway 0.10.0, DESIGN-PROFILES §4.4; owner of these two parts: PROFILES-APP):
//   Owner link: on a playlist, the green "by <owner>" line opens the owner's ENProfileViewController (the user's own
//   playlists: their own profile) when the header's PL (the answer's h, else the opened-from row, else the library's row) has an `ou` that
//   ENUserIDFromURI accepts, it isn't Made For You, and [ENCatalog profilesAvailable]. Albums keep their artist link.
//   Follow (P3): on someone else's playlist (not own, not Made For You) while [ENCatalog canSavePlaylists] and the saved state
//   is known, the right bar item is "Follow" (Done style, the bright green) or "Following" (Bordered), as the mockup's
//   followed-playlist page: optimistic [ENCatalog setPlaylist:saved:done:] with the HUD "Added to Your Library" (heart) /
//   "Removed from Your Library" (x); a failure reverts and alerts, a 501 takes the item away. It follows kind library (and kind
//   user without a uri). Other people's playlists stay read-only (the library doesn't list them as editable: no Remove).
// Drop 3c (DESIGN-5 §2.3 C2, §2.4 #10; 1.0.0; owner C2):
//   Header (the mockup's .hdr): 34 pt buttons from the C7 kit (+[ENTheme configureButton:…]): Play = the green gbtn with the
//   .pi disc, Shuffle = an icon-only 38 pt silver button, and on albums the Save pill (a 38 pt silver icon button: the outlined
//   heart, the filled #3fae3a heart while the album is in Your Library; the 0.9 ♥'s toggle, bounce and revert, its HUD now with
//   C6's heart / x glyph), 6 pt apart (~163 pt: the 175 pt column). The 0.11 measured layout is re-done for them: the text
//   column (title 2 pt under the cover's top, link 3 pt under it in linkFont Bold 15 / accent, meta 2 pt under that in metaFont
//   13) is measured and the button row rests with its bottom on the cover's (y 88), or goes 8 pt under the meta line when the
//   text reaches lower (a 2-line title), the block growing to 14 pt under it: the buttons never cover the title (2 lines max)
//   at any title length; no header font follows Text size, so neither does the layout. Every colour and font is an ENTheme
//   token. The cover fades in (ENFadeIn) when it comes from disk or the network.
//   Album footer: "℗ <year> <label>" from the answer's ENAlbumRow.copyright (none without one; no longer the meta again).
//   Liked: the owner line "by <me>" (the library's me.n), opening the user's own profile (ENProfileViewController -init).
//   Swipe left on a playable row of an editable playlist (the pages whose ••• has Remove from This Playlist): "Delete", the
//   very same optimistic remove as that ••• item (every copy fades out; HUD, sRemoved and the revert as there). Liked keeps
//   its "Remove". Albums and other people's playlists have no swipe.
//   Empty states: "Couldn't load these songs." / "Pull to refresh."; an empty playlist that can take songs "No songs yet" /
//   "Find songs in Search, tap ••• and choose “Add to Playlist…”." (Liked, albums and others' playlists: the title alone).

@class ENLibrary;

@interface ENTrackListViewController : ENListViewController <UISearchBarDelegate>

- (instancetype)initWithPlaylist:(ENPlaylist *)pl;                  // a library or search PL row
- (instancetype)initWithAlbum:(ENAlbumRow *)al;                     // an AL row (search, artist page)
// Go to Album / Now Playing's Album button: only the uri, the album name and its cover token are known (any may be nil
// except uri).
- (instancetype)initWithAlbumURI:(NSString *)uri title:(NSString *)title image:(NSString *)token;
- (instancetype)initWithLikedLibrary:(ENLibrary *)library;          // Liked Songs (library for the count; may be nil)

@property (nonatomic, readonly) ENListKind kind;
@property (nonatomic, readonly, copy) NSString *listURI;            // what it loads (ENLikedListURI for Liked)
@property (nonatomic, readonly, strong) ENTrackList *list;          // what it shows now (nil before the first delivery; 0.9.2:
                                                                    // less the songs being removed), in the list's own order

@end

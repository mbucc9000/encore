#import <UIKit/UIKit.h>

// The "Saved in" sheet (owner: ACTIONS; DESIGN-0.9 §3b, was DESIGN-3 §6.2's picker): like the real Spotify app's, it shows
// where the song already is and adds to / removes from any number of playlists at once. Modal inside its own
// UINavigationController (green nav bar).
//   Title "Add to Playlist", Cancel (left, discards), Done (right; enabled while any tick differs from the start). A strip
//   at the top: 22 pt thumbnail (88 tier of track.image) and "Song — Artists".
//   Rows (ENListCell): "New Playlist…" with [ENTheme iconTileNamed:@"newPlaylist" size:42] (3c, C4: the green icon tile with
//   the circled plus; was newPlaylistTile) -> [ENTrackActions newPlaylistFrom:self track:] (creates
//   + adds at once, then dismisses; unchanged); then a "Your playlists" section: "Liked Songs" (likedTile; checked =
//   [ENCatalog savedStateForURI:track.uri], checkSaved: on open), then [ENCatalog shared].library.editablePlaylists (each
//   uri once) with the pinned ones first ([ENPins orderPlaylists:], with the cell's pin glyph), then sidebar order;
//   showPlaylist: without the chevron. Each of these rows carries a mark on the right: a green disc with a tick when checked, an empty grey ring
//   when not.
//   Playlist checks come from -[ENCatalog loadPlaylistsContaining:done:] (uri -> @YES/@NO); while the answer has pending > 0
//   it asks again every 2 s (at most 10 times), filling in rows the user hasn't touched, with a grey "Checking your
//   playlists…" footer meanwhile. Footer otherwise: "Only playlists you own or collaborate on can be changed." (or why the
//   checks are missing). No library yet: a spinner while loadLibrary:NO runs.
//   Tapping a row toggles its tick (no request). Done: HUD "Saving…", then the difference one request after another —
//   Liked via setSaved:tracks:done:, adds via addTrackURIs:toPlaylist:allowDuplicates:NO (409 duplicate = already there =
//   success), removes via removeTrackURIs:fromPlaylist:done: — then HUD "Added to <name>" / "Removed from <name>" (one
//   change), "Saved in N playlists" (several, all adds) or "Changes saved"; failures -> an alert naming the playlists that
//   failed with the first error's [ENCatalog messageForError:]. Dismisses 0.8 s later.
//   Taps are ignored while saving; Cancel while saving just dismisses (the requests and their final HUD / alert still run).
//   Every dismissal ends with -[ENTabBarController reclaimFirstResponder] (or Now Playing becoming first responder again).
// Drop 3a (DESIGN-5 A3): themed from ENTheme (Light / Dark): the green section header is the lists' ENSectionHeaderView, the
// strip, the checks (pickerCheckImage:) and the footer use the palette's tokens, the title shows at 17 pt, the rows follow the
// Text size; ENThemeDidChangeNotification re-skins the open sheet in place (ticks and a running save untouched).
// Drop 3c (DESIGN-5 §2.3 C4; owner C4): only the "New Playlist…" tile changes.
// Main thread only. Logs counts only, never song or playlist names.

@class ENTrack;

@interface ENAddToPlaylistViewController : UITableViewController

- (instancetype)initWithTrack:(ENTrack *)track;     // track.uri is what gets added (a row's u, or playingURI)

@end

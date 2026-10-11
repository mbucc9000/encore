#import <UIKit/UIKit.h>

// Now Playing (owner: UI; DESIGN-3 §5.5, §6), presented modally (full screen, cover vertical) by ENTabBarController.
// 0.8.2: dragging down (anywhere but the scrubber, the volume slider or open lyrics) puts it away like Spotify: it follows
// the finger over a snapshot of the tab controller, and past 1/4 of the height (or a flick) it is dismissed.
//   Art: 320 x 320 pt, [ENPlayback shared].artwork (640 tier), with a buffering overlay. (R2c, 3.5-inch screens) The column
//   is laid out from the view's real height and only the art gives way: 232 x 232, centred, on a 3.5-inch screen (460 pt
//   under the status bar), so the bottom bar stays whole; the lyrics then still use the full width of the art's row.
//   Album and Artist (playingTrack.albumURI / .artistURI): dismiss, then push onto the selected tab
//   (-[ENTabBarController showViewController:] with ENTrackListViewController / ENArtistViewController).
//   ♥ = an ENHeartButton (followsPlayback), ⊕ = [ENTrackActions addToPlaylist:playingTrack from:self],
//   More = [ENTrackActions showMenuForTrack:playingTrack from:self options:ENTrackMenuNoGoTo busy:nil].
//   viewWillAppear: [[ENCatalog shared] checkSaved:@[playingURI] done:nil] (a heart liked on another device shows, T-c5).
// It is first responder while shown (forwards remote events to ENPlayback) and calls -[ENTabBarController
// reclaimFirstResponder] when dismissed. 0.10 (A2): UIStatusBarStyleBlackOpaque while it is up (put back when it goes).
// 0.6 (DESIGN-4b §6.7): a Jam guest without control can't skip, seek, shuffle or repeat here (alpha .4); play / pause =
// listen / stop (ENPlayback). The Up Next button presents ENQueueViewController (flip); it is hidden while ENJam isn't
// available or the gateway answered 404 (queueMissing).
//
// Drop 3b (DESIGN-5 §2.2 B2, owner B2; 0.11.0), the mockup's Now Playing:
//   Bar: a real UINavigationBar (the global green skin): a glossy chevDown (dismiss) on the left, a glossy `list` (Up Next)
//     on the right, and a two-line title, the artists (Bold 12 #c9c9c9) over the song (Bold 17 white), within x 54 … W-54.
//   Strip (82 pt): row 1 (y 3) the Jam pill, else "Listening on <device>" (pb.remoteDevice), else "Playing from <name>"
//     (a name the app already knows: Liked Songs, a library playlist, the song's album or artist; else Up Next's ctx.n, one
//     ETag'd GET /v1/player/queue per new context); the scrubber (the slider kit, 38 pt times) at y 24; repeat | ♥ ⊕ |
//     shuffle at y 46 (22 pt glyphs; repeat-one = the glyph + a "1" badge).
//   Art: one pan (|vx| > 1.2·|vy|) instead of the two swipes: the art follows the finger, clipped to its frame; past 70 pt or
//     on a 600 pt/s flick it slides out, skips, waits for the new song (4 s at most) and slides in; else it springs back. A
//     guest without control gets a .2 rubber band and no skip. A tap still toggles the lyrics.
//   Transport: full-height separators and a pressed overlay; while loading && playing a white spinner replaces the play glyph.
// 0.11.1 (DESIGN-5 §2.2, feedback on 0.11.0: all on one bar was better): B2's bottom pager (Volume / Actions /
//   Device) is gone and the 0.10 bottom bar is back as it was, one 44 pt row on 0.10's dark bar: the MPVolumeView as 0.10
//   had it (the stock iOS 6 slider, not the slider kit, and the AirPlay route button) on the left, then Lyrics | Album |
//   Artist | Jam (only while ENJam is available) | More, 42 x 44 each, flush right 2 pt from the edge (the volume gets the
//   rest of the width): 20 pt glyphs over Bold 10 labels in the 0.10 colours, disabled glyphs #5b6a54, Lyrics green while
//   the lyrics are open. B2's "Add to" button went with the pager (⊕ in the strip does it, as in 0.10). The Connect bar's
//   tap simply presents Now Playing.
// 0.11.2 (a tap on "Playing from" opens where the song is being played from): the strip's
//   "Playing from <name>" line is tappable when its context has a page: Liked Songs (encore:liked, any
//   spotify:user:<u>:collection, the library's liked.ctx) -> the Liked Songs page; a playlist (spotify:playlist:<id> or the
//   legacy spotify:user:<u>:playlist:<id>, the same playlist) -> its page (the library's row, else a row of the uri and the
//   name shown: someone else's playlist opens like a search result's); spotify:album:<id> -> the album page;
//   spotify:artist:<id> -> the artist page (ids: 22 base62, what the gateway's routes take). Anything else (search, station /
//   radio, a single song, unknown, none), "Listening on <device>" and the Jam pill are not. A tappable line is the name (still
//   tail-truncated) and a chevRight 12 in npCountText, centred together, over a button with npTransportPressed while pressed;
//   accessibility label "Open playlist" / "Open album" / "Open artist" / "Open Liked Songs". The tap goes the way Album /
//   Artist go (-[ENTabBarController showViewController:]: dismiss, push onto the selected tab, the controls handed back);
//   when that page (same kind, same uri) is already the selected tab's top, it only dismisses. It follows every refresh
//   (song / context, Jam, remote device, the name arriving).

@interface ENNowPlayingViewController : UIViewController

@end

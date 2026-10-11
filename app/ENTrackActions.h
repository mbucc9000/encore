#import <UIKit/UIKit.h>

// What can be done with a song (owner: ACTIONS; DESIGN-3 §6): the ••• sheet, like / unlike, Add to Queue, Add to Playlist,
// New Playlist, Go to Album / Artist. The UI only ever calls these class methods; all feedback (HUD, alerts, the picker) is
// handled here. Main thread only.
//
// The sheet (§6.1): a UIActionSheet (0.10: ENActionSheet, green, its title two lines: the song bold, the artists under it)
// with, in order: "Add to Playlist…", "Add to Queue",
// "Save to Liked Songs" / "Remove from Liked Songs", "Go to Album", "Go to Artist" (each left out when the options say so or
// the track has no albumURI / artistURI), "Cancel". Shown with -showFromTabBar: when `from` is inside ENTabBarController
// (so the tab bar can't swallow the bottom buttons), else -showInView:from.view (Now Playing, modal).
// When the saved state is unknown ([ENCatalog savedStateForURI:] nil): busy(YES), [ENCatalog checkSaved:@[uri]], and the
// sheet opens on the answer or after 1.5 s (then treated as not saved), after busy(NO).
//
// Like (§6.4): optimistic via -[ENCatalog setSaved:tracks:done:]; the HUD says "Saved to Liked Songs" / "Removed from Liked
// Songs" at once; a failure shows an alert with [ENCatalog messageForError:] (the catalog has already reverted the hearts).
// Add to Queue: [ENPlayback addToQueue:done:]; HUD "Added to Queue". On 409 not_active: if [ENPlayback shared].remoteDevice
// is set, a UIAlertView "Play on Encore?" / "Spotify is playing on <device>. Play this song on Encore instead?"
// [Cancel] [Play]; otherwise [ENPlayback playURI:] at once (§5.5). Other errors: an alert with the message.
// Go to Album / Artist: -[ENTabBarController showViewController:] with ENTrackListViewController initWithAlbumURI:title:image:
// / ENArtistViewController initWithArtistURI:name:.
// 0.6 (DESIGN-4b §6.9): while a Jam is on ([ENJam shared].active) "Add to Queue" is "Add to Jam" (left out when the Jam's
// x.add is absent): the same POST /v1/player/queue (the gateway picks the mechanism), HUD "Added to the Jam" with the people
// glyph, and a 409 unsupported shows its message in an alert. The not_active path is unchanged outside a Jam.
// 0.9.2 (DESIGN-0.9.2 §1): on an editable playlist's own page (ENTrackMenuRemoveFromPlaylist, `from` an
// ENTrackMenuPlaylistScreen) a song's sheet starts with "Remove from This Playlist" as its destructive (red) button; the
// screen does the rest. Every other sheet is unchanged.
// 0.10 (Drop 3a, DESIGN-5 §2.1 A2): the look only. Sheets are ENActionSheet (boldLine = the song name, the artists on line
// 2) and alerts ENAlertView (ENSheets.h); every delegate, handler and one-at-a-time guard is as before. The HUDs carry the
// DESIGN-5 C6 glyphs: Saved to Liked Songs -> heart, any removal -> x, Added to Queue -> queue, Added to the Jam -> people,
// Added to <playlist> -> the check (the default). The Add-to picker's nav bar takes the global green appearance.

@class ENTrack, ENPlaylist;

typedef enum {
	ENTrackMenuDefault = 0,
	ENTrackMenuNoGoTo = 1 << 0,          // Now Playing: no Go to Album / Go to Artist (it has its own buttons)
	ENTrackMenuNoAlbum = 1 << 1,         // on that album's own page
	ENTrackMenuNoArtist = 1 << 2,        // on that artist's own page
	ENTrackMenuRemoveFromPlaylist = 1 << 3,   // (0.9.2) an editable playlist's own page: "Remove from This Playlist" (songs
	                                          // only, and only when `from` conforms to ENTrackMenuPlaylistScreen)
} ENTrackMenuOptions;

// (0.9.2, DESIGN-0.9.2 §1) A screen showing an editable playlist's songs (ENTrackListViewController). Choosing "Remove from
// This Playlist" calls it back once the sheet is gone: it takes the song's rows away at once (optimistic) and calls
// +removeTrack:fromPlaylist:done:.
@protocol ENTrackMenuPlaylistScreen <NSObject>
- (void)trackMenuRemoveFromPlaylist:(ENTrack *)track;
@end

@interface ENTrackActions : NSObject

// The ••• of a playable row (never x / un rows), of Search songs, and Now Playing's More. busy(on) lets the caller show a
// spinner in place of its ••• while the saved state is checked (may be nil; called on the main thread, YES then NO).
+ (void)showMenuForTrack:(ENTrack *)track from:(UIViewController *)from options:(NSUInteger)options busy:(void (^)(BOOL on))busy;

// ♥ (mini player, Now Playing): flips the saved state ([ENCatalog savedStateForURI:], unknown counts as not saved).
+ (void)toggleSaved:(ENTrack *)track;
// ••• Save / Remove, and the Liked list's swipe "Remove".
+ (void)setTrack:(ENTrack *)track saved:(BOOL)saved;

+ (void)addToQueue:(ENTrack *)track;
+ (void)addToQueueURI:(NSString *)uri;     // (0.6) the same for a bare uri: a guest's song tap (ENJamActions, §6.9)

// "Add to Playlist…" and Now Playing ⊕ (with [ENPlayback shared].playingTrack, the song being heard): presents
// ENAddToPlaylistViewController in its own UINavigationController from `from` (modally).
+ (void)addToPlaylist:(ENTrack *)track from:(UIViewController *)from;

// (0.9.2, DESIGN-0.9.2 §1) "Remove from This Playlist": [ENCatalog removeTrackURIs:@[uri] fromPlaylist:pl] (every copy of the
// song goes). Nothing optimistic here: the caller has already taken its rows away. Success: HUD "Removed from <name>", then
// done(nil). Failure: done(error) (the caller puts its rows back), then an alert "Couldn't remove" with [ENCatalog
// messageForError:]. Returns NO and does nothing for a non-song or while a remove of the same song from the same playlist
// is still running (a second one is ignored). done may be nil.
+ (BOOL)removeTrack:(ENTrack *)track fromPlaylist:(ENPlaylist *)pl done:(void (^)(NSError *error))done;

// The New Playlist alert (§6.3): UIAlertViewStylePlainTextInput, title "New Playlist", message "Enter a name for this
// playlist.", placeholder "My Playlist", [Cancel] [Create], at most 100 characters (trimmed; empty -> the library's
// defaultNewPlaylistName). Creates with track's uri when track is non-nil (the picker; HUD "Added to <name>", or the
// add_error in an alert) or empty (the Playlists "+" button). done(created) after success only (not on Cancel / failure;
// failures show an alert). The HUD "Creating…" shows while the request runs.
+ (void)newPlaylistFrom:(UIViewController *)from track:(ENTrack *)track done:(void (^)(ENPlaylist *created))done;

+ (void)goToAlbumOf:(ENTrack *)track;
+ (void)goToArtistOf:(ENTrack *)track;

@end

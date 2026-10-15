#import <UIKit/UIKit.h>
#import "ENImageCache.h"

// The one table cell of the 0.5 lists (owner: UI; DESIGN-3 §5.6; Drop 3a: package A3, DESIGN-5 §2.1 / C3). One row height per
// table, from the Text size setting (ENTheme rowHeight: 44 / 48 / 54; 60 pt "tall" for Search's Top Result, tallRowHeight).
// Everything is drawn in ONE opaque content view's -drawRect: (no UILabels, no Auto Layout, no shadows, no cornerRadius):
//   8 pt left inset | art column | then 8 pt | the playing speaker (inline, before the title) | title (ENTheme titleFont, one
//   line, tail ellipsis) over sub-line (subFont; the 0.9 pin glyph and the E badge lead it) | then on the right, each 8 pt
//   from the text and from each other: avatar, ••• (31 pt disc, 50 pt hit area), chevron; 8 pt right inset.
//   Art column: ENCellArtCover = a 40 pt box (ENTheme's thumb frame: a 1 pt ring and, in Light, a 1 pt drop line) holding a
//   38 pt image (54 / 52 on a tall row); ENCellArtRound = the same box, round (the image itself is round, ENImageCache
//   round:YES); ENCellArtNumber = the track number in a numberColumnWidth column (album rows). A row without art starts its
//   text at 12 pt (in line with the section headers' text).
//   (A3, feedback: titles were cut off and the pictures not fully to the left): the art moved left (12 -> 8 pt inset, 10 ->
//   8 pt gap), the box went 44 -> 40 pt (the Small size's 44 pt row has no room for a 44 pt box, and covers keep one box at
//   every size), the right side lost its spare padding (10 -> 8 pt inset, no extra 4 pt), the fonts follow the text size
//   (15.5 / 12.5 pt at Default): on a 320 pt row a song's title now gets 217 pt (was 202 pt at 16.5 pt).
// backgroundView / selectedBackgroundView are UIImageViews of the theme's stretchable cellBackground /
// cellSelectedBackground (cellPlayingBackground while playing); selected rows draw a white title with a black .25 shadow
// above it.
// Theme (DESIGN-5 §1.2): `theme` nil (the default) follows +[ENTheme current]; an explicit palette stays (Up Next: +queue).
// prepareForReuse re-reads it, and the list base calls -reloadTheme on its visible cells on ENThemeDidChangeNotification.
// Editing (4b-c, Up Next's edit mode and swipe-to-remove; DESIGN-4b §6.10): the draw lays out in the content view as UIKit
// narrows it (indent, delete control, reorder control), and the ••• (button and glyph) and the 22 pt avatar are hidden;
// -setEditing:animated: causes one redraw. The screen sets showsReorderControl (its editable rows only).
// Reuse: register the class with -registerClass:forCellReuseIdentifier: and dequeue with ...forIndexPath: (iOS 6; 1.1: through
// ENCompat's ENRegisterCellClass / ENDequeueCell, which do the same on iOS 5).
// prepareForReuse cancels the cell's pending ENImageCache key and clears every field.
// Drop 3b (DESIGN-5 §2.2 B3, C3; owner B3): Up Next's extras, on the right of the text, each ENCellGap apart, in mockup
// order: [text] [the 22 pt avatar, or the source tag] [the duration] [•••] [chevron]. `sourceTag` (QUEUE / AUTOPLAY) is drawn
// like the E badge (ENTheme sourceTagFont, sourceTagText on sourceTagQueue / sourceTagAutoplay, a 13 pt box, radius 3, 4 pt
// padding; cellDimmed fill on a dimmed row); the avatar replaces it when both are set. `showsDuration` draws the ENTrack
// item's timeText in durationFont / cellDuration. Both hide while editing, like the ••• and the avatar. The E badge is drawn
// only while +[ENTheme showsExplicitBadges] (Settings → Explicit Badges); a change posts ENThemeDidChangeNotification, and
// the list base's -reloadTheme on the visible cells and reloadData redraw the rows.
// Drop 3c (DESIGN-5 §2.3 C1, C11; owner C1): covers fade in. When -setImageToken:'s picture arrives from disk or the network
// (the async ENImageCache done) while the row is on screen, the row cross-fades to it in 0.18 s (ENFadeIn on the one canvas:
// no new view or layer); a memory hit still shows at once, with no fade (P4), and prepareForReuse stops a fade still running.
// Metrics, Text size and every other behaviour are unchanged.
// Main thread only.

@class ENTheme, ENTrack, ENPlaylist, ENAlbumRow, ENArtistRow, ENListCell;

// (3b) Up Next's source tag (0 none, 1 queue, 2 autoplay)
typedef enum {
	ENCellSourceNone = 0,
	ENCellSourceQueue,        // "QUEUE" on sourceTagQueue (#74d150)
	ENCellSourceAutoplay,     // "AUTOPLAY" on sourceTagAutoplay (#6aa8ff)
} ENCellSource;

typedef enum {
	ENCellArtNone = 0,        // no art column (title + "(E) artists"; 0.9.4: no song list uses it any more)
	ENCellArtCover,           // 40 pt box, 38 pt image (88 tier): playlists, albums, Liked / Popular / search songs
	ENCellArtRound,           // round artist image (88 tier, round:YES)
	ENCellArtNumber,          // the track number (album rows)
} ENCellArt;

@protocol ENListCellDelegate <NSObject>
- (void)listCellDidTapMore:(ENListCell *)cell;        // the ••• button (only shown when showsMore)
@optional
- (void)listCellDidSwipeToQueue:(ENListCell *)cell;   // a playable song row dragged right past the green strip
- (NSString *)listCellSwipeTitle:(ENListCell *)cell;  // (A3) the strip's label, asked as each swipe begins: "Add to Queue",
                                                      // or "Add to Jam" while a Jam is on; not implemented = "Add to Queue"
// (DESIGN-QUEUE §5.3) may this row swipe right? Asked as each swipe begins, after the row's own checks (a playable, not
// dimmed row, not editing). Implemented, it replaces the Jam rule (no Jam, or a role that can add): Up Next says YES for
// a row it can move to the top (Play Next). Not implemented = that rule (every other screen).
- (BOOL)listCellSwipeAllowed:(ENListCell *)cell;
// (1.1, iOS 5 only) may the row highlight? iOS 5 never asks tableView:shouldHighlightRowAtIndexPath: (iOS 6): the cell asks
// this before it highlights (ENListViewController answers with that method). Not asked on iOS 6; not implemented = YES.
- (BOOL)listCellShouldHighlight:(ENListCell *)cell;
@end

@interface ENListCell : UITableViewCell

+ (NSString *)reuseIdentifier;                        // @"ENListCell"

@property (nonatomic, weak) id<ENListCellDelegate> delegate;
@property (nonatomic, strong) id item;                // the row's model (ENTrack / ENPlaylist / ENAlbumRow / ENArtistRow / nil)
// The palette the row draws with. Set nil (the default) = it follows +[ENTheme current]; set a palette = it stays on it
// (Up Next sets +[ENTheme queue]). Reads back the palette in use, never nil. Setting it re-skins the row at once.
@property (nonatomic, strong) ENTheme *theme;
- (void)reloadTheme;                                  // (A3) re-reads `theme` (and the text size) and redraws: the list base
                                                      // calls it on its visible cells when the theme or the text size changes

// Raw fields (each setter redraws; the show... methods below set them all at once).
@property (nonatomic, copy) NSString *title;
@property (nonatomic, copy) NSString *subtitle;
@property (nonatomic) ENCellArt art;
@property (nonatomic) NSInteger number;               // ENCellArtNumber; 0 = blank
@property (nonatomic, strong) UIImage *image;         // the art (nil -> placeholder)
@property (nonatomic, strong) UIImage *placeholder;   // default ENTheme placeholderCover / placeholderArtist (round)
@property (nonatomic) BOOL explicitBadge;             // E before the sub-line (badgeFont: it scales with the text size); (3b) drawn
                                                      // only while +[ENTheme showsExplicitBadges]
@property (nonatomic) BOOL pinned;                    // (0.9, DESIGN-0.9 §2) a small green ENTheme `pin` glyph before the sub-line
                                                      // (and before any E badge): a pinned playlist on the Playlists tab
@property (nonatomic) BOOL showsMore;                 // the ••• button
@property (nonatomic, strong) UIImage *moreGlyphOverride;   // (0.9.5) drawn in place of the ••• glyph, centred in its 31 pt slot
                                                      // (Search's recent rows: ENTheme `close`, a ×); same 50 pt hit area,
                                                      // same -listCellDidTapMore:, still needs showsMore; nil = •••. The show...
                                                      // methods clear it (set it after them)
@property (nonatomic) BOOL moreBusy;                  // a small spinner in place of ••• (the saved-state check, §6.1)
@property (nonatomic) BOOL showsChevron;
@property (nonatomic) BOOL playing;                   // green title led by the speaker glyph (A3: inline, 6 pt before the title;
                                                      // ENTheme playingGlyph, sized by the text size) + the playing background
@property (nonatomic) BOOL dimmed;                    // grey title and sub-line (x / un rows); no •••, the screen makes it untappable
@property (nonatomic) BOOL tall;                      // 60 pt layout (Top Result: bigger art)
@property (nonatomic, strong) UIColor *titleColor;    // (UI addition) overrides the theme's title colour; nil = theme
@property (nonatomic) ENCellSource sourceTag;         // (3b) Up Next's QUEUE / AUTOPLAY tag right of the text (not with an avatar)
@property (nonatomic) BOOL showsDuration;             // (3b) the song's length (ENTrack timeText) right of the text, left of •••

// Shows `token`'s 88-tier image: the memory copy at once, else the placeholder and an async load that redraws only if this
// cell still waits for that key (3c: fading in, while on screen). round follows `art` (ENCellArtRound). nil token =
// placeholder.
- (void)setImageToken:(NSString *)token;

// (0.6, DESIGN-4b §6.10) Up Next's "added by": a 22 pt avatar drawn right of the text, before the •••, in the same single
// draw: the member's picture (88 tier, round) when ENImageCache has it in memory, else the initials of name on memberID's
// colour (ENAvatarView); a load is started and the cell redraws when it arrives. name nil = no avatar. The show... methods
// clear it (set it after them).
- (void)setAvatarToken:(NSString *)token name:(NSString *)name memberID:(NSString *)memberID;

// (R2a, Anonymous Mode) a person's row with no picture to show: the round art column draws an initials disc (ENAvatarView's
// look: the first letter of name on key's colour) in place of the placeholder; a picture set later still wins. name nil =
// none. The show... methods clear it (set it after them).
- (void)setInitialsName:(NSString *)name key:(NSString *)key;

// The show... methods reset every field (`pinned`, `sourceTag` and `showsDuration` too: set them after them), set them for the
// row, and set `item` to the model passed in.

// A song row (§5.5): title = name ("Loading…" for x, "Unavailable song" for un, both dimmed), sub-line = artists with the E
// badge, ••• when playable. art: ENCellArtNone (playlist), ENCellArtCover (Liked, Popular, search; loads t.image),
// ENCellArtNumber (album: t.trackNumber). playing: [[ENPlayback shared] isPlayingRow:t].
- (void)showTrack:(ENTrack *)t art:(ENCellArt)art playing:(BOOL)playing;
// A playlist row: cover (88 tier), name, pl.subline, chevron.
- (void)showPlaylist:(ENPlaylist *)pl;
// An album row: cover, name, the given sub-line ("1974" on artist pages, "Artist · 1974" in search), chevron.
- (void)showAlbum:(ENAlbumRow *)al subtitle:(NSString *)subtitle;
// An artist row: round image, name, chevron (sub-line "Artist" unless subtitle is given; @"" = no sub-line, the name centred
// in the row, as 3c's search and Library artist rows want).
- (void)showArtist:(ENArtistRow *)ar subtitle:(NSString *)subtitle;
// Anything else (Liked Songs, New Playlist…, Recent Searches, See all songs): a fixed image (nil = no art column).
- (void)showTitle:(NSString *)title subtitle:(NSString *)subtitle image:(UIImage *)image chevron:(BOOL)chevron;
// (A3, C3) An action row ("See all 50 songs", "Load 10 more…"): the title centred in ENTheme actionRowFont and accent (white
// while highlighted; titleColor still overrides), no art, sub-line, ••• or chevron. busy = a centred spinner (the theme's
// spinnerStyle) in place of the text. item = nil; the screen decides whether the row is tappable.
- (void)showAction:(NSString *)title busy:(BOOL)busy;

@end

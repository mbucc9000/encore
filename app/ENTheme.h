#import <UIKit/UIKit.h>

// Colours, fonts and pre-rendered images of the 0.5 look (owner: UI; DESIGN-3 §5.6, PLAN §5, mockup/styles.css "v4"): light,
// gently green lists inside green iOS 6 chrome. Everything a list draws comes from here, so dark mode (Phase 5) is a second
// palette, not a code change. Images are drawn once with CoreGraphics (scale 2) on first use and kept; stretchable ones use
// -resizableImageWithCapInsets:. Main thread (the images are built lazily on first access).
//
// Drop 3a (DESIGN-5 §1.1-1.7, package A1; 0.10.0): ENTheme becomes three immutable palettes (+light, +dark and Up Next's
// always-dark +queue) plus the Appearance setting (Light / Dark / Automatic, dark from 19:00 to 07:00) and the Text size
// setting (Small / Default / Large: the row fonts and the row height). +current is a static pointer swap; a switch posts
// ENThemeDidChangeNotification and every screen re-skins itself in place (§1.2; nothing here touches a view). Chrome (nav bars,
// bar buttons, tab bar, mini player, Jam bar, HUD, sheets, alerts, Now Playing) is identical in every palette: its images are
// cached once in shared statics. Content images (rows, headers, fields, placeholders, silver buttons, grouped tables) are
// built lazily per palette, so switching back is instant; on a memory warning the palette that is neither +current nor
// +queue drops them. Every colour and font a UI file needs is a token here (P2): no ENColor / colorWithRed / fontWithName
// outside ENTheme.m. +start (ENAppDelegate, before any UI) reads both settings, runs +applyChrome (UIAppearance, once) and
// starts the Automatic clock (DidBecomeActive, SignificantTimeChange, one boundary timer; nothing re-skins in the background).
// Existing property names are kept; of their values only navTint (#2c4224), progress (#8fdc5a) and the text-size row fonts
// (titleFont / subFont / numberFont / badgeFont, now 15.5 / 12.5 / 14 / 9 at Default) change, and three images follow the
// mockup: moreGlyphImage (a 31 pt disc + 1 pt drop), glossyButtonImage (the 34 pt kit; Silver is dark in Dark) and
// chevronImage (drawn at .8).
//
// Mockup values (Light): cell gradient #f9fbf7 -> #edf2e9, top line #fff, bottom line #d0dbc8; title #000 Helvetica Neue Bold;
// sub-line #7c7c7c; number #9a9a9a; duration #8a8a8a 13; selected gradient #6fc94f -> #3e9f2a with white title / #e8ffe0
// sub-line; playing title #3fae3a; dimmed (x/un rows) #b9b9b9; section header gradient #7fbf5c -> #579a3a (top #9ad27d, bottom
// #3f7a29) with white 13 bold text; ••• glyph #3a8a28; chevron #7d8a76; E badge #8f8f8f with white 9 bold; footer #8b8b8b 13
// with a white shadow; filter bar #cbd9c1 -> #b0c5a3; tab bar #35502b / #1f3119 | #0f1c0b / #060d04 with a lit selection;
// mini player #3b5a2f -> #25391c -> #162412 (top line #5f8a4b), artist line #b9d2aa. Dark values: DESIGN-5 §1.4.
//
// Dark mode deferred (A6, DESIGN-5 §2.1): 0.10 ships Light only. While
// EN_DARK_MODE is 0, +current is always +light, +appearance is Light, +setAppearance: does nothing, the Automatic clock never
// runs, and a stored encore.appearance is ignored but left in NSUserDefaults (turning the flag on restores it). +dark is
// built but nothing reaches it; Appearance shows only Text size. Up Next's +queue is not dark mode and stays (3b).
//
// Drop 3b (DESIGN-5 §2.2 B1; 0.11.0): the slider kit (C9), the repeat-one badge, the pager dots, the 28 pt gbtn (radius 6, as
// the mockup's .gbtn), the Now Playing chrome tokens (NP's private ENBar / ENThumbImage / ENNowPlaceholder move here), the
// final +queue values (12.5 pt durations, the QUEUE / AUTOPLAY tag colours) and the Explicit Badges setting. Also the tab bar
// fix asked for on 0.10.0 (the highlight was off, blocky, with a solid line at the bottom):
// tabSelectionIndicator is now drawn at the exact frame iOS 6.1 gives it, softly rounded, with no line (see ENTheme.m).
//
// Drop 3c (DESIGN-5 §2.3 C1; 1.0.0; owner C1): the kit the 3c screens build on, additions only (no existing token, image or
// method changes, except artistShade's value: .65 -> .75, the mockup's .ahdr .shade, which nothing drew with before C2):
//   - ENButtonStyleGhost (the artist header's ghost button: black .35 fill, white .7 border, white text; chrome)
//   - +configureButton:style:title:glyph: (C7): one call sets a glossy button up as the mockup's .gbtn (images by height,
//     font, text colours and shadows, glyph, padding), so the track-list and artist headers, Jam and Setup stop copy-pasting
//   - homeBackground (Home's gradient, per palette) for C3
//   - the Setup look (§1.3 "Setup"; chrome): -setupBackgroundImageOfSize:, -setupIconImage:, setupFieldBoxImage,
//     setupFieldSeparatorImage and the setup… colour / font tokens, for C5
// The cover fade-in (C11) is ENFadeIn in ENUtil.h; ENListCell runs it when a cover arrives from disk or the network.
// Dark mode stays off (EN_DARK_MODE 0): the per-palette additions carry their Dark values but only Light is reached.

#define EN_DARK_MODE 0      // 1 = Settings → Appearance → Theme (Light / Dark / Automatic) and the clock; 0 = Light only (0.10)

typedef NS_ENUM(NSInteger, ENAppearance) { ENAppearanceLight = 0, ENAppearanceDark, ENAppearanceAutomatic };
typedef NS_ENUM(NSInteger, ENTextSize) { ENTextSizeSmall = 0, ENTextSizeDefault, ENTextSizeLarge };
// The glossy buttons (C7): Green (chrome, the same in every palette), Silver (per palette) and (3c) Ghost (chrome: a black .35
// fill under a white .7 border, for buttons over a picture, as the mockup's .ahdr .gbtn.silver.ghost)
typedef NS_ENUM(NSInteger, ENButtonStyle) { ENButtonStyleGreen = 0, ENButtonStyleSilver, ENButtonStyleGhost };
typedef NS_ENUM(NSInteger, ENSheetButtonRole) { ENSheetButtonOther = 0, ENSheetButtonCancel, ENSheetButtonDestructive };
typedef NS_ENUM(NSInteger, ENGroupedPosition) { ENGroupedTop = 0, ENGroupedMiddle, ENGroupedBottom, ENGroupedSingle };

extern NSString *const ENThemeDidChangeNotification;   // object = the new +current. Posted when the effective palette flips (a
                                                       // setting, the clock, becoming active), when the text size changes
                                                       // (rows re-lay out) and (3b) when +setShowsExplicitBadges: changes
                                                       // whether song rows draw the E badge (lists redraw)
extern NSString *const ENAppearanceDefaultsKey;        // NSUserDefaults "encore.appearance" = @"light" | @"dark" | @"auto"; default light
extern NSString *const ENTextSizeDefaultsKey;          // NSUserDefaults "encore.textSize" = @"small" | @"default" | @"large"; default "default"
extern NSString *const ENExplicitBadgesDefaultsKey;    // (3b) NSUserDefaults "encore.explicitBadges" = a BOOL; absent = YES
extern NSString *const ENButtonGlyphPlayDisc;          // (3c) +configureButton:…'s glyph name for the `.pi` play disc (playDiscImage)

@interface ENTheme : NSObject

// ---- palettes, setting, clock (DESIGN-5 §1.1)
+ (ENTheme *)current;                         // the active content palette (+light or +dark); a static pointer swap, cheap
                                              // (EN_DARK_MODE 0: always +light)
+ (ENTheme *)light;
+ (ENTheme *)dark;                            // (EN_DARK_MODE 0: built on demand, but nothing in the app asks for it)
+ (ENTheme *)queue;                           // Up Next's list palette: dark in both themes, never switches (3b: the final
                                              // §1.3 "+queue" values; where §1.3 is silent it is the Dark palette)
+ (ENAppearance)appearance;                   // (EN_DARK_MODE 0: always ENAppearanceLight; the stored value is not read)
+ (void)setAppearance:(ENAppearance)a;        // stores, re-evaluates (posts only on a flip), re-arms the clock
                                              // (EN_DARK_MODE 0: a no-op; nothing is stored or posted)
+ (BOOL)isDarkAt:(NSDate *)date;              // the Automatic rule: local time >= 19:00 or < 07:00
+ (void)start;                                // ENAppDelegate, once, before any UI: both settings, +applyChrome, the clock
                                              // (EN_DARK_MODE 0: the text size and +applyChrome only; no clock observers)
+ (void)applyChrome;                          // the UIAppearance chrome (C1), once; the same in every palette
// (1.1, iOS 5) the appearance's per-style bar button images (the Done look) are iOS 6 only: on iOS 5 this puts the images of
// the item's style (Done, or the plain pill) on the item itself; call it after making a Done item and after every style
// change. Does nothing on iOS 6.
+ (void)skinBarItem:(UIBarButtonItem *)item;
// the same with the look given: a system item's style reads Plain (UIKit keeps a system Done's look apart from -style), so
// a UIBarButtonSystemItemDone item passes done:YES
+ (void)skinBarItem:(UIBarButtonItem *)item done:(BOOL)done;
@property (nonatomic, readonly) BOOL isDark;  // +dark and +queue

// ---- text size (A3 "Text size setting"): the row fonts and the row height. Covers keep their box.
+ (ENTextSize)textSize;
+ (void)setTextSize:(ENTextSize)size;         // stores; when it changes, posts ENThemeDidChangeNotification (object +current)
@property (nonatomic, readonly) CGFloat rowHeight;          // a plain list row: 44 / 48 / 54 (Small / Default / Large)
@property (nonatomic, readonly) CGFloat tallRowHeight;      // Search's Top Result row: 60 at every size (54 pt art)
@property (nonatomic, readonly) CGFloat numberColumnWidth;  // an album row's track-number column: 24 / 26 / 28

// ---- explicit badges (3b, B1): whether song rows draw the E badge. ENListCell reads it when it draws (B3); Settings →
// Playback → Explicit Badges switches it (B4).
+ (BOOL)showsExplicitBadges;                  // NSUserDefaults "encore.explicitBadges"; YES when never set
+ (void)setShowsExplicitBadges:(BOOL)shows;   // stores; when it changes, posts ENThemeDidChangeNotification (object +current)

// any Helvetica Neue size (system font fallback): for the few sizes no token names (e.g. a size a later drop retires)
+ (UIFont *)fontOfSize:(CGFloat)pt bold:(BOOL)bold;

// ---- content colours (per palette: Light | Dark; Up Next's +queue in brackets where it differs)
@property (nonatomic, readonly) UIColor *listBackground;      // #edf2e9 | #0f140e [#0b110a]: behind and below the rows
@property (nonatomic, readonly) UIColor *cellTitle;           // #000 | #eef4ea [#f1f1f1]
@property (nonatomic, readonly) UIColor *cellSub;             // #7c7c7c | #8b9885 [#8d8d8d]
@property (nonatomic, readonly) UIColor *cellNumber;          // #9a9a9a | #6b7a64
@property (nonatomic, readonly) UIColor *cellDuration;        // #8a8a8a | #8b9885 [#7d7d7d]
@property (nonatomic, readonly) UIColor *cellDimmed;          // #b9b9b9 | #46523f: Loading… / Unavailable song rows
@property (nonatomic, readonly) UIColor *cellPlaying;         // #3fae3a | #93e063 [#74d150]: the playing row's title and speaker
@property (nonatomic, readonly) UIColor *cellSelectedTitle;   // white (every palette)
@property (nonatomic, readonly) UIColor *cellSelectedTitleShadow;   // black .25 at (0,-1)
@property (nonatomic, readonly) UIColor *cellSelectedSub;     // #e8ffe0
@property (nonatomic, readonly) UIColor *accent;              // #3fae3a | #93e063: green links and "Load 10 more…"
@property (nonatomic, readonly) UIColor *accentStrong;        // #2f9a2b | #93e063
@property (nonatomic, readonly) UIColor *moreGlyph;           // ••• dots: #3a8a28 | #93e063
@property (nonatomic, readonly) UIColor *chevron;             // #7d8a76 (drawn at .8) | #6b7a64
@property (nonatomic, readonly) UIColor *badgeBackground;     // the E badge: #8f8f8f | #5b6a54
@property (nonatomic, readonly) UIColor *badgeText;           // white
@property (nonatomic, readonly) UIColor *headerText;          // section headers: white [#ddd]
@property (nonatomic, readonly) UIColor *headerTextShadow;    // black .35 [black]
@property (nonatomic, readonly) CGSize headerTextShadowOffset;      // (0,1) [(0,-1)]
@property (nonatomic, readonly) UIColor *headerActionHighlighted;   // the header's action button pressed (white .5)
@property (nonatomic, readonly) UIColor *footerText;          // #8b8b8b | #6b7a64
@property (nonatomic, readonly) UIColor *footerTextShadow;    // white | clear (no shadow), at (0,1)
@property (nonatomic, readonly) UIColor *emptyTitle;          // empty state: #666 | #bac8b2
@property (nonatomic, readonly) UIColor *emptyBody;           // #8d8d8d | #7d8a77
@property (nonatomic, readonly) UIColor *emptyTextShadow;     // white | clear, at (0,1)
@property (nonatomic, readonly) UIColor *thumbBorder;         // a cover's 1 pt frame: black .18 | white .08
@property (nonatomic, readonly) UIColor *thumbFill;           // an empty cover box: #ddd | #222a1f
@property (nonatomic, readonly) UIColor *thumbDrop;           // the 1 pt drop line under it: black .12 | clear (none)
@property (nonatomic, readonly) UIColor *heartSaved;          // #3fae3a (every palette)
@property (nonatomic, readonly) UIColor *heartOutline;        // an unsaved heart on content: grey .45 | white .55
@property (nonatomic, readonly) UIColor *pickerRing;          // Saved-in's unticked ring: #a6b09f | #4b5a45
@property (nonatomic, readonly) UIColor *noteStripText;       // Saved-in's strip: #4a6b3a | #9fd47a
@property (nonatomic, readonly) UIColor *fieldText;           // filter / nav search / Jam "Add songs" field: #000 | #eef4ea
@property (nonatomic, readonly) UIColor *fieldPlaceholder;    // #a5a5a5 | #6b7a64
@property (nonatomic, readonly) UIColor *filterButtonTint;    // the Sort control's tintColor: #8fa880 | #3b4937
@property (nonatomic, readonly) UIColor *refreshTint;         // UIRefreshControl tintColor: #4e7843 | #93e063
@property (nonatomic, readonly) UIKeyboardAppearance keyboardAppearance;          // Default | Alert (the dark iOS 6 keyboard)
@property (nonatomic, readonly) UIActivityIndicatorViewStyle spinnerStyle;        // Gray | White (spinners on content)
@property (nonatomic, readonly) UIScrollViewIndicatorStyle indicatorStyle;        // Default | White
// (3b) Up Next's source tags (ENListCell `sourceTag`, drawn like the E badge in sourceTagFont, radius 3; the same in every palette)
@property (nonatomic, readonly) UIColor *sourceTagText;       // #0e0e0e, upper case
@property (nonatomic, readonly) UIColor *sourceTagQueue;      // the QUEUE tag's fill: #74d150
@property (nonatomic, readonly) UIColor *sourceTagAutoplay;   // the AUTOPLAY tag's fill: #6aa8ff

// list header (playlist / album / Liked page)
@property (nonatomic, readonly) UIColor *listHeaderTop;       // #f5f8f2 | #1e2a1a
@property (nonatomic, readonly) UIColor *listHeaderBottom;    // #e0e8da | #131a11
@property (nonatomic, readonly) UIColor *listHeaderBorder;    // its bottom line: #bccbb2 | #080b07
@property (nonatomic, readonly) UIColor *listHeaderTitle;     // #111 | #f1f6ee
@property (nonatomic, readonly) UIColor *listHeaderMeta;      // #8a8a8a | #8b9885
@property (nonatomic, readonly) UIColor *listHeaderDescBackground;  // the description strip: #e9eee5 | #141b12
@property (nonatomic, readonly) UIColor *listHeaderDescBorder;      // #ccd6c4 | #080b07
@property (nonatomic, readonly) UIColor *listHeaderDescText;        // #66705f | #93a08c
@property (nonatomic, readonly) UIColor *coverMat;            // the frame round a header cover / shelf card: white | #2a3426
@property (nonatomic, readonly) UIColor *coverMatShadow;      // header: black .35 | .7, at (0,2)
@property (nonatomic, readonly) CGFloat coverMatShadowBlur;   // 5 | 6
@property (nonatomic, readonly) UIColor *tileMatShadow;       // shelf cards: black .3 | .7, at (0,2)
@property (nonatomic, readonly) CGFloat tileMatShadowBlur;    // 4 | 6
@property (nonatomic, readonly) UIColor *silverText;          // silver button text and glyphs: #333 | #e3ebdf
@property (nonatomic, readonly) UIColor *silverTextShadow;    // white | black
@property (nonatomic, readonly) CGSize silverTextShadowOffset;      // (0,1) | (0,-1)
@property (nonatomic, readonly) UIColor *silverOnText;        // a silver button that is "on": #2f9a2b | #93e063

// Home (shelves) and the profile button
@property (nonatomic, readonly) UIColor *homeTitle;           // greeting and shelf titles: #222 | #eef4ea
@property (nonatomic, readonly) UIColor *homeTitleShadow;     // white | clear, at (0,1)
@property (nonatomic, readonly) UIColor *shelfSub;            // #888 | #7d8a77
@property (nonatomic, readonly) UIColor *tileTitle;           // a shelf card's title: #222 | #e3ebdf
@property (nonatomic, readonly) UIColor *tileSub;             // #8a8a8a | #7d8a77
@property (nonatomic, readonly) UIColor *tileRing;            // a round (artist) card's 2 pt ring: white | #2a3426
@property (nonatomic, readonly) UIColor *homeSeparator;       // 1 pt #d8d8d8 | #080b07 ...
@property (nonatomic, readonly) UIColor *homeSeparatorHighlight;    // ... over 1 pt white | white .04
@property (nonatomic, readonly) UIColor *placeholderTop;      // the cover / artist placeholders: #e3eadf -> | #263022 ->
@property (nonatomic, readonly) UIColor *placeholderBottom;   // #c9d3c2 | #1c2419
@property (nonatomic, readonly) UIColor *placeholderGlyph;    // #a3b19b | #4b5a45
@property (nonatomic, readonly) UIColor *cardPlaceholderFill; // a shelf card without a picture: #c9d8bf | #263022
@property (nonatomic, readonly) UIColor *cardPlaceholderGlyph;      // white .85 | #4b5a45

// grouped tables (Jam, Appearance, Settings, Quality; C8)
@property (nonatomic, readonly) UIColor *groupedBackground;   // the plain colour: #c2cfbb | #111710
@property (nonatomic, readonly) UIColor *groupedPattern;      // the pinstriped one (a 7 x 1 pt pattern colour): use this
@property (nonatomic, readonly) UIColor *groupedCard;         // #fff | #1a2117
@property (nonatomic, readonly) UIColor *groupedBorder;       // #a7a9ac | #2c3728
@property (nonatomic, readonly) UIColor *groupedSeparator;    // #e0e0e0 | #263022
@property (nonatomic, readonly) UIColor *groupedLabel;        // #000 | #eef4ea
@property (nonatomic, readonly) UIColor *groupedSmall;        // #7a7a7a | #86947f
@property (nonatomic, readonly) UIColor *groupedValue;        // values and the check: #3a8a28 | #93e063
@property (nonatomic, readonly) UIColor *groupedHeader;       // section headers: #45593a | #a7c096
@property (nonatomic, readonly) UIColor *groupedHeaderShadow; // white | black
@property (nonatomic, readonly) CGSize groupedHeaderShadowOffset;   // (0,1) | (0,-1)
@property (nonatomic, readonly) UIColor *groupedFooter;       // section footers: #45593a | #7f8c79
@property (nonatomic, readonly) UIColor *groupedFooterShadow; // white | clear, at (0,1)
@property (nonatomic, readonly) UIColor *groupedNote;         // small notes: #66705f | #86947f
@property (nonatomic, readonly) UIColor *jamRed;              // End Jam / Leave Jam / Unpair: #c51a1a | #ff7070
@property (nonatomic, readonly) UIColor *jamPlayingFill;      // the Jam screen's playing row: #e9f5e1 | #21361a
@property (nonatomic, readonly) UIColor *jamMutedTitle;       // its greyed rows: #6b6b6b | #6b7a64
@property (nonatomic, readonly) UIColor *jamMutedSub;         // #a0a0a0 | #46523f
@property (nonatomic, readonly) UIColor *qrBorder;            // the QR card (white in both): grey .82 | #2c3728

// ---- chrome colours (identical in every palette; DESIGN-5 §1.3)
@property (nonatomic, readonly) UIColor *navTint;             // #2c4224: the bar tintColor (status-bar candidate; controls without images)
@property (nonatomic, readonly) UIColor *windowBackground;    // #0d1310: behind everything (flip transitions)
@property (nonatomic, readonly) UIColor *navTitle;            // white
@property (nonatomic, readonly) UIColor *navTitleShadow;      // black .6 at (0,-1)
@property (nonatomic, readonly) UIColor *navTitleSub;         // the two-line title's artists line (Bold 12 over the song): #c9c9c9
@property (nonatomic, readonly) UIColor *barButtonText;       // white
@property (nonatomic, readonly) UIColor *barButtonTextShadow; // black .55 at (0,-1)
@property (nonatomic, readonly) UIColor *tabLabelOff;         // #a8bf9b
@property (nonatomic, readonly) UIColor *tabLabelOn;          // white
@property (nonatomic, readonly) UIColor *bannerBackground;    // (0.5) #f6d35e; the banner itself is bannerImage
@property (nonatomic, readonly) UIColor *bannerText;          // #3a2a00
@property (nonatomic, readonly) UIColor *bannerTextShadow;    // white .5 at (0,1)
@property (nonatomic, readonly) UIColor *miniTitle;           // mini player title (white)
@property (nonatomic, readonly) UIColor *miniTitleShadow;     // black at (0,-1)
@property (nonatomic, readonly) UIColor *miniSub;             // mini player artist line (#b9d2aa)
@property (nonatomic, readonly) UIColor *miniPlayerFill;      // its backgroundColor under the image (#162412)
@property (nonatomic, readonly) UIColor *progress;            // #8fdc5a: the mini player's progress colour (the line is miniProgressImage)
@property (nonatomic, readonly) UIColor *knobGlyph;           // the play / pause glyph on the silver knob: #2f7d1e
@property (nonatomic, readonly) UIColor *jamBarFill;          // the Jam / Connect bar's backgroundColor (#3b9c25)
@property (nonatomic, readonly) UIColor *jamBarText;          // white
@property (nonatomic, readonly) UIColor *jamBarTextShadow;    // black .3 at (0,-1)
@property (nonatomic, readonly) UIColor *hudFill;             // black .78
@property (nonatomic, readonly) UIColor *hudText;             // white
@property (nonatomic, readonly) UIColor *hudTextShadow;       // black at (0,-1)
@property (nonatomic, readonly) UIColor *sheetTitleText;      // an action sheet's title: #d2d2d2 ...
@property (nonatomic, readonly) UIColor *sheetTitleBoldText;  // ... its bold first line: white
@property (nonatomic, readonly) UIColor *sheetTitleShadow;    // black at (0,-1)
@property (nonatomic, readonly) UIColor *sheetButtonText;     // white
@property (nonatomic, readonly) UIColor *sheetButtonTextShadow;     // black .6 at (0,-1)
@property (nonatomic, readonly) UIColor *greenButtonText;     // white, on the green gbtn and the Done bar button
@property (nonatomic, readonly) UIColor *greenButtonTextShadow;     // black .35 at (0,-1)
@property (nonatomic, readonly) UIColor *ghostButtonText;     // (3c) white, on the ghost button ...
@property (nonatomic, readonly) UIColor *ghostButtonTextShadow;     // ... black at (0,-1)
@property (nonatomic, readonly) UIColor *switchOnTint;        // UISwitch onTintColor (#4fae2f; set by +applyChrome)
@property (nonatomic, readonly) UIColor *heartOnChrome;       // an unsaved heart on dark chrome (mini player, Now Playing): grey .80
@property (nonatomic, readonly) UIColor *avatarText;          // initials: white
@property (nonatomic, readonly) UIColor *avatarTextShadow;    // black .25 at (0,-1)
@property (nonatomic, readonly) UIColor *avatarRing;          // white
@property (nonatomic, readonly) UIColor *profileButtonFill;   // Home / Library profile button without a picture: #2c4a22
@property (nonatomic, readonly) UIColor *profileButtonGlyph;  // #c8e6b4
@property (nonatomic, readonly) UIColor *profileButtonRing;   // white .9
// the Jam hero (drawn over jamHeroImageOfSize:)
@property (nonatomic, readonly) UIColor *jamHeroFill;         // the hero view's backgroundColor (#3d9a22)
@property (nonatomic, readonly) UIColor *jamHeroText;         // white
@property (nonatomic, readonly) UIColor *jamHeroSub;          // #eaffdf
@property (nonatomic, readonly) UIColor *jamHeroTextShadow;   // black .3 at (0,-1)
@property (nonatomic, readonly) UIColor *jamHeroAvatarBacking;      // the disc under each avatar (#1f6b1a)
@property (nonatomic, readonly) UIColor *jamHeroAvatarShadow; // black .35, (0,1) blur 2
@property (nonatomic, readonly) UIColor *jamHeroMoreFill;     // the "+N" bubble (black .25)
@property (nonatomic, readonly) UIColor *jamHeroWell;         // the 76 pt well (black .18) ...
@property (nonatomic, readonly) UIColor *jamHeroWellEdge;     // ... its light lower edge (white .3) ...
@property (nonatomic, readonly) UIColor *jamHeroWellShadow;   // ... and inner shadow (black .25, (0,2) blur 4)
// the Artist and Profile headers (images, the same in both themes)
@property (nonatomic, readonly) UIColor *artistHeaderTop;     // the placeholder gradient: #3d6131 ->
@property (nonatomic, readonly) UIColor *artistHeaderBottom;  // #1b3015
@property (nonatomic, readonly) UIColor *artistHeaderGlyph;   // #56804a
@property (nonatomic, readonly) UIColor *artistShade;         // the shade's dark end: black .75 (3c, C1: was .65; the mockup's
                                                              // .ahdr .shade, clear at 35 % -> this at the bottom)
@property (nonatomic, readonly) UIColor *artistNameShadow;    // black .8, (0,1) blur 2
@property (nonatomic, readonly) UIColor *profileHeaderTop;    // #4f8a3a ->
@property (nonatomic, readonly) UIColor *profileHeaderMid;    // #2a4a20 ->
@property (nonatomic, readonly) UIColor *profileHeaderBottom; // #16260f
@property (nonatomic, readonly) UIColor *profileAvatarShadow; // black .45, (0,3) blur 8
@property (nonatomic, readonly) UIColor *profileNameShadow;   // black .4 at (0,-1)
// Now Playing (3b, B1; DESIGN-5 §1.3 "NP chrome"). The two-line title: navTitleSub + npArtistsFont over navTitle + npTitleFont
// with navTitleShadow; white glyphs on the bar use navTitle.
@property (nonatomic, readonly) UIColor *npCountText;         // the strip's first line (count / "Listening on…" / "Playing from…"): #bfe0aa
@property (nonatomic, readonly) UIColor *npTimeText;          // the scrubber's elapsed / remaining times (38 pt wide): #cfcfcf
@property (nonatomic, readonly) UIColor *npToggleOff;         // repeat / shuffle off (22 pt glyphs): #8a8a8a
@property (nonatomic, readonly) UIColor *npToggleOn;          // on, the ⊕ addlistPlus, and Lyrics while open: #6fd14a
@property (nonatomic, readonly) UIColor *npActionGlyph;       // the actions page's 20 pt glyphs: #ddd
@property (nonatomic, readonly) UIColor *npActionText;        // their Bold 10 labels (npActionFont): #cfcfcf
@property (nonatomic, readonly) UIColor *npActionDisabled;    // a disabled action's glyph and label (0.10's value): #5b6a54
@property (nonatomic, readonly) UIColor *npDeviceText;        // the device page's first line (npDeviceFont) and its 20 pt phone glyph: #cfcfcf
@property (nonatomic, readonly) UIColor *npDeviceSub;         // its second line (npDeviceSubFont): #8a8a8a
@property (nonatomic, readonly) UIColor *npVolumeGlyph;       // the volume page's speaker 14 / speakerHi 18: #9a9a9a
@property (nonatomic, readonly) UIColor *npBufferDim;         // the art's buffering veil: black .35
// Setup (3c, C1 for C5; DESIGN-5 §1.3 "Setup", mockup .setup; chrome: the same in every palette). The images are below
// (-setupBackgroundImageOfSize:, -setupIconImage:, setupFieldBoxImage, setupFieldSeparatorImage).
@property (nonatomic, readonly) UIColor *setupTitle;          // "Encore" (setupTitleFont): white ...
@property (nonatomic, readonly) UIColor *setupTitleShadow;    // ... with black at (0,-1)
@property (nonatomic, readonly) UIColor *setupTagline;        // "An unofficial Spotify client for iOS 6" (setupTaglineFont): #9a9a9a
@property (nonatomic, readonly) UIColor *setupLabel;          // a field row's 108 pt label column (setupLabelFont): #ddd
@property (nonatomic, readonly) UIColor *setupInput;          // the typed text (setupInputFont; the code: setupCodeFont): white
@property (nonatomic, readonly) UIColor *setupPlaceholder;    // the fields' placeholders (attributedPlaceholder): #666
@property (nonatomic, readonly) UIColor *setupHint;           // the hint under the box (setupHintFont, line height 1.4): #8a8a8a ...
@property (nonatomic, readonly) UIColor *setupHintBold;       // ... its bold part (setupHintBoldFont, "<home>/admin"): #c8c8c8
@property (nonatomic, readonly) UIColor *setupStatus;         // the status row's text (setupStatusFont) by a white spinner: #cfcfcf
@property (nonatomic, readonly) UIColor *setupDone;           // the status row's done check ("check" glyph): #8fd16a
@property (nonatomic, readonly) UIColor *setupError;          // an error in the status row (today's red, kept): #ff8a80

// ---- fonts (HelveticaNeue / HelveticaNeue-Bold, system fallback; the same in every palette unless noted)
@property (nonatomic, readonly) UIFont *titleFont;            // row title, by text size: Bold 14.5 / 15.5 / 17
@property (nonatomic, readonly) UIFont *subFont;              // row sub-line: 11.5 / 12.5 / 13.5
@property (nonatomic, readonly) UIFont *numberFont;           // track numbers: Bold 13 / 14 / 15
@property (nonatomic, readonly) UIFont *badgeFont;            // the E badge: Bold 8.5 / 9 / 10
@property (nonatomic, readonly) UIFont *durationFont;         // 13 [12.5]
@property (nonatomic, readonly) UIFont *headerFont;           // Bold 13 [12]: section headers
@property (nonatomic, readonly) UIFont *footerFont;           // 13
@property (nonatomic, readonly) UIFont *bigTitleFont;         // Bold 19 (list header title, up to 2 lines)
// chrome
@property (nonatomic, readonly) UIFont *navTitleFont;         // Bold 20
@property (nonatomic, readonly) UIFont *navTitleSmallFont;    // Bold 17 (long titles, "small title" screens)
@property (nonatomic, readonly) UIFont *barButtonFont;        // Bold 12
@property (nonatomic, readonly) UIFont *tabLabelFont;         // Bold 10
@property (nonatomic, readonly) UIFont *bannerFont;           // Bold 12.5
@property (nonatomic, readonly) UIFont *hudFont;              // Bold 15.5
@property (nonatomic, readonly) UIFont *jamBarFont;           // Bold 11
@property (nonatomic, readonly) UIFont *miniTitleFont;        // Bold 15.5
@property (nonatomic, readonly) UIFont *miniSubFont;          // Bold 12
// empty state, track-list header, buttons
@property (nonatomic, readonly) UIFont *emptyTitleFont;       // Bold 17
@property (nonatomic, readonly) UIFont *emptyBodyFont;        // 14.5 (line height 1.4)
@property (nonatomic, readonly) UIFont *linkFont;             // Bold 15
@property (nonatomic, readonly) UIFont *metaFont;             // 13
@property (nonatomic, readonly) UIFont *descriptionFont;      // 13
@property (nonatomic, readonly) UIFont *buttonFont;           // Bold 14.5 (34 pt gbtn)
@property (nonatomic, readonly) UIFont *wideButtonFont;       // Bold 18 (44 pt gbtn)
@property (nonatomic, readonly) UIFont *smallButtonFont;      // Bold 12.5 (28 pt gbtn: NP's "Start a Jam", 10 pt side padding)
// Home, Artist
@property (nonatomic, readonly) UIFont *greetingFont;         // Bold 21
@property (nonatomic, readonly) UIFont *shelfTitleFont;       // Bold 17
@property (nonatomic, readonly) UIFont *shelfSubFont;         // 13
@property (nonatomic, readonly) UIFont *tileTitleFont;        // Bold 13
@property (nonatomic, readonly) UIFont *tileSubFont;          // 11.5
@property (nonatomic, readonly) UIFont *artistNameFont;       // Bold 27 (C2's header)
// grouped
@property (nonatomic, readonly) UIFont *groupedLabelFont;     // Bold 16.5
@property (nonatomic, readonly) UIFont *groupedSmallFont;     // 12.5
@property (nonatomic, readonly) UIFont *groupedValueFont;     // 16
@property (nonatomic, readonly) UIFont *groupedHeaderFont;    // Bold 17
@property (nonatomic, readonly) UIFont *groupedFooterFont;    // 14
// lists, sheets
@property (nonatomic, readonly) UIFont *actionRowFont;        // Bold 15 ("See all…", "Load 10 more…")
@property (nonatomic, readonly) UIFont *swipeStripFont;       // Bold 14 (the swipe-to-queue strip)
@property (nonatomic, readonly) UIFont *sourceTagFont;        // Bold 9.5 (Up Next's QUEUE / AUTOPLAY)
@property (nonatomic, readonly) UIFont *noteStripFont;        // Bold 12 (Saved-in's strip)
@property (nonatomic, readonly) UIFont *sheetButtonFont;      // Bold 18.5
@property (nonatomic, readonly) UIFont *sheetTitleFont;       // 13.5 ...
@property (nonatomic, readonly) UIFont *sheetTitleBoldFont;   // ... Bold 13.5 (the first line)
// Now Playing, Setup (B2 / C5)
@property (nonatomic, readonly) UIFont *npTitleFont;          // Bold 17
@property (nonatomic, readonly) UIFont *npArtistsFont;        // Bold 12
@property (nonatomic, readonly) UIFont *npCountFont;          // Bold 13
@property (nonatomic, readonly) UIFont *npTimeFont;           // Bold 12.5
@property (nonatomic, readonly) UIFont *npActionFont;         // Bold 10
@property (nonatomic, readonly) UIFont *npDeviceFont;         // Bold 12.5 (3b: the device page, "Playing on This iPhone")
@property (nonatomic, readonly) UIFont *npDeviceSubFont;      // 11.5 ("Encore · … · AAC 320 kbps")
@property (nonatomic, readonly) UIFont *jamPillFont;          // Bold 12 (Now Playing's Jam pill; jamBarText / jamBarTextShadow)
@property (nonatomic, readonly) UIFont *setupTitleFont;       // Bold 27
@property (nonatomic, readonly) UIFont *setupTaglineFont;     // 14
@property (nonatomic, readonly) UIFont *setupLabelFont;       // (3c) Bold 15: a field row's label (Home, Away, Code)
@property (nonatomic, readonly) UIFont *setupInputFont;       // (3c) 16: the Home and Away fields
@property (nonatomic, readonly) UIFont *setupCodeFont;        // (3c) Bold 22: the Code field (SETUP1)
@property (nonatomic, readonly) UIFont *setupHintFont;        // (3c) 12.5: the hint ...
@property (nonatomic, readonly) UIFont *setupHintBoldFont;    // (3c) ... Bold 12.5: its bold part
@property (nonatomic, readonly) UIFont *setupStatusFont;      // (3c) Bold 14: the status row

// ---- content images (per palette, built on first use)
@property (nonatomic, readonly) UIImage *cellBackground;            // gradient + both separator lines (the cell's backgroundView)
@property (nonatomic, readonly) UIImage *cellSelectedBackground;    // green selection gradient (selectedBackgroundView, swipe strip)
@property (nonatomic, readonly) UIImage *cellPlayingBackground;     // the playing-row gradient
// (1.1) the same three for a row `h` tall: on iOS 6 the images above (they stretch to any height); iOS 5 tiles a resizable
// centre, so there each is made at that height (a row taller than the Text size's: Search's 60 pt Top Result)
- (UIImage *)cellBackgroundOfHeight:(CGFloat)h;
- (UIImage *)cellSelectedBackgroundOfHeight:(CGFloat)h;
- (UIImage *)cellPlayingBackgroundOfHeight:(CGFloat)h;
@property (nonatomic, readonly) UIImage *sectionHeaderBackground;   // 22 pt green gradient for UITableViewHeaderFooterView
@property (nonatomic, readonly) UIImage *sectionHeaderStrongBackground;   // 22 pt, brighter (Search's Top Result)
@property (nonatomic, readonly) UIImage *filterBarBackground;       // the 44 pt filter UISearchBar's backgroundImage
@property (nonatomic, readonly) UIImage *noteStripImage;            // Saved-in's 36 pt strip (stretchable)
@property (nonatomic, readonly) UIImage *placeholderCover;          // 42 pt square tile for a playlist/album without a cover
@property (nonatomic, readonly) UIImage *placeholderArtist;         // 42 pt round tile
@property (nonatomic, readonly) UIImage *placeholderLarge;          // 108 pt tile (list headers without a cover)
@property (nonatomic, readonly) UIImage *moreGlyphImage;            // ••• 31 pt disc (+1 pt drop: 31 x 32); the cell draws it
@property (nonatomic, readonly) UIImage *moreGlyphPressedImage;     // the same, pressed
@property (nonatomic, readonly) UIImage *speakerGlyph;              // (0.5) a 16 pt speakerHi in cellPlaying
@property (nonatomic, readonly) UIImage *playingGlyph;              // the inline speakerHi before a playing title: 13 / 14 / 15.5 pt
                                                                    // (text size), in cellPlaying
@property (nonatomic, readonly) UIImage *chevronImage;
@property (nonatomic, readonly) UIImage *closeGlyphImage;           // Search's recent rows' × (moreGlyphOverride): 22 pt "close" in
                                                                    // chevron; set it again in -themeDidChange
// (3c, C1 for C3) Home's background (§1.4 homeBackground, mockup .home-bg): #f3f8ef -> #e4eedd over the top 300 pt, then
// -> #edf3e9 | #18221a -> #10160f, then -> #0f140e. Opaque, 1 x 568 pt, resizable: the top 300 pt are a cap (they never
// stretch), the rest stretches to fit and it stretches sideways. Use it at any height from 300 pt, e.g. as the table's
// backgroundView (a UIImageView); rows over it that should show it are non-opaque (only the top ~4 blend).
@property (nonatomic, readonly) UIImage *homeBackground;
@property (nonatomic, readonly) UIImage *groupedChevronImage;       // chevRight 13 pt: #8b8b8b | #6b7a64
@property (nonatomic, readonly) UIImage *groupedCheckImage;         // the chosen row's check, 16 pt in groupedValue
- (UIImage *)groupedSelectionImage:(ENGroupedPosition)position;     // the green selection with this position's corners (radius 10)
- (UIImage *)searchFieldImage:(BOOL)inNavBar;      // 30 pt field (radius 15) for setSearchFieldBackgroundImage:forState:
- (UIImage *)pickerCheckImage:(BOOL)on;            // Saved-in's 22 pt mark: the ring, or the green disc with a white tick
- (UIImage *)heartImage:(BOOL)saved size:(CGFloat)side;   // filled heartSaved, or the heartO outline in heartOutline
// a cover's frame (side x side+1 when there is a drop line): the thumbBorder ring over thumbFill, then thumbDrop under it.
// Draw it at the box origin and the picture inset 1 pt.
- (UIImage *)thumbFrameImageOfSide:(CGFloat)side round:(BOOL)round;
// The glossy buttons (C7): Green (chrome) or Silver (per palette); 28 (radius 6; 3b, was 5: the mockup's .gbtn radius), 34 (6)
// or 44 (9) pt tall, resizable both ways (the last 1 pt is the drop). (3c) Ghost (chrome): the silver shape (1 pt border,
// radius by height) filled black .35 (pressed: black .55, an addition: the mockup has no pressed ghost) under a white .7
// border; no gloss, no drop shadow (its last 1 pt is clear): translucent, for buttons over a picture (the artist header).
- (UIImage *)buttonImage:(ENButtonStyle)style height:(CGFloat)h pressed:(BOOL)pressed;
// (UI implementation addition, kept) the header buttons: a 34 pt wrapper of -buttonImage:height:pressed: (Green / Silver).
- (UIImage *)glossyButtonImage:(BOOL)green pressed:(BOOL)pressed;
// C7 (3c): sets a UIButtonTypeCustom button up as the mockup's .gbtn, in +current. Set its frame (the height) first; a height
// under 20 pt counts as 34. Call it again to change the style, title or glyph, or after ENThemeDidChangeNotification (Silver
// is per palette). It sets, replacing whatever was there:
//   - backgrounds: -buttonImage:style:height:pressed: at the button's height; Normal = not pressed, Highlighted and
//     Selected|Highlighted = pressed (Selected alone looks Normal)
//   - title: `title` for Normal (nil = icon only), titleLabel.font by height (44+: wideButtonFont 18; 30 and under:
//     smallButtonFont 12.5; else buttonFont 14.5), tail truncation, the colour (Green: greenButtonText; Silver: silverText;
//     Ghost: ghostButtonText) and its shadow (greenButtonTextShadow / silverTextShadow at silverTextShadowOffset /
//     ghostButtonTextShadow; Green and Ghost at (0,-1)); Disabled = the colour at .5; Selected (and Selected|Highlighted) =
//     silverOnText on Silver (the mockup's .gbtn.silver.on), the same colour otherwise
//   - glyph (a -glyphNamed: name; nil = none): drawn in the title colour (Selected: silverOnText on Silver), 16 pt beside a
//     title (14 at 28-30 pt, 20 at 44 pt), 19 pt alone (16 / 22); ENButtonGlyphPlayDisc = the 26 pt playDiscImage, as is
//   - adjustsImageWhenHighlighted NO (the pressed background is the feedback), adjustsImageWhenDisabled YES
//   - padding (contentEdgeInsets, with the gap made by titleEdgeInsets): 10 pt each side (Silver, Ghost, 28-30 pt), 11 (Green); the
//     Play disc 3.5 pt from the left edge (its 23 pt disc at the mockup's 5) with 11 on the right; 6 pt between a glyph and
//     the title (4.5 after the disc); 1 pt off the bottom (the drop row), so the content centres on the pill. Icon only: no
//     side padding. The content stays centred in the frame; `[button sizeThatFits:CGSizeZero].width` is the mockup's natural
//     width (padding included: size the button to it and the content sits where the mockup puts it).
// Callers add their own target, frame and any state-specific images after it (e.g. the album Save pill's hearts).
+ (void)configureButton:(UIButton *)button style:(ENButtonStyle)style title:(NSString *)title glyph:(NSString *)glyph;

// ---- chrome images (shared, built once)
@property (nonatomic, readonly) UIImage *navBarBackground;          // 1 x 44 (every UINavigationBar, and Now Playing's bar)
@property (nonatomic, readonly) UIImage *tabBarBackground;          // UITabBar.backgroundImage (49 pt)
@property (nonatomic, readonly) UIImage *tabSelectionIndicator;     // UITabBar.selectionIndicatorImage (3b: 60 x 48, the exact frame
                                                                    // iOS 6.1 gives it; a soft rounded box, no bottom line)
@property (nonatomic, readonly) UIImage *miniPlayerBackground;      // 46 pt
@property (nonatomic, readonly) UIImage *miniProgressImage;         // 2 pt line + 5 pt glow below (7 pt tall): stretch it sideways
@property (nonatomic, readonly) UIImage *miniArtFrame;              // 40 x 40: a white .12 outer ring and a 1 pt #000 border round
                                                                    // 36 pt art (clear inside: the art goes at inset 2, either side of it)
@property (nonatomic, readonly) UIImage *bannerImage;               // 30 pt, opaque, stretchable sideways
@property (nonatomic, readonly) UIImage *playDiscImage;             // the green Play button's 23 pt disc with its triangle (26 x 26)
@property (nonatomic, readonly) UIImage *sheetBackgroundImage;      // an action sheet's panel (translucent, top line; stretchable)
@property (nonatomic, readonly) UIImage *likedTile;                 // the Liked Songs tile, 42 pt (Playlists / Library rows)
@property (nonatomic, readonly) UIImage *likedTileLarge;            // 108 pt (the Liked header)
@property (nonatomic, readonly) UIImage *newPlaylistTile;           // 42 pt green "+" tile (Add-to picker's "New Playlist…")
- (UIImage *)barButtonImageDone:(BOOL)done pressed:(BOOL)pressed;  // 30 pt bar button backgrounds (resizable sideways)
- (UIImage *)backButtonImagePressed:(BOOL)pressed;                 // 30 pt arrow-shaped back button (caps L14 / R6)
// The silver knob (34 pt, 38 x 38 with its shadow) with a play / pause glyph in knobGlyph; nil glyph = the empty knob.
- (UIImage *)knobImageWithGlyph:(NSString *)glyph pressed:(BOOL)pressed;
- (UIImage *)sheetButtonImage:(ENSheetButtonRole)role pressed:(BOOL)pressed;   // 44 pt, radius 7 (+1 pt highlight), resizable
- (UIImage *)alertBackgroundImageOfSize:(CGSize)size;              // the green alert panel at this size (cached per size)
- (UIImage *)statusDotImage:(BOOL)ok;                              // 9 pt green / red dot
// Icon tiles (Settings 29 pt: radius 6, an inset black .15 ring, an 18 pt white glyph; Library 42 pt: square, 24 pt glyph).
- (UIImage *)iconTileWithGlyph:(NSString *)glyph top:(UIColor *)top bottom:(UIColor *)bottom size:(CGFloat)side radius:(CGFloat)radius;
// The named tiles with their gradients (§1.3): @"album", @"artist", @"recent" (Library), @"computer", @"wifi", @"statusOK",
// @"statusBad", @"engine", @"jam", @"theme", @"folder", @"newPlaylist". Radius 6 under 40 pt, square from 40 pt.
- (UIImage *)iconTileNamed:(NSString *)name size:(CGFloat)side;

// 30 x 30 pt alpha-mask tab icon for ENTab index i (0.7: Home, Search, Playlists, Library, Settings), drawn once at scale 2 and
// cached as a PNG under ENCacheDir(@"ui").
- (UIImage *)tabIconAtIndex:(NSUInteger)i;
// (3a) the finished tab icons for setFinishedSelectedImage:withFinishedUnselectedImage: (30 x 30 pt; on: the lime gloss,
// off: grey-green, both with a 1 pt black .9 shadow above), cached as tab%lu_on_v3 / tab%lu_off_v3 PNGs.
- (UIImage *)finishedTabIconAtIndex:(NSUInteger)i selected:(BOOL)selected;

// (UI implementation addition) the mockup's 24-box glyphs drawn at `pt` x `pt` in one colour, cached per name/size/colour:
// play, pause, next, prev, shuffle, repeat, repeatOne, plus (circled), dots, album, artist, chevDown, note; 0.6: people,
// message, link, queue (mockup/art.js); 0.7: clock; 0.8: mic (Now Playing's Lyrics button); 0.9: pin (a push pin leaning
// right: the Playlists tab's pinned rows, ENListCell `pinned`); 0.9.5: close (a thin ×, stroked: the × of Search's recent
// rows, ENListCell `moreGlyphOverride`); 0.10 (art.js): x, check, speaker, speakerHi, list, chevRight, heartO, computer,
// wifi, moon, folder, addlistPlus, phone.
- (UIImage *)glyphNamed:(NSString *)name size:(CGFloat)pt color:(UIColor *)color;

// helper: an image of `size` points at the screen scale, drawn by the block (UIGraphicsBeginImageContextWithOptions)
+ (UIImage *)imageOfSize:(CGSize)size opaque:(BOOL)opaque drawing:(void (^)(CGContextRef c, CGSize size))draw;

// ---- instance helpers (C1)
// The search / filter field in this palette: the field image, text colour, attributed placeholder and keyboardAppearance on
// the bar and its 6.1 text field (found with a class check; without one the field stays stock). A bar outside a nav bar
// also gets filterBarBackground as its backgroundImage. Call at creation and again in -themeDidChange.
- (void)styleSearchBar:(UISearchBar *)bar nav:(BOOL)inNavBar;
// Sets item.title; a title wider than 172 pt at Bold 20, or `small`, shows as a Bold 17 titleView (truncated past 196 pt);
// a title over 13 characters makes the next screen's back button say "Back". Never touches a tab item's title.
- (void)applyTitle:(NSString *)title toItem:(UINavigationItem *)item small:(BOOL)small;
// an icon bar button on the green skin (a white 20 pt glyph)
+ (UIBarButtonItem *)barButtonWithGlyph:(NSString *)glyph target:(id)target action:(SEL)action;

// ---- 0.6 Jam (DESIGN-4b §6.4, §6.5, §6.7, §6.10, §6.11; mockup styles.css "v3: Jam"), chrome
@property (nonatomic, readonly) UIImage *jamBarImage;           // 18 pt bar: #6fcb4d -> #3b9c25, 1 pt #8fdc72 top line (stretchable)
@property (nonatomic, readonly) UIImage *jamPillImage;          // Now Playing's pill: 19 pt (#7fd35a -> #3d9a22, inset highlight)
                                                                // + 2 pt of baked shadow = 21 pt tall, stretchable sideways
@property (nonatomic, readonly) UIImage *jamQueueHeaderImage;   // Up Next's 22 pt "Jam queue" header (#5fae3e -> #3d8a24, top #7fc95c)
// The Jam screen's hero (not cached: it is rebuilt when the Jam changes): gradient 135° #7bd34f -> #3d9a22 (55 %) -> #1f6e2a,
// a white .28 radial glow at 25 % / 15 %, a 1 pt #1d5a14 bottom border under a white .2 line; then `draw` adds the text and
// the avatars' baked shadows. Opaque.
- (UIImage *)jamHeroImageOfSize:(CGSize)size drawing:(void (^)(CGContextRef c, CGSize size))draw;
// The avatar palette (#3fae3a #e2557c #6aa8ff #f0a35a), picked by a stable hash of key (a member id; never logged), and its
// 62 % shade (the initials' radial gradient runs colour -> shade).
- (UIColor *)avatarColorForKey:(NSString *)key;
- (UIColor *)avatarShadeForKey:(NSString *)key;

// ---- 3b (B1): Now Playing chrome, the slider kit (C9), pager dots, repeat-one (DESIGN-5 §1.3; shared, built once)
@property (nonatomic, readonly) UIImage *npStripBackground;       // 82 pt: #16250f -> #060b05, a #1d3016 bottom line (stretch sideways)
@property (nonatomic, readonly) UIImage *npTransportBackground;   // 58 pt: #304a26 / #1c2e16 50 % / #0b1508 51 % / #030703 and a
                                                                  // rgba(160,240,110,.25) top line
@property (nonatomic, readonly) UIImage *npTransportSeparator;    // show it 2 pt wide and full height: 1 pt #000 then 1 pt white .07
                                                                  // (the black column on the boundary between two buttons)
@property (nonatomic, readonly) UIImage *npTransportPressed;      // white .08, any size: a transport button's Highlighted background
@property (nonatomic, readonly) UIImage *npBottomBackground;      // 44 pt: #0b1309 -> #020402 (the pager row)
// The cover stand-in until the art arrives (was NP's ENNowPlaceholder): an opaque #22361b -> #0b130a diagonal with a note glyph
// 40 % of the side in #3d5a33. NOT cached (1.6 MB at 320 pt): keep it while the screen is up.
- (UIImage *)nowPlayingPlaceholderOfSide:(CGFloat)side;
// The slider kit (C9), for the scrubber's UISlider (-styleSlider:) and MPVolumeView (iOS 6: setMinimumVolumeSliderImage: /
// setMaximumVolumeSliderImage: / setVolumeThumbImage: forState:UIControlStateNormal with these three; the route button stays
// stock). The tracks are 11 x 11 pt: a 9 pt pill (radius 4.5) at y 1 with its white .12 lower edge under it, so a slider that
// centres its images centres the pill; caps 5 on every side. The thumb (29 x 31) has its 23 pt disc centred and the shadow
// baked in, so it travels 3 pt short of the track's ends.
@property (nonatomic, readonly) UIImage *sliderMinimumTrackImage; // the fill: #a6ec74 -> #4fae2f, an inner bottom shadow black .25
@property (nonatomic, readonly) UIImage *sliderMaximumTrackImage; // the track: #0f0f0f -> #3a3a3a, an inset shadow black .9
@property (nonatomic, readonly) UIImage *sliderThumbImage;        // radial #fff / #ececec 40 % / #b4b4b4 80 % / #9a9a9a from 50 % / 25 %,
                                                                  // shadow black .8 (0,1) blur 3, an inner bottom shadow black .2
- (void)styleSlider:(UISlider *)slider;   // the three images (the thumb for Normal and Highlighted); set no track tint colours on it
// C10's dots (ENPagerView): a black .8 pill 12 pt tall (radius 6, 6 pt padding) with `count` 6 pt dots 6 pt apart, the current
// one white, the others #6b6b6b; 6 + 12 x count pt wide. Cached per (count, current); nil for count 0 or over 9.
- (UIImage *)pagerDotsImageWithCount:(NSUInteger)count current:(NSUInteger)index;
// Repeat-one: the 22 pt repeat glyph in npToggleOn with the "1" badge (Bold 9 black on a 12 pt #6fd14a disc) over its top-right
// corner, as the mockup's .np-toggles .one. 34 x 30 pt with the glyph centred (at 6, 4), so a UIButton that centres its image
// keeps the glyph exactly where the 22 pt repeat glyph of the other two states sits.
@property (nonatomic, readonly) UIImage *repeatOneImage;
@property (nonatomic, readonly) UIImage *repeatOneBadge;          // just the 12 pt badge

// ---- 3c (C1 for C5): the Setup screen (DESIGN-5 §1.3 "Setup", mockup .setup; chrome, the same in every palette)
// The full-screen background (the view's size, e.g. 320 x 548 under the status bar, 320 x 460 on 3.5-inch): opaque, a
// radial gradient from 50 % / 22 % (#35502b -> #0d150a at 72 % of the way to the farthest corner, then #0d150a) under 45°
// stripes (white .018, 2 pt of every 5 pt). NOT cached (~2.8 MB at 320 x 548): keep it while the screen is up.
- (UIImage *)setupBackgroundImageOfSize:(CGSize)size;
// The app icon (76 pt, radius 16) with its shadow baked in (black .7, (0,3), blur 8): 96 x 96 pt with the icon at (10, 7),
// i.e. the icon's centre is the image's (48, 45). `icon` is the 152 px icon resource (any size: drawn into 76 pt); nil = a
// stand-in (the green Jam-tile gradient with a white note). NOT cached: keep it while the screen is up.
- (UIImage *)setupIconImage:(UIImage *)icon;
// The one grouped field box (mockup .dfields): radius 9, a 1 pt #000 border, #2c2c2c -> #232323 inside, an inner top line
// white .06 and an outer bottom line white .1 under it. Resizable both ways (caps 10, 10 at the bottom + the 1 pt line);
// drawn at 135 pt = three 44 pt rows + the two 1 pt borders + the line, so a three-row box shows it unstretched: make the
// box view 3 x 44 + 3 pt tall and put the rows at y 1, 45, 89 (inset 1 pt from the sides).
@property (nonatomic, readonly) UIImage *setupFieldBoxImage;
// The line between two rows (mockup .df border-top + its inset highlight): 2 pt tall, 1 pt #111 over 1 pt white .05;
// stretches sideways. Show it at the top of each row but the first.
@property (nonatomic, readonly) UIImage *setupFieldSeparatorImage;

@end

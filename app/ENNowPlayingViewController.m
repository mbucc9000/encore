#import "ENNowPlayingViewController.h"
#import "ENCompat.h"
#import <MediaPlayer/MediaPlayer.h>
#import <QuartzCore/QuartzCore.h>
#import "ENTheme.h"
#import "ENModel.h"
#import "ENPlayback.h"
#import "ENCatalog.h"
#import "ENTabBarController.h"
#import "ENMiniPlayer.h"
#import "ENTrackActions.h"
#import "ENHeartButton.h"
#import "ENTrackListViewController.h"
#import "ENArtistViewController.h"
#import "ENUtil.h"
#import "ENAppDelegate.h"
#import "ENJam.h"
#import "ENQueueViewController.h"
#import "ENLyricsView.h"
#import "ENAnon.h"

static NSString *const ENLyricsOpenKey = @"encore.lyricsOpen";     // 0.8: Now Playing opens with lyrics when left open
static const NSInteger ENActionLabelTag = 7;                        // the title label of a bottom-bar button
static const CGFloat ENArtSkipAt = 70;                              // 3b: the art drag (pt) that skips on release

// 0.11.1: the 0.10 bottom bar is back exactly as it was (feedback on 0.11.0: all on one bar), so its own
// 0.10 ink and font: no ENTheme token has them (npActionGlyph / npActionText / npActionFont / npToggleOn are 3b's pager
// values). Its disabled glyphs (npActionDisabled, #5b6a54) and its bar image (npBottomBackground) are tokens that match.
static UIColor *ENNowBarInk(void) { return ENColor(0xcfdcc6); }    // the glyphs and labels
static UIColor *ENNowBarLit(void) { return ENColor(0x7fe056); }    // Lyrics while open: its mic and its label
static UIFont *ENNowBarFont(void) { return [UIFont boldSystemFontOfSize:10]; }

// 0.6: a Jam guest without playback control can't skip, seek, shuffle or repeat from here (§6.7)
static BOOL ENNowControl(void) {
	ENJam *jam = [ENJam shared];
	return !(jam.active && jam.guest && !jam.canControl);
}

// the scrubber's rule; 0.8: also the lyrics' tap-a-line seek (DESIGN-LYRICS §3)
static BOOL ENNowCanSeek(void) {
	return [ENPlayback shared].durationMs > 0 && ENNowControl();
}

// 0.11.2: what a "Playing from" line opens (-tapPlayingFrom); ENNowFromNone = not tappable
typedef enum { ENNowFromNone = 0, ENNowFromPlaylist, ENNowFromAlbum, ENNowFromArtist, ENNowFromLiked } ENNowFrom;

static const CGFloat ENFromChevSide = 12;   // 0.11.2: the chevRight glyph's box (its ink: x 3.9 … 8.4, 7.8 pt tall, centred at y 6)
static const CGFloat ENFromChevRoom = 9;    // what the chevron adds after the name: about 4 pt of gap, then its ink
static const CGFloat ENFromPad = 8;         // the pressed overlay's margin left and right of name + chevron

// a 22-character base62 Spotify id: what the gateway's playlist / album / artist routes accept (ENCatalog's rule)
static BOOL ENNowValidID(NSString *s) {
	if (s.length != 22) return NO;
	for (NSUInteger i = 0; i < 22; i++) {
		unichar c = [s characterAtIndex:i];
		if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return NO;
	}
	return YES;
}

// Liked Songs as a context: the catalog's key, any spotify:user:<u>:collection (the catalog's Liked route takes them all),
// spotify:collection:tracks (the engine's other Liked context, liked.go; another client's Liked play can arrive as it) or
// the library's liked.ctx (3b's rule, unchanged)
static BOOL ENNowIsLiked(NSString *ctx) {
	if ([ctx isEqualToString:ENLikedListURI] || [ctx isEqualToString:@"spotify:collection:tracks"]
		|| ([ctx hasPrefix:@"spotify:user:"] && [ctx hasSuffix:@":collection"])) return YES;
	NSString *liked = [ENCatalog shared].library.likedCtx;
	return liked && [ctx isEqualToString:liked];
}

// 0.11.2: a playlist context as the app's playlist uri: spotify:playlist:<id> as it is, the legacy spotify:user:<u>:playlist:<id>
// as spotify:playlist:<id> (the same playlist); nil for anything else or an id the routes would refuse
static NSString *ENNowPlaylistURI(NSString *ctx) {
	NSArray *p = [ctx componentsSeparatedByString:@":"];
	if (p.count == 3 && [ctx hasPrefix:@"spotify:playlist:"] && ENNowValidID(p[2])) return ctx;
	if (p.count == 5 && [ctx hasPrefix:@"spotify:user:"] && [p[3] isEqualToString:@"playlist"] && ENNowValidID(p[4]))
		return [@"spotify:playlist:" stringByAppendingString:p[4]];
	return nil;
}

// 0.11.2 (a tap on "Playing from" opens where the song is being played from): the page a context
// opens, and that page's uri (*kind says which page). Liked Songs (ENNowIsLiked) -> ENLikedListURI; a playlist (either form,
// ENNowPlaylistURI) -> spotify:playlist:<id>; spotify:album:<id> / spotify:artist:<id> -> themselves. Anything else (a search,
// a station / radio, a single song, a show, a malformed id, no context) -> nil and ENNowFromNone.
static NSString *ENNowFromPage(NSString *ctx, ENNowFrom *kind) {
	*kind = ENNowFromNone;
	if (!ctx.length) return nil;
	if (ENNowIsLiked(ctx)) {
		*kind = ENNowFromLiked;
		return ENLikedListURI;
	}
	NSString *pl = ENNowPlaylistURI(ctx);
	if (pl) {
		*kind = ENNowFromPlaylist;
		return pl;
	}
	NSArray *p = [ctx componentsSeparatedByString:@":"];
	if (p.count != 3 || ![p[0] isEqualToString:@"spotify"] || !ENNowValidID(p[2])) return nil;
	if ([p[1] isEqualToString:@"album"]) *kind = ENNowFromAlbum;
	else if ([p[1] isEqualToString:@"artist"]) *kind = ENNowFromArtist;
	return *kind ? ctx : nil;
}

// the button's accessibility label: "Open " + this (never the name)
static NSString *ENNowFromWord(ENNowFrom kind) {
	switch (kind) {
		case ENNowFromPlaylist: return @"playlist";
		case ENNowFromAlbum: return @"album";
		case ENNowFromArtist: return @"artist";
		case ENNowFromLiked: return @"Liked Songs";
		default: return @"";
	}
}

// 3b "Playing from": the context's name from what the app already has, with no request: Liked Songs, a library playlist, the
// playing song's album, or one of its artists (an artist page's Play). nil when it doesn't know.
static NSString *ENNowCatalogName(NSString *ctx, NSDictionary *t) {
	if (ENNowIsLiked(ctx)) return @"Liked Songs";
	ENLibrary *lib = [ENCatalog shared].library;
	NSString *pl = ENNowPlaylistURI(ctx);            // (0.11.2: a legacy spotify:user:<u>:playlist:<id> finds its library row too)
	if (pl) return [lib playlistForURI:pl].name;
	if ([ctx hasPrefix:@"spotify:album:"]) return [ctx isEqualToString:ENJStr(t[@"album_uri"])] ? ENJStr(t[@"album"]) : nil;
	if ([ctx hasPrefix:@"spotify:artist:"]) {
		NSArray *uris = ENJArr(t[@"artist_uris"]), *names = ENJArr(t[@"artists"]);
		NSUInteger i = [uris indexOfObject:ctx];
		return i != NSNotFound && i < names.count ? ENJStr(names[i]) : nil;
	}
	return nil;
}

// the last context Up Next's ctx.n was asked for (by any Now Playing) and its answer, so reopening doesn't ask again;
// (R2a) only under the same +[ENAnon generation] (the name is masked as the mode was when it was asked)
static NSString *sQueueCtxURI, *sQueueCtxName;
static NSUInteger sQueueCtxGen;

#pragma mark -

// 0.8.2: a downward drag puts Now Playing away (Spotify / Apple Music style). iOS 6 takes the presenting tab controller's
// view out of the window while a full-screen modal is up, so the drag shows a snapshot of it (rendered when the drag
// starts) fixed behind this view; on release past a quarter of the height (or a quick flick) the view slides down and the
// modal is dismissed without animation, which swaps the real tab controller in under the identical snapshot.
@interface ENNowPlayingViewController () <UIGestureRecognizerDelegate>
@end

@implementation ENNowPlayingViewController {
	UIPanGestureRecognizer *_dismissPan;
	UIImageView *_under;                 // the presenter's snapshot while a drag is on (nil otherwise)
	UIView *_underDim;                   // a black veil over it that clears as Now Playing goes down
	BOOL _dismissing;
	// 3b bar: a real UINavigationBar with the two-line title
	UINavigationBar *_navBar;
	UINavigationItem *_navItem;
	UIBarButtonItem *_upNextItem;
	UILabel *_songLabel, *_artistLabel;
	// strip
	UILabel *_countLabel, *_elapsed, *_remain;
	UISlider *_slider;
	BOOL _scrubbing;
	UIButton *_shuffle, *_repeat, *_add, *_pill;
	ENHeartButton *_heart;
	NSString *_pillText;
	// art (3b: one pan; the art and the open lyrics follow the finger inside _artBox, which clips them)
	UIView *_artBox;
	UIImageView *_art;
	UIView *_buffer;
	UIActivityIndicatorView *_bufferSpin;
	UIImage *_placeholder;
	CGFloat _placeholderSide;            // the art side _placeholder was drawn for
	CGSize _columnSize;                  // the view size the column was last laid out for (-layoutColumn)
	UIImageView *_ctl, *_bottomBar;      // the transport row and the bottom bar (moved by -layoutColumn)
	UIPanGestureRecognizer *_artPan;
	BOOL _skipping;                      // a drag's skip is sliding out / waiting / sliding in: no new drag meanwhile
	BOOL _skipNext;                      // its direction (the side the new song comes in from)
	BOOL _waitingSong;                   // slid out; the new song hasn't shown yet (the reply is still out)
	NSString *_skipFrom;                 // the song the skip left (nil once another one shows, or for a restart)
	// transport
	UIButton *_play, *_prev, *_next;
	UIActivityIndicatorView *_playSpin;  // 3b: replaces the play glyph while loading && playing
	UIImage *_playImg, *_pauseImg, *_shuffleImg[2], *_repeatImg[3];
	NSTimer *_timer;
	// 0.11.1: the 0.10 bottom bar again: the volume, then Lyrics | Album | Artist | (Jam) | More
	MPVolumeView *_volume;
	UIButton *_lyricsButton, *_album, *_artist, *_jam, *_more;
	BOOL _jamButtonShown, _laidOut;
	// 0.8 lyrics (DESIGN-LYRICS §3)
	ENLyricsView *_lyrics;
	BOOL _lyricsOpen, _onScreen, _appActive;
	UIStatusBarStyle _statusBarBefore;   // 0.10 (A2): the style to put back when this screen goes (it shows BlackOpaque);
	                                     // Default (0, showMain's) until another one is seen (1.1: iOS 5's tabs: BlackOpaque)
	// 3b "Playing from <name>"
	NSString *_ctxURI, *_ctxName;        // the context the name is for, and the name (nil while unknown)
	BOOL _ctxAsked;                      // Up Next's ctx.n was asked for _ctxURI
	NSUInteger _ctxGen;                  // (R2a) the +[ENAnon generation] _ctxName was taken under: another one asks again
	// 0.11.2: "Playing from <name> ›" opens that page
	UIButton *_fromButton;               // the tap target behind the label (pressed: npTransportPressed around name + chevron)
	UIImageView *_fromChevron;           // the › after the name
	ENNowFrom _fromKind;                 // what the line shown opens (ENNowFromNone: not tappable)
	NSString *_fromURI, *_fromName;      // that page's uri, and the name the line shows
}

#pragma mark - building

- (UIButton *)button:(CGRect)f image:(UIImage *)img action:(SEL)sel in:(UIView *)parent {
	UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
	b.frame = f;
	b.showsTouchWhenHighlighted = YES;
	if (img) [b setImage:img forState:UIControlStateNormal];
	[b addTarget:self action:sel forControlEvents:UIControlEventTouchUpInside];
	[parent addSubview:b];
	return b;
}

- (UILabel *)label:(CGRect)f font:(UIFont *)font color:(UIColor *)c align:(NSTextAlignment)a in:(UIView *)parent {
	UILabel *l = [[UILabel alloc] initWithFrame:f];
	l.font = font;
	l.textColor = c;
	l.textAlignment = a;
	l.backgroundColor = [UIColor clearColor];
	[parent addSubview:l];
	return l;
}

// a transport button: the glyph, and npTransportPressed (white .08) as its pressed background (no glow, no darkening)
- (UIButton *)transport:(CGRect)f image:(UIImage *)img action:(SEL)sel in:(UIView *)parent {
	UIButton *b = [self button:f image:img action:sel in:parent];
	b.showsTouchWhenHighlighted = NO;
	b.adjustsImageWhenHighlighted = NO;
	[b setBackgroundImage:[ENTheme current].npTransportPressed forState:UIControlStateHighlighted];
	return b;
}

// a small icon-over-label button of the bottom bar (Lyrics, Album, Artist, Jam, More; 0.10's, as it was): a 20 pt glyph
// 6 pt above the middle (#5b6a54 when disabled) over a Bold 10 label; the label keeps its colour (green only for Lyrics open)
- (UIButton *)action:(CGRect)f glyph:(NSString *)glyph title:(NSString *)title sel:(SEL)sel in:(UIView *)parent {
	ENTheme *th = [ENTheme current];
	UIButton *b = [self button:f image:[th glyphNamed:glyph size:20 color:ENNowBarInk()] action:sel in:parent];
	[b setImage:[th glyphNamed:glyph size:20 color:th.npActionDisabled] forState:UIControlStateDisabled];
	b.imageEdgeInsets = UIEdgeInsetsMake(-12, 0, 0, 0);
	UILabel *l = [self label:CGRectMake(0, f.size.height - 15, f.size.width, 12) font:ENNowBarFont() color:ENNowBarInk()
	                   align:NSTextAlignmentCenter in:b];
	l.text = title;
	l.tag = ENActionLabelTag;
	return b;
}

- (void)loadView {
	ENTheme *th = [ENTheme current];
	CGRect app = [UIScreen mainScreen].applicationFrame;
	UIView *v = [[UIView alloc] initWithFrame:CGRectMake(0, 0, app.size.width, app.size.height)];
	v.backgroundColor = [UIColor blackColor];
	self.view = v;
	CGFloat W = v.bounds.size.width, H = v.bounds.size.height;
	// 0.10's column, top to bottom, laid out from the real height: bar 44, strip 82, the art, transport 58 and the bottom
	// bar 44. (R2c) Only the art gives way on a short screen, so the strip, the transport and the whole bottom bar keep
	// their sizes: 4-inch (548 pt under the status bar) 44 + 82 + 320 + 58 + 44 = 548, the art 320 x 320; 3.5-inch (460 pt)
	// 44 + 82 + 232 + 58 + 44 = 460, the art 232 x 232, centred.
	CGFloat artSide = MIN(W, H - 44 - 82 - 58 - 44);
	CGFloat yStrip = 44, yArt = yStrip + 82, yCtl = yArt + artSide, yBottom = yCtl + 58;

	[self buildBar:W];
	[self buildStrip:CGRectMake(0, yStrip, W, 82)];

	// art (3b: one pan = next / previous; 0.8: tap = lyrics) with the buffering overlay and the lyrics, all in one clipping
	// box: the art's row, the full width (R2c). The art and its buffering overlay are the centred square; the lyrics take
	// the whole row, so on 3.5-inch they keep the full width (the art's 44 pt side margins); on 4-inch the row is the art.
	_placeholder = [th nowPlayingPlaceholderOfSide:artSide];
	_placeholderSide = artSide;
	_artBox = [[UIView alloc] initWithFrame:CGRectMake(0, yArt, W, artSide)];
	_artBox.backgroundColor = [UIColor clearColor];
	_artBox.clipsToBounds = YES;
	[v addSubview:_artBox];
	_art = [[UIImageView alloc] initWithFrame:CGRectMake(floorf((W - artSide) / 2), 0, artSide, artSide)];
	_art.contentMode = UIViewContentModeScaleAspectFill;
	_art.clipsToBounds = YES;
	_art.image = _placeholder;
	_art.userInteractionEnabled = YES;
	_artPan = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(artPanned:)];
	_artPan.delegate = self;
	[_art addGestureRecognizer:_artPan];
	[_art addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(tapArt)]];
	[_artBox addSubview:_art];
	_buffer = [[UIView alloc] initWithFrame:_art.frame];
	_buffer.backgroundColor = th.npBufferDim;
	_buffer.userInteractionEnabled = NO;
	_buffer.hidden = YES;
	_bufferSpin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleWhiteLarge];
	_bufferSpin.center = CGPointMake(artSide / 2, artSide / 2);
	[_buffer addSubview:_bufferSpin];
	[_artBox addSubview:_buffer];
	// 0.8: the lyrics, over the art's whole row (R2c; on 4-inch exactly the art) and above the buffering overlay; shown by
	// -setLyricsOpen:animated:. While only a spinner or a message shows, touches fall through it to the art (its tap and pan;
	// on 3.5-inch the side margins beside the art have neither).
	_lyrics = [[ENLyricsView alloc] initWithFrame:_artBox.bounds];
	_lyrics.canSeek = ^BOOL { return ENNowCanSeek(); };
	_lyrics.hidden = YES;
	_lyrics.alpha = 0;
	[_artBox addSubview:_lyrics];

	// 0.8.2: drag down (anywhere but a slider, the volume or open lyrics) to put Now Playing away
	_dismissPan = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(dismissPanned:)];
	_dismissPan.delegate = self;
	[v addGestureRecognizer:_dismissPan];

	[self buildTransport:CGRectMake(0, yCtl, W, 58)];
	[self buildBottom:CGRectMake(0, yBottom, W, H - yBottom)];
	_columnSize = v.bounds.size;
	[self layoutJam];

	if ([[NSUserDefaults standardUserDefaults] boolForKey:ENLyricsOpenKey]) [self setLyricsOpen:YES animated:NO];
}

// The column again whenever the view's size changes after -loadView: the double-height status bar (a call, Personal
// Hotspot, navigation) shrinks the view by 20 pt while Now Playing is open, and gives them back when it goes. As at
// launch only the art gives way, so the transport and the whole bottom bar stay on screen (and no black strip is left
// under the bar when the view grows back).
- (void)viewWillLayoutSubviews {
	[super viewWillLayoutSubviews];
	[self layoutColumn];
}

- (void)layoutColumn {
	CGSize size = self.view.bounds.size;
	if (!_artBox || CGSizeEqualToSize(size, _columnSize)) return;
	_columnSize = size;
	CGFloat W = size.width, H = size.height;
	CGFloat artSide = MAX(0, MIN(W, H - 44 - 82 - 58 - 44));
	CGFloat yArt = 44 + 82, yCtl = yArt + artSide, yBottom = yCtl + 58;
	_artBox.frame = CGRectMake(0, yArt, W, artSide);
	// the art and the lyrics can be mid-slide (a transform): bounds and center, never frame
	_art.bounds = CGRectMake(0, 0, artSide, artSide);
	_art.center = CGPointMake(floorf((W - artSide) / 2) + artSide / 2, artSide / 2);
	_buffer.bounds = _art.bounds;
	_buffer.center = _art.center;
	_bufferSpin.center = CGPointMake(artSide / 2, artSide / 2);
	_lyrics.bounds = CGRectMake(0, 0, W, artSide);
	_lyrics.center = CGPointMake(W / 2, artSide / 2);
	_ctl.frame = CGRectMake(0, yCtl, W, 58);
	_bottomBar.frame = CGRectMake(0, yBottom, W, H - yBottom);
	if (artSide != _placeholderSide) {
		UIImage *old = _placeholder;
		_placeholder = [[ENTheme current] nowPlayingPlaceholderOfSide:artSide];
		_placeholderSide = artSide;
		if (_art.image == old) _art.image = _placeholder;
	}
}

// 3b: a standalone UINavigationBar, so the global appearance gives it the same green skin and buttons as every other bar
- (void)buildBar:(CGFloat)W {
	ENTheme *th = [ENTheme current];
	_navBar = [[UINavigationBar alloc] initWithFrame:CGRectMake(0, 0, W, 44)];
	_navItem = [[UINavigationItem alloc] initWithTitle:@""];
	_navItem.leftBarButtonItem = [ENTheme barButtonWithGlyph:@"chevDown" target:self action:@selector(close)];
	_upNextItem = [ENTheme barButtonWithGlyph:@"list" target:self action:@selector(tapUpNext)];   // shown by -updateUpNext
	UIView *tv = [[UIView alloc] initWithFrame:CGRectMake(0, 0, W - 108, 44)];   // x 54 … W-54 (the mockup's .np-bar title)
	tv.backgroundColor = [UIColor clearColor];
	tv.userInteractionEnabled = NO;
	_artistLabel = [self label:CGRectMake(0, 5, W - 108, 14) font:th.npArtistsFont color:th.navTitleSub align:NSTextAlignmentCenter in:tv];
	_songLabel = [self label:CGRectMake(0, 18, W - 108, 21) font:th.npTitleFont color:th.navTitle align:NSTextAlignmentCenter in:tv];
	for (UILabel *l in @[ _artistLabel, _songLabel ]) {
		l.shadowColor = th.navTitleShadow;
		l.shadowOffset = CGSizeMake(0, -1);
		l.autoresizingMask = UIViewAutoresizingFlexibleWidth;
	}
	_navItem.titleView = tv;
	_navBar.items = @[ _navItem ];
	[self.view addSubview:_navBar];
}

// The strip, always the three rows of the mockup (DESIGN-5 B2): the Jam pill / "Listening on…" / "Playing from…" at y 3,
// the scrubber with its 38 pt times at y 24, repeat | ♥ ⊕ | shuffle at y 46 (22 pt glyphs; ♥ and ⊕ 70 pt apart centre to
// centre: the mockup's 40 pt gap between their 30 pt boxes).
- (void)buildStrip:(CGRect)f {
	ENTheme *th = [ENTheme current];
	CGFloat W = f.size.width;
	UIImageView *strip = [[UIImageView alloc] initWithFrame:f];
	strip.image = th.npStripBackground;
	strip.userInteractionEnabled = YES;
	[self.view addSubview:strip];

	_countLabel = [self label:CGRectMake(10, 3, W - 20, 21) font:th.npCountFont color:th.npCountText align:NSTextAlignmentCenter in:strip];
	// 0.11.2: a "Playing from" line that can open its page gets a chevron (chevRight 12 in the line's colour) after the name
	// and a button behind both (the label and the chevron let touches through to it) with the transport's pressed overlay;
	// -setFromLine:… places them, -showFromRow hides them while the line can't open (or the Jam pill replaces it)
	_fromButton = [UIButton buttonWithType:UIButtonTypeCustom];
	_fromButton.adjustsImageWhenHighlighted = NO;
	[_fromButton setBackgroundImage:th.npTransportPressed forState:UIControlStateHighlighted];
	[_fromButton addTarget:self action:@selector(tapPlayingFrom) forControlEvents:UIControlEventTouchUpInside];
	_fromButton.hidden = YES;
	[strip insertSubview:_fromButton belowSubview:_countLabel];
	_fromChevron = [[UIImageView alloc] initWithImage:[th glyphNamed:@"chevRight" size:ENFromChevSide color:th.npCountText]];
	_fromChevron.hidden = YES;
	[strip addSubview:_fromChevron];
	// 0.6: the Jam pill (in a Jam, in place of the line above)
	_pill = [UIButton buttonWithType:UIButtonTypeCustom];
	[_pill setBackgroundImage:th.jamPillImage forState:UIControlStateNormal];
	[_pill setImage:[th glyphNamed:@"people" size:13 color:th.jamBarText] forState:UIControlStateNormal];
	_pill.titleLabel.font = th.jamPillFont;
	[_pill setTitleColor:th.jamBarText forState:UIControlStateNormal];
	[_pill setTitleShadowColor:th.jamBarTextShadow forState:UIControlStateNormal];
	_pill.titleLabel.shadowOffset = CGSizeMake(0, -1);
	_pill.titleEdgeInsets = UIEdgeInsetsMake(-2, 6, 0, 0);
	_pill.imageEdgeInsets = UIEdgeInsetsMake(-2, 0, 0, 0);
	_pill.adjustsImageWhenHighlighted = NO;
	_pill.hidden = YES;
	[_pill addTarget:self action:@selector(tapJam) forControlEvents:UIControlEventTouchUpInside];
	[strip addSubview:_pill];

	_elapsed = [self label:CGRectMake(9, 24, 38, 22) font:th.npTimeFont color:th.npTimeText align:NSTextAlignmentLeft in:strip];
	_remain = [self label:CGRectMake(W - 47, 24, 38, 22) font:th.npTimeFont color:th.npTimeText align:NSTextAlignmentRight in:strip];
	for (UILabel *l in @[ _elapsed, _remain ]) {
		l.adjustsFontSizeToFitWidth = YES;          // "-1:02:03"
		ENSetMinimumScaleFactor(l, 0.75f);       // (1.1: iOS 5, minimumFontSize)
	}
	_slider = [[UISlider alloc] initWithFrame:CGRectMake(55, 24, W - 110, 22)];
	[th styleSlider:_slider];
	[_slider addTarget:self action:@selector(scrubStart) forControlEvents:UIControlEventTouchDown];
	[_slider addTarget:self action:@selector(scrubMove) forControlEvents:UIControlEventValueChanged];
	[_slider addTarget:self action:@selector(scrubEnd) forControlEvents:UIControlEventTouchUpInside | UIControlEventTouchUpOutside | UIControlEventTouchCancel];
	[strip addSubview:_slider];

	_repeatImg[0] = [th glyphNamed:@"repeat" size:22 color:th.npToggleOff];
	_repeatImg[1] = [th glyphNamed:@"repeat" size:22 color:th.npToggleOn];
	_repeatImg[2] = th.repeatOneImage;              // the same glyph centre, with the "1" badge
	_shuffleImg[0] = [th glyphNamed:@"shuffle" size:22 color:th.npToggleOff];
	_shuffleImg[1] = [th glyphNamed:@"shuffle" size:22 color:th.npToggleOn];
	_repeat = [self button:CGRectMake(7, 46, 44, 36) image:_repeatImg[0] action:@selector(tapRepeat) in:strip];
	_shuffle = [self button:CGRectMake(W - 51, 46, 44, 36) image:_shuffleImg[0] action:@selector(tapShuffle) in:strip];
	_heart = [[ENHeartButton alloc] initWithFrame:CGRectMake(floorf(W / 2) - 57, 46, 44, 36) style:ENHeartOnDark];
	_heart.followsPlayback = YES;
	[strip addSubview:_heart];
	_add = [self button:CGRectMake(floorf(W / 2) + 13, 46, 44, 36) image:[th glyphNamed:@"addlistPlus" size:22 color:th.npToggleOn]
	             action:@selector(tapAdd) in:strip];
}

// 3b transport: three buttons with the play button centred, full-height separators (1 pt #000 + 1 pt white .07) between
// them, and a pressed overlay instead of the glow
- (void)buildTransport:(CGRect)f {
	ENTheme *th = [ENTheme current];
	CGFloat W = f.size.width, h = f.size.height;
	UIImageView *ctl = [[UIImageView alloc] initWithFrame:f];
	_ctl = ctl;
	ctl.image = th.npTransportBackground;
	ctl.userInteractionEnabled = YES;
	[self.view addSubview:ctl];
	CGFloat pw = 106, px = floorf((W - pw) / 2);
	UIColor *white = th.navTitle;
	_prev = [self transport:CGRectMake(0, 0, px - 2, h) image:[th glyphNamed:@"prev" size:30 color:white] action:@selector(tapPrev) in:ctl];
	_playImg = [th glyphNamed:@"play" size:34 color:white];
	_pauseImg = [th glyphNamed:@"pause" size:34 color:white];
	_play = [self transport:CGRectMake(px, 0, pw, h) image:_playImg action:@selector(tapPlay) in:ctl];
	_next = [self transport:CGRectMake(px + pw + 2, 0, W - px - pw - 2, h) image:[th glyphNamed:@"next" size:30 color:white]
	                 action:@selector(tapNext) in:ctl];
	for (NSNumber *x in @[ @(px - 2), @(px + pw) ]) {
		UIImageView *sep = [[UIImageView alloc] initWithFrame:CGRectMake([x floatValue], 0, 2, h)];
		sep.image = th.npTransportSeparator;
		sep.userInteractionEnabled = NO;
		[ctl addSubview:sep];
	}
	_playSpin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleWhiteLarge];
	_playSpin.hidesWhenStopped = YES;
	_playSpin.userInteractionEnabled = NO;          // (the button under it stays tappable)
	_playSpin.center = CGPointMake(pw / 2, h / 2);
	[_play addSubview:_playSpin];
}

// 0.11.1 (DESIGN-5 §2.2, feedback on 0.11.0): the 0.10 bottom bar again, one row on 0.10's dark bar: the MPVolumeView as
// 0.10 had it (the stock iOS 6 slider, no slider kit, and its AirPlay route button) on the left, then Lyrics | Album |
// Artist | (Jam) | More, 42 x 44 each, placed by -layoutJam
- (void)buildBottom:(CGRect)f {
	ENTheme *th = [ENTheme current];
	CGFloat W = f.size.width;
	UIImageView *bottom = [[UIImageView alloc] initWithFrame:f];
	_bottomBar = bottom;
	bottom.image = th.npBottomBackground;           // (0.10's 44 pt #0b1309 -> #020402 bar)
	bottom.userInteractionEnabled = YES;
	[self.view addSubview:bottom];
	_volume = [[MPVolumeView alloc] initWithFrame:CGRectMake(12, floorf((f.size.height - 23) / 2) + 2, W - 12 - 174, 23)];
	[bottom addSubview:_volume];
	CGRect af = CGRectMake(0, 0, 42, 44);
	_lyricsButton = [self action:af glyph:@"mic" title:@"Lyrics" sel:@selector(toggleLyrics) in:bottom];
	UIImage *mic = [th glyphNamed:@"mic" size:20 color:ENNowBarLit()];     // selected (green) while the lyrics are open
	[_lyricsButton setImage:mic forState:UIControlStateSelected];
	[_lyricsButton setImage:mic forState:UIControlStateSelected | UIControlStateHighlighted];
	_album = [self action:af glyph:@"album" title:@"Album" sel:@selector(tapAlbum) in:bottom];
	_artist = [self action:af glyph:@"artist" title:@"Artist" sel:@selector(tapArtist) in:bottom];
	_jam = [self action:af glyph:@"people" title:@"Jam" sel:@selector(tapJam) in:bottom];
	_jam.hidden = YES;
	_more = [self action:af glyph:@"dots" title:@"More" sel:@selector(tapMore) in:bottom];
}

#pragma mark - 0.6 Jam layout (DESIGN-4b §6.7)

// The strip's first row: the pill in a Jam (else the line, -refresh). The bottom bar (0.10's rule, 0.11.1): + Jam whenever
// ENJam is available, Lyrics first; 42 pt per button, flush right 2 pt from the edge, and the volume view gets the rest of
// the width. Up Next.
- (void)layoutJam {
	ENJam *jam = [ENJam shared];
	CGFloat W = self.view.bounds.size.width;
	BOOL inJam = jam.active, jamButton = jam.available;
	_pill.hidden = !inJam;
	_countLabel.hidden = inJam;
	[self showFromRow];                          // (0.11.2: the chevron and the button go with the line)
	if (inJam) {
		NSString *t = [jam pillText] ?: @"Jam";
		if (![t isEqualToString:_pillText]) {
			_pillText = t;
			[_pill setTitle:t forState:UIControlStateNormal];
			CGFloat w = MIN(ceilf([t sizeWithFont:_pill.titleLabel.font].width) + 34, W - 40);
			_pill.frame = CGRectMake(floorf((W - w) / 2), 3, w, 21);
		}
	} else {
		_pillText = nil;
	}
	if (!_laidOut || jamButton != _jamButtonShown) {
		_jamButtonShown = jamButton;
		NSMutableArray *row = [NSMutableArray arrayWithObjects:_lyricsButton, _album, _artist, nil];
		if (jamButton) [row addObject:_jam];
		[row addObject:_more];
		CGFloat rw = 42 * (CGFloat)row.count, bx = W - 2 - rw;
		for (UIButton *b in row) {
			b.frame = CGRectMake(bx, 0, 42, 44);
			bx += 42;
		}
		_jam.hidden = !jamButton;
		CGRect vf = _volume.frame;
		vf.size.width = W - 12 - (rw + 6);           // 4 buttons: W - 12 - 174; 5: W - 12 - 216
		_volume.frame = vf;
	}
	_laidOut = YES;
	[self updateUpNext];
}

// the Up Next bar button: hidden while ENJam isn't available or the gateway answered 404
- (void)updateUpNext {
	BOOL show = [ENJam shared].available && ![ENPlayback shared].queueMissing;
	if ((_navItem.rightBarButtonItem != nil) != show) [_navItem setRightBarButtonItem:(show ? _upNextItem : nil) animated:NO];
}

- (void)jamChanged {
	[self layoutJam];
	[self refresh];
}

#pragma mark - appearing

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	// 0.10 (DESIGN-5 §2.1 A2, the status-bar spike D3a-2): BlackOpaque while it is up (3b: kept; on the device the tabs'
	// green status bar comes from UIStatusBarStyleDefault, and a standalone bar isn't known to tint it);
	// viewWillDisappear: puts the tabs' style back
	UIApplication *app = [UIApplication sharedApplication];
	if (app.statusBarStyle != UIStatusBarStyleBlackOpaque) _statusBarBefore = app.statusBarStyle;     // (else: Default, the tabs')
	else if (!ENSystemIs6()) _statusBarBefore = [ENAppDelegate mainStatusBarStyle];     // (1.1) iOS 5: the tabs' BlackOpaque
	[app setStatusBarStyle:UIStatusBarStyleBlackOpaque animated:animated];
	NSString *uri = [[ENPlayback shared] playingURI];
	if (uri) [[ENCatalog shared] checkSaved:@[ uri ] done:nil];     // a heart liked on another device shows (T-c5)
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(refresh) name:ENPlaybackChangedNotification object:nil];
	[nc addObserver:self selector:@selector(jamChanged) name:ENJamChangedNotification object:nil];
	[nc addObserver:self selector:@selector(jamChanged) name:ENCatalogVersionNotification object:nil];
	[nc addObserver:self selector:@selector(jamChanged) name:ENAnonChangedNotification object:nil];     // (R2a) pill, lines
	[nc addObserver:self selector:@selector(appInactive) name:UIApplicationWillResignActiveNotification object:nil];
	[nc addObserver:self selector:@selector(appInactive) name:UIApplicationDidEnterBackgroundNotification object:nil];
	[nc addObserver:self selector:@selector(appActive) name:UIApplicationDidBecomeActiveNotification object:nil];
	_onScreen = YES;
	[self startTimer];
	[self layoutJam];
	[self refresh];
	_appActive = [UIApplication sharedApplication].applicationState == UIApplicationStateActive;
	[self updateLyricsActive];
}

- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	[self becomeFirstResponder];          // lock screen / AirPods while it is up
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	[[UIApplication sharedApplication] setStatusBarStyle:_statusBarBefore animated:animated];
	[self stopTimer];
	[[NSNotificationCenter defaultCenter] removeObserver:self];
	_onScreen = NO;
	[self updateLyricsActive];
}

// The 0.5 s clock only while shown AND the app is active: locking the phone or leaving the app doesn't call
// viewWillDisappear:, so it stops on WillResignActive / DidEnterBackground and restarts on DidBecomeActive (as ENMiniPlayer).
- (void)startTimer {
	if (_timer) return;
	_timer = [NSTimer timerWithTimeInterval:0.5 target:self selector:@selector(refresh) userInfo:nil repeats:YES];
	[[NSRunLoop mainRunLoop] addTimer:_timer forMode:NSRunLoopCommonModes];
}

- (void)stopTimer {
	[_timer invalidate];
	_timer = nil;
}

- (void)appInactive {
	[self stopTimer];
	_appActive = NO;
	[self updateLyricsActive];
}

- (void)appActive {
	[self startTimer];
	[self refresh];
	_appActive = YES;
	[self updateLyricsActive];
}

- (void)viewDidDisappear:(BOOL)animated {
	[super viewDidDisappear:animated];
	if (!self.presentedViewController) [[ENTabBarController shared] reclaimFirstResponder];   // dismissed (not just covered)
}

- (BOOL)canBecomeFirstResponder { return YES; }

- (void)remoteControlReceivedWithEvent:(UIEvent *)event {
	[[ENPlayback shared] handleRemoteEvent:event];
}

- (NSUInteger)supportedInterfaceOrientations { return UIInterfaceOrientationMaskPortrait; }

#pragma mark - refresh

static NSString *ENClock(double ms) { return ENTimeText(MAX(ms, 0)); }

- (void)refresh {
	ENPlayback *pb = [ENPlayback shared];
	ENJam *jam = [ENJam shared];
	NSDictionary *t = pb.track;
	NSString *name = ENJStr(t[@"name"]);
	NSArray *artists = ENJArr(t[@"artists"]);
	_songLabel.text = name ?: @"Not playing";
	_artistLabel.text = artists.count ? [artists componentsJoinedByString:@", "] : @"";

	// the strip's first line (3b; under the pill in a Jam): another device's, else where this plays from (0.11.2: that one
	// opens its page when the context has one)
	BOOL remote = pb.remoteDevice && !pb.playing;
	if (!jam.active) {
		if (remote) {
			[self setFromLine:[@"Listening on " stringByAppendingString:pb.remoteDevice] kind:ENNowFromNone page:nil name:nil];
		} else {
			NSString *line = [self playingFromText:t];
			ENNowFrom kind = ENNowFromNone;
			NSString *page = line.length ? ENNowFromPage(_ctxURI, &kind) : nil;
			[self setFromLine:line kind:kind page:page name:_ctxName];
		}
	}

	UIImage *art = pb.artwork ?: _placeholder;
	if (_art.image != art) {
		UIImageView *iv = _art;
		[UIView transitionWithView:iv duration:0.25 options:UIViewAnimationOptionTransitionCrossDissolve
		                animations:^{ iv.image = art; } completion:nil];
	}
	BOOL busy = pb.loading && pb.playing;
	if (busy == _buffer.hidden) {
		_buffer.hidden = !busy;
		if (busy) {
			[_bufferSpin startAnimating];
			[_playSpin startAnimating];
		} else {
			[_bufferSpin stopAnimating];
			[_playSpin stopAnimating];
		}
	}

	double dur = pb.durationMs, pos = pb.positionMs;
	if (!_scrubbing) {
		_slider.value = dur > 0 ? (float)MIN(1.0, MAX(0.0, pos / dur)) : 0;
		_elapsed.text = ENClock(pos);
	}
	_remain.text = dur > 0 ? [@"-" stringByAppendingString:ENClock(dur - (_scrubbing ? _slider.value * dur : pos))] : @"";
	_slider.enabled = ENNowCanSeek();         // dur > 0, and not a Jam guest without control (the lyrics' canSeek too)

	UIImage *pi = busy ? nil : pb.playing ? _pauseImg : _playImg;      // (3b: the spinner instead while loading)
	if ([_play imageForState:UIControlStateNormal] != pi) [_play setImage:pi forState:UIControlStateNormal];
	[_shuffle setImage:_shuffleImg[pb.shuffle ? 1 : 0] forState:UIControlStateNormal];
	NSUInteger r = [pb.repeatMode isEqualToString:@"track"] ? 2 : [pb.repeatMode isEqualToString:@"context"] ? 1 : 0;
	[_repeat setImage:_repeatImg[r] forState:UIControlStateNormal];

	ENTrack *song = [pb playingTrack];
	_album.enabled = song.albumURI != nil;
	_artist.enabled = song.artistURI != nil;
	_more.enabled = song != nil;
	_add.enabled = song != nil;
	_add.alpha = song ? 1 : 0.4f;

	// 0.6: a Jam guest without playback control can't skip, seek, shuffle or repeat from here (§6.7; 3b: the art drag only
	// rubber-bands)
	BOOL ctl = ENNowControl();
	CGFloat a = ctl ? 1 : 0.4f;
	_prev.enabled = _next.enabled = _shuffle.enabled = _repeat.enabled = ctl;
	_prev.alpha = _next.alpha = _shuffle.alpha = _repeat.alpha = a;
	_slider.alpha = a;
	[self updateUpNext];

	// 0.8 lyrics: the cover follows ENPlayback's; the open view follows the song (the same uri again does nothing)
	_lyrics.artwork = pb.artwork;
	if (_lyricsOpen) [_lyrics showTrack:song];
	_lyricsButton.enabled = song != nil || _lyricsOpen;

	if (_waitingSong && ![self skipPending]) [self artSlideIn];     // a drag's new song showed (or its command ended)
}

// "Playing from <name>" (3b): the context of what plays (the track's context_uri, else the snapshot's). Its name is what the
// app already knows (ENNowCatalogName), else Up Next's ctx.n: asked once per new context (an ETag'd GET /v1/player/queue,
// only where Up Next exists, never for a one-song play), else nothing.
- (NSString *)playingFromText:(NSDictionary *)t {
	NSString *ctx = ENJStr(t[@"context_uri"]) ?: ENJStr([ENPlayback shared].engine[@"context_uri"]);
	if (!(ctx == _ctxURI || [ctx isEqualToString:_ctxURI]) || _ctxGen != [ENAnon generation]) {
		_ctxURI = [ctx copy];
		_ctxName = nil;
		_ctxAsked = NO;
		_ctxGen = [ENAnon generation];
	}
	if (!ctx) return @"";
	if (!_ctxName) _ctxName = [ENNowCatalogName(ctx, t) copy];
	if (!_ctxName && !_ctxAsked) [self askQueueForContext:ctx];
	return _ctxName.length ? [@"Playing from " stringByAppendingString:_ctxName] : @"";
}

- (void)askQueueForContext:(NSString *)ctx {
	_ctxAsked = YES;
	if ([ctx isEqualToString:sQueueCtxURI] && sQueueCtxGen == [ENAnon generation]) {
		_ctxName = [sQueueCtxName copy];
		return;
	}
	ENPlayback *pb = [ENPlayback shared];
	if (![ENJam shared].available || pb.queueMissing || [ctx hasPrefix:@"spotify:track:"]) return;
	__weak ENNowPlayingViewController *w = self;
	[pb loadQueue:^(ENQueue *q, BOOL notModified, NSError *e) {
		if (!q) return;                      // (an error: no name; the next Now Playing may ask again)
		NSString *n = [q.contextURI isEqualToString:ctx] && q.contextName.length ? q.contextName : nil;
		sQueueCtxURI = [ctx copy];
		sQueueCtxName = [n copy];
		sQueueCtxGen = [ENAnon generation];
		ENNowPlayingViewController *s = w;
		if (!s || !n || s->_ctxName || ![ctx isEqualToString:s->_ctxURI]) return;
		s->_ctxName = [n copy];
		if (s->_onScreen) [s refresh];
	}];
}

// 0.11.2: row 1's line and what it opens, laid out only when either changes. A line that opens is the label cut to its text
// (still tail-truncated, so name and chevron fit in the row's W - 20) with the chevron after it, centred together, and the
// button around both (8 pt either side, y 2 … 24, the strip's room above the scrubber); any other line is 3b's full-width
// centred label.
- (void)setFromLine:(NSString *)line kind:(ENNowFrom)kind page:(NSString *)page name:(NSString *)name {
	if (!line.length || !page) kind = ENNowFromNone;
	if (!kind) page = nil;
	if ([_countLabel.text isEqualToString:line] && kind == _fromKind && (page == _fromURI || [page isEqualToString:_fromURI])) {
		[self showFromRow];
		return;
	}
	_countLabel.text = line;
	_fromKind = kind;
	_fromURI = [page copy];
	_fromName = kind ? [name copy] : nil;
	CGFloat W = self.view.bounds.size.width, room = W - 20;
	if (!kind) {
		_countLabel.frame = CGRectMake(10, 3, room, 21);
	} else {
		CGFloat lw = MIN(ceilf([line sizeWithFont:_countLabel.font].width), room - ENFromChevRoom);
		CGFloat x = floorf((W - lw - ENFromChevRoom) / 2);
		_countLabel.frame = CGRectMake(x, 3, lw, 21);
		_fromChevron.frame = CGRectMake(x + lw, 7.5f, ENFromChevSide, ENFromChevSide);    // its ink centred on the text's
		_fromButton.frame = CGRectMake(x - ENFromPad, 2, lw + ENFromChevRoom + 2 * ENFromPad, 22);
		_fromButton.accessibilityLabel = [@"Open " stringByAppendingString:ENNowFromWord(kind)];
	}
	[self showFromRow];
}

// the chevron and the button show with a line that opens, and not while the Jam pill has the row
- (void)showFromRow {
	BOOL show = _fromKind != ENNowFromNone && !_countLabel.hidden;
	if (_fromButton.hidden == show) _fromButton.hidden = _fromChevron.hidden = !show;
}

#pragma mark - 0.8 lyrics (DESIGN-LYRICS §3)

- (void)tapArt {
	if (_lyricsOpen || [[ENPlayback shared] playingTrack]) [self toggleLyrics];
}

- (void)toggleLyrics {
	[self setLyricsOpen:!_lyricsOpen animated:YES];
	[[NSUserDefaults standardUserDefaults] setBool:_lyricsOpen forKey:ENLyricsOpenKey];
}

// The lyrics view cross-dissolves over the art (0.25 s); the Lyrics button shows the selected (green) state while open.
- (void)setLyricsOpen:(BOOL)open animated:(BOOL)animated {
	_lyricsOpen = open;
	_lyricsButton.selected = open;
	[(UILabel *)[_lyricsButton viewWithTag:ENActionLabelTag] setTextColor:(open ? ENNowBarLit() : ENNowBarInk())];
	ENLyricsView *lv = _lyrics;
	if (open) {
		ENPlayback *pb = [ENPlayback shared];
		lv.artwork = pb.artwork;
		[lv showTrack:[pb playingTrack]];
		lv.hidden = NO;
	}
	[self updateLyricsActive];
	if (!animated) {
		lv.alpha = open ? 1 : 0;
		lv.hidden = !open;
		return;
	}
	[UIView animateWithDuration:0.25 delay:0 options:UIViewAnimationOptionBeginFromCurrentState
	                 animations:^{ lv.alpha = open ? 1 : 0; }
	                 completion:^(BOOL finished) { if (lv.alpha < 0.01f) lv.hidden = YES; }];   // (not if reopened since)
}

// the lyrics' 0.25 s clock runs while they are open, this screen is up and the app is active
- (void)updateLyricsActive {
	[_lyrics setActive:_lyricsOpen && _onScreen && _appActive];
}

#pragma mark - actions

- (void)close { [self dismissViewControllerAnimated:YES completion:nil]; }

#pragma mark - gestures

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)g shouldReceiveTouch:(UITouch *)touch {
	if (g != _dismissPan) return YES;
	if (_dismissing || self.presentedViewController || self.isBeingPresented || self.isBeingDismissed) return NO;
	for (UIView *x = touch.view; x && x != self.view; x = x.superview) {
		if ([x isKindOfClass:[UISlider class]] || [x isKindOfClass:[MPVolumeView class]]) return NO;     // their own drags
		if (x == _lyrics && _lyricsOpen) return NO;                                                    // lyrics scroll
	}
	return YES;
}

// The dismiss: only a mostly downward drag (every button keeps working). 3b, the art: only a mostly sideways one (|vx| >
// 1.2·|vy|), with a song, and not while the last skip is still under way (its slide would fight the finger, and a second
// next before the first one's song shows would name the same song again).
- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)g {
	if (g == _artPan) {
		if (_skipping || [self skipPending] || ![ENPlayback shared].track) return NO;
		CGPoint v = [_artPan velocityInView:_artBox];
		return fabs(v.x) > 1.2 * fabs(v.y);
	}
	if (g != _dismissPan) return YES;
	CGPoint vel = [_dismissPan velocityInView:self.view.superview];
	return vel.y > 0 && vel.y > 1.2f * (CGFloat)fabs(vel.x);
}

#pragma mark - 3b art drag = next / previous (ENMiniPlayer 0.8.1's swipe, ported)

// the art (and the lyrics over it, which go with their song) at x; _artBox clips them. A skip slides them by the box's
// width (the screen's), which takes the centred 3.5-inch art fully out too.
- (void)setArtOffset:(CGFloat)x {
	CGAffineTransform t = x == 0 ? CGAffineTransformIdentity : CGAffineTransformMakeTranslation(x, 0);
	_art.transform = t;
	_lyrics.transform = t;
}

- (void)artPanned:(UIPanGestureRecognizer *)g {
	CGFloat dx = [g translationInView:_artBox].x;
	BOOL can = ENNowControl();
	switch (g.state) {
		case UIGestureRecognizerStateBegan:
		case UIGestureRecognizerStateChanged:
			[self setArtOffset:(can ? dx : dx * 0.2f)];             // a guest without control: a stiff rubber band
			break;
		case UIGestureRecognizerStateEnded: {
			CGFloat vx = [g velocityInView:_artBox].x;
			BOOL back = fabs(vx) > 300 && (vx < 0) != (dx < 0);       // flicked back toward the start: keep the song
			BOOL go = can && [ENPlayback shared].track &&
			          ((fabs(dx) > ENArtSkipAt && !back) || (fabs(vx) > 600 && fabs(dx) > 20 && (vx < 0) == (dx < 0)));
			if (go) [self artSkip:(dx < 0)];
			else [self artSnapBack];
			break;
		}
		default:
			[self artSnapBack];
			break;
	}
}

- (void)artSnapBack {
	[UIView animateWithDuration:0.2 delay:0 options:UIViewAnimationOptionCurveEaseOut | UIViewAnimationOptionBeginFromCurrentState
	                 animations:^{ [self setArtOffset:0]; } completion:nil];
}

// next: the art leaves to the left and the new song comes in from the right (previous: the other way round). The track
// changes only when the command's reply (or the engine's event) arrives, so the box stays empty until then (the buffering
// overlay spins), at most 4 s.
- (void)artSkip:(BOOL)next {
	ENPlayback *pb = [ENPlayback shared];
	CGFloat w = _artBox.bounds.size.width;
	BOOL restart = !next && pb.positionMs > 3000;              // ENPlayback -previous restarts the song: it comes back as is
	_skipping = YES;
	_skipNext = next;
	_waitingSong = NO;
	_skipFrom = restart ? nil : [pb.playingURI copy];          // before the command closes the stream
	if (next) [pb next];
	else [pb previous];
	[UIView animateWithDuration:0.18 delay:0 options:UIViewAnimationOptionCurveEaseIn | UIViewAnimationOptionBeginFromCurrentState
	                 animations:^{ [self setArtOffset:(next ? -w : w)]; }
	                 completion:^(BOOL finished) {
		[self refresh];
		if ([self skipPending]) {
			self->_waitingSong = YES;                          // -refresh slides it in once the song shows (or the command failed)
			[self performSelector:@selector(skipTimedOut) withObject:nil afterDelay:4];
			return;
		}
		[self artSlideIn];
	}];
}

// the skip's command is still out and the song shown is still the one it left (else forgets that song)
- (BOOL)skipPending {
	if (!_skipFrom) return NO;
	ENPlayback *pb = [ENPlayback shared];
	if (pb.commandPending && [pb.playingURI isEqualToString:_skipFrom]) return YES;
	_skipFrom = nil;
	return NO;
}

// a slow gateway: don't leave the box empty; the new song then replaces the old one when it shows
- (void)skipTimedOut {
	if (_waitingSong) [self artSlideIn];
}

- (void)artSlideIn {
	CGFloat w = _artBox.bounds.size.width;
	_waitingSong = NO;
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(skipTimedOut) object:nil];
	[self setArtOffset:(_skipNext ? w : -w)];
	[UIView animateWithDuration:0.22 delay:0 options:UIViewAnimationOptionCurveEaseOut
	                 animations:^{ [self setArtOffset:0]; }
	                 completion:^(BOOL finished) { self->_skipping = NO; }];
}

#pragma mark - drag down to put away (0.8.2)

- (void)dismissPanned:(UIPanGestureRecognizer *)g {
	UIView *v = self.view;
	CGFloat H = v.bounds.size.height;
	CGFloat dy = MAX(0, [g translationInView:v.superview].y);
	switch (g.state) {
		case UIGestureRecognizerStateBegan:
			[v.layer removeAllAnimations];                      // a spring-back still running: the finger takes over
			[_underDim.layer removeAllAnimations];
			[self showUnder];
			// (and follow the finger)
		case UIGestureRecognizerStateChanged:
			v.transform = CGAffineTransformMakeTranslation(0, dy);
			_underDim.alpha = 0.55f * (1 - MIN(1.0f, dy / H));
			break;
		case UIGestureRecognizerStateEnded: {
			CGFloat vy = [g velocityInView:v.superview].y;
			// past a quarter puts it away unless the release flicks back up (that springs back, like Spotify's)
			if (_under && ((dy > H * 0.25f && vy > -300) || (vy > 800 && dy > 30))) [self finishDismiss:vy];
			else [self cancelDismiss];
			break;
		}
		default:
			[self cancelDismiss];
			break;
	}
}

// the tab controller as it will come back, rendered once, fixed behind this view in its own place on screen
- (void)showUnder {
	UIView *host = self.view.superview;
	UIView *pv = self.presentingViewController.view;
	if (_under || !host || !pv) return;
	CGRect r;
	if (pv.window) r = [host convertRect:pv.bounds fromView:pv];
	else {
		// iOS 6 took it out of the window with the frame it had then; the dismiss puts it back where this view is (the
		// transform is still identity here), so put it there now, whatever the status bar did meanwhile (a call's 40 pt bar)
		r = self.view.frame;
		if (!pv.superview) pv.frame = [host convertRect:r toView:nil];
	}
	[[ENTabBarController shared].miniPlayer refresh];      // its progress line stood still while covered (no timer)
	[pv layoutIfNeeded];                                   // nothing off-window is laid out (a list's reloadData builds cells there)
	UIGraphicsBeginImageContextWithOptions(r.size, YES, 0);
	[pv.layer renderInContext:UIGraphicsGetCurrentContext()];
	UIImage *img = UIGraphicsGetImageFromCurrentImageContext();
	UIGraphicsEndImageContext();
	_under = [[UIImageView alloc] initWithImage:img];
	_under.frame = r;
	_underDim = [[UIView alloc] initWithFrame:_under.bounds];
	_underDim.backgroundColor = [UIColor blackColor];
	_underDim.alpha = 0.55f;
	[_under addSubview:_underDim];
	[host insertSubview:_under belowSubview:self.view];
}

- (void)finishDismiss:(CGFloat)vy {
	_dismissing = YES;
	UIView *v = self.view;
	CGFloat H = v.bounds.size.height;
	CGFloat left = MAX(0, H - v.transform.ty);
	NSTimeInterval d = MAX(0.12, MIN(0.3, left / MAX(vy, 1100.0f)));
	[UIView animateWithDuration:d delay:0 options:UIViewAnimationOptionCurveEaseOut | UIViewAnimationOptionBeginFromCurrentState
	                 animations:^{
		v.transform = CGAffineTransformMakeTranslation(0, H + 20);
		self->_underDim.alpha = 0;
	} completion:^(BOOL finished) {
		UIImageView *under = self->_under;
		self->_under = nil;
		self->_underDim = nil;
		UIViewController *presenter = self.presentingViewController;
		if (!presenter) { [under removeFromSuperview]; return; }
		[presenter dismissViewControllerAnimated:NO completion:^{ [under removeFromSuperview]; }];
	}];
}

- (void)cancelDismiss {
	if (_dismissing) return;
	UIView *v = self.view;
	[UIView animateWithDuration:0.25 delay:0 options:UIViewAnimationOptionCurveEaseOut | UIViewAnimationOptionBeginFromCurrentState
	                 animations:^{
		v.transform = CGAffineTransformIdentity;
		self->_underDim.alpha = 0.55f;
	} completion:^(BOOL finished) {
		// a new drag that started during this spring-back keeps (and reuses) the snapshot
		UIGestureRecognizerState st = self->_dismissPan.state;
		if (self->_dismissing || st == UIGestureRecognizerStateBegan || st == UIGestureRecognizerStateChanged) return;
		[self->_under removeFromSuperview];
		self->_under = nil;
		self->_underDim = nil;
	}];
}

#pragma mark - buttons

- (void)tapPlay { [[ENPlayback shared] togglePlayPause]; [self refresh]; }
- (void)tapPrev { [[ENPlayback shared] previous]; [self refresh]; }
- (void)tapNext { [[ENPlayback shared] next]; [self refresh]; }
- (void)tapShuffle { [[ENPlayback shared] toggleShuffle]; [self refresh]; }
- (void)tapRepeat { [[ENPlayback shared] cycleRepeat]; [self refresh]; }

- (void)tapJam {
	[[ENTabBarController shared] presentJam];        // from the top-most controller: this one
}

- (void)tapUpNext {
	if (self.presentedViewController) return;
	UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:[[ENQueueViewController alloc] init]];
	nav.modalTransitionStyle = UIModalTransitionStyleFlipHorizontal;
	[self presentViewController:nav animated:YES completion:nil];
}

- (void)scrubStart { _scrubbing = YES; }

- (void)scrubMove {
	_elapsed.text = ENClock(_slider.value * [ENPlayback shared].durationMs);
}

- (void)scrubEnd {
	if (!_scrubbing) return;
	_scrubbing = NO;
	double dur = [ENPlayback shared].durationMs;
	if (dur > 0) [[ENPlayback shared] seekTo:_slider.value * dur];
	[self refresh];
}

- (void)tapAdd {
	ENTrack *t = [[ENPlayback shared] playingTrack];
	if (t) [ENTrackActions addToPlaylist:t from:self];
}

- (void)tapMore {
	ENTrack *t = [[ENPlayback shared] playingTrack];
	if (t) [ENTrackActions showMenuForTrack:t from:self options:ENTrackMenuNoGoTo busy:nil];
}

- (void)tapAlbum {
	ENTrack *t = [[ENPlayback shared] playingTrack];
	if (!t.albumURI) return;
	[[ENTabBarController shared] showViewController:[[ENTrackListViewController alloc] initWithAlbumURI:t.albumURI title:t.album image:t.image]];
}

- (void)tapArtist {
	ENTrack *t = [[ENPlayback shared] playingTrack];
	if (!t.artistURI) return;
	[[ENTabBarController shared] showViewController:[[ENArtistViewController alloc] initWithArtistURI:t.artistURI name:t.artistName]];
}

// 0.11.2: "Playing from <name> ›" -> that page, the way Album / Artist above go: -[ENTabBarController showViewController:]
// dismisses Now Playing (with anything over it) and pushes onto the selected tab, and Now Playing's viewDidDisappear: hands
// the remote controls back. The pages are made as the rest of the app makes them: Liked Songs with the library (Home,
// Playlists); a playlist with the library's row when it has one, else (someone else's playlist) a row of its uri and the
// name shown, which the page's own answer then completes (as a search row's would); the album with the song's title and
// cover when it is the song's album (tapAlbum), else the name shown; the artist with the name shown. The same page already
// on top of the selected tab: only dismiss.
- (void)tapPlayingFrom {
	ENNowFrom kind = _fromKind;
	NSString *uri = _fromURI, *name = _fromName;
	if (!kind || !uri || _dismissing || self.presentedViewController || self.isBeingDismissed) return;
	ENTabBarController *tabs = [ENTabBarController shared];
	if ([self page:tabs.currentNavigationController.topViewController is:kind uri:uri]) {
		[self close];
		return;
	}
	ENLibrary *lib = [ENCatalog shared].library;
	ENTrack *song = [[ENPlayback shared] playingTrack];
	UIViewController *vc = nil;
	switch (kind) {
		case ENNowFromLiked:
			vc = [[ENTrackListViewController alloc] initWithLikedLibrary:lib];
			break;
		case ENNowFromPlaylist: {
			ENPlaylist *pl = [lib playlistForURI:uri];
			if (!pl) pl = [ENPlaylist playlistWithJSON:(name ? @{ @"u": uri, @"n": name } : @{ @"u": uri }) meName:lib.rawMeName];
			if (pl) vc = [[ENTrackListViewController alloc] initWithPlaylist:pl];
			break;
		}
		case ENNowFromAlbum:
			if ([song.albumURI isEqualToString:uri]) vc = [[ENTrackListViewController alloc] initWithAlbumURI:uri title:song.album image:song.image];
			else vc = [[ENTrackListViewController alloc] initWithAlbumURI:uri title:name image:nil];
			break;
		case ENNowFromArtist:
			vc = [[ENArtistViewController alloc] initWithArtistURI:uri name:name];
			break;
		default:
			break;
	}
	[tabs showViewController:vc];                  // (nil: nothing)
}

// top is the page -tapPlayingFrom would push: the same kind of page for the same uri
- (BOOL)page:(UIViewController *)top is:(ENNowFrom)kind uri:(NSString *)uri {
	if (kind == ENNowFromArtist)
		return [top isKindOfClass:[ENArtistViewController class]] && [((ENArtistViewController *)top).artistURI isEqualToString:uri];
	if (![top isKindOfClass:[ENTrackListViewController class]]) return NO;
	ENTrackListViewController *list = (ENTrackListViewController *)top;
	switch (kind) {
		case ENNowFromLiked: return list.kind == ENListLiked;
		case ENNowFromPlaylist: return list.kind == ENListPlaylist && [list.listURI isEqualToString:uri];
		case ENNowFromAlbum: return list.kind == ENListAlbum && [list.listURI isEqualToString:uri];
		default: return NO;
	}
}

@end

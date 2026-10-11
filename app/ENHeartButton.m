#import "ENHeartButton.h"
#import "ENTrackActions.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENModel.h"
#import "ENTheme.h"

// The ♥ (DESIGN-3 §6.4). The glyph is the mockup's heart (art.js HEART, a 24-unit box) at 20 pt: filled heartSaved
// (#3fae3a) when saved, else the heartO outline (1.8 units) in heartOnChrome (light grey, dark chrome) or the palette's
// heartOutline (on light content: mid grey, white .55 in Dark). 0.10 (Drop 3a, package A2): the images are ENTheme's glyphs
// (cached there per palette), so no colour lives here; an ENHeartOnLight heart redraws on ENThemeDidChangeNotification. The
// state always comes from -[ENCatalog savedStateForURI:] (keyed by the row's u, or the heard song's context_track_uri ?:
// uri), so a snapshot one song ahead never lights the wrong heart; ENCatalog's optimistic like posts kind liked at once,
// which redraws it.

static const CGFloat ENHeartSide = 20;

// saved, or the outline for this style, from the current palette (an image object per palette: compared by pointer)
static UIImage *ENHeartGlyph(BOOL saved, ENHeartStyle style) {
	ENTheme *th = [ENTheme current];
	if (saved || style == ENHeartOnLight) return [th heartImage:saved size:ENHeartSide];
	return [th glyphNamed:@"heartO" size:ENHeartSide color:th.heartOnChrome];
}

@implementation ENHeartButton {
	ENHeartStyle _style;
	NSString *_shownURI;         // the uri the heart shows now (nil = hidden)
	UIImage *_shownImage;        // nil before the first draw (and after a theme change)
}

- (instancetype)initWithFrame:(CGRect)frame style:(ENHeartStyle)style {
	if ((self = [super initWithFrame:frame])) {
		_style = style;
		self.adjustsImageWhenHighlighted = YES;
		self.showsTouchWhenHighlighted = style == ENHeartOnDark;
		self.exclusiveTouch = YES;
		self.hidden = YES;
		[self addTarget:self action:@selector(tapped) forControlEvents:UIControlEventTouchUpInside];
		[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(catalogChanged:) name:ENCatalogChangedNotification object:nil];
		// on content its outline follows the palette (on dark chrome it is the same in both themes)
		if (style == ENHeartOnLight) {
			[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(themeChanged:) name:ENThemeDidChangeNotification object:nil];
		}
		[self refresh];
	}
	return self;
}

- (instancetype)initWithFrame:(CGRect)frame {
	return [self initWithFrame:frame style:ENHeartOnDark];
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)setTrack:(ENTrack *)track {
	_track = track;
	if (!_followsPlayback) [self refresh];
}

- (void)setFollowsPlayback:(BOOL)follows {
	if (follows == _followsPlayback) return;
	_followsPlayback = follows;
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	if (follows) [nc addObserver:self selector:@selector(playbackChanged:) name:ENPlaybackChangedNotification object:nil];
	else [nc removeObserver:self name:ENPlaybackChangedNotification object:nil];
	[self refresh];
}

- (ENTrack *)currentTrack {
	return _followsPlayback ? [[ENPlayback shared] playingTrack] : _track;
}

// Only songs can be liked (the gateway answers 400 for anything but spotify:track:): no heart for an episode or local file.
- (void)refresh {
	NSString *uri = [self currentTrack].uri;
	BOOL usable = [uri hasPrefix:@"spotify:track:"];
	_shownURI = usable ? uri : nil;
	self.hidden = !usable;
	self.enabled = usable;
	if (!usable) return;
	BOOL saved = [[[ENCatalog shared] savedStateForURI:uri] boolValue];      // unknown = an outline
	UIImage *img = ENHeartGlyph(saved, _style);
	if (img == _shownImage) return;
	_shownImage = img;
	[self setImage:img forState:UIControlStateNormal];
}

- (void)themeChanged:(NSNotification *)n {
	_shownImage = nil;
	[self refresh];
}

// ENPlaybackChangedNotification comes often (position, state, artwork): redraw only when the heard song changed.
- (void)playbackChanged:(NSNotification *)n {
	NSString *uri = [[ENPlayback shared] playingTrack].uri;
	if (uri == _shownURI || [uri isEqualToString:_shownURI]) return;
	[self refresh];
}

- (void)catalogChanged:(NSNotification *)n {
	NSString *kind = n.userInfo[ENCatalogKindKey];
	if (![kind isEqualToString:ENCatalogKindLiked] && ![kind isEqualToString:ENCatalogKindReset]) return;
	NSArray *uris = n.userInfo[ENCatalogURIsKey];
	if (uris && _shownURI && ![uris containsObject:_shownURI]) return;
	[self refresh];
}

- (void)tapped {
	ENTrack *t = [self currentTrack];
	if (![t.uri hasPrefix:@"spotify:track:"]) return;
	[ENTrackActions toggleSaved:t];       // optimistic: kind liked arrives at once and redraws the glyph
	UIImageView *iv = self.imageView;
	[UIView animateWithDuration:0.1 delay:0 options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction
		animations:^{
			iv.transform = CGAffineTransformMakeScale(1.3, 1.3);
		} completion:^(BOOL finished) {
			[UIView animateWithDuration:0.12 delay:0 options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction
				animations:^{
					iv.transform = CGAffineTransformIdentity;
				} completion:nil];
		}];
}

@end

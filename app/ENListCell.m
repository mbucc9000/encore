#import "ENListCell.h"
#import "ENTheme.h"
#import "ENModel.h"
#import "ENAvatarView.h"
#import "ENJam.h"
#import "ENUtil.h"
#import "ENCompat.h"

// The one opaque view that draws the whole row (background image included, so nothing blends while scrolling).
@interface ENListCellCanvas : UIView
@property (nonatomic, weak) ENListCell *cell;
@end

@interface ENListCell ()
- (void)drawCanvas:(CGRect)b;
@end

@implementation ENListCellCanvas
- (void)drawRect:(CGRect)rect { [self.cell drawCanvas:self.bounds]; }
@end

@interface ENListCell () <UIGestureRecognizerDelegate>
@end

// Swipe right to queue: the row slides right over a green strip; past the threshold, letting go queues the song.
static const CGFloat ENSwipeQueueAt = 80;

// Row metrics (A3, DESIGN-5 §2.1 row feedback; see ENListCell.h). The heights come from ENTheme (text size).
static const CGFloat ENCellInset = 8;           // left edge -> the art / number column (0.9.5: 12)
static const CGFloat ENCellTextInset = 12;      // left edge -> the text of a row without art (in line with the headers' text)
static const CGFloat ENCellGap = 8;             // art -> text; text -> a right-hand glyph; between those glyphs (0.9.5: 10 / 12)
static const CGFloat ENCellRightInset = 8;      // the last right-hand glyph -> the right edge (0.9.5: 10)
static const CGFloat ENCellBox = 40;            // the cover / round box: a 1 pt frame round a 38 pt picture (0.9.5: 44 / 42)
static const CGFloat ENCellTallBox = 54;        // the same on a tall row (Top Result)
static const CGFloat ENCellMoreSlot = 31;       // the ••• disc (moreGlyphImage: 31 pt + its 1 pt drop); an override is centred in it
static const CGFloat ENCellMoreHit = 50;        // the ••• button: the row's right 50 pt (CELL4)
static const CGFloat ENCellAvatar = 22;         // Up Next's "added by"
static const CGFloat ENCellTagHeight = 13;      // (3b) Up Next's QUEUE / AUTOPLAY tag: 13 pt tall (mockup .q-src line-height) ...
static const CGFloat ENCellTagPad = 4;          // ... with 4 pt either side of the text, radius 3
static const CGFloat ENCellSpeakerGap = 6;      // the playing speaker -> the title

// The E badge's (and the source tag's) rounded box in the current fill colour (arcs by hand: no path object per row, P4)
static void ENFillRounded(CGContextRef c, CGRect r, CGFloat rad) {
	CGFloat x0 = CGRectGetMinX(r), y0 = CGRectGetMinY(r), x1 = CGRectGetMaxX(r), y1 = CGRectGetMaxY(r);
	CGContextMoveToPoint(c, x0 + rad, y0);
	CGContextAddArcToPoint(c, x1, y0, x1, y1, rad);
	CGContextAddArcToPoint(c, x1, y1, x0, y1, rad);
	CGContextAddArcToPoint(c, x0, y1, x0, y0, rad);
	CGContextAddArcToPoint(c, x0, y0, x1, y0, rad);
	CGContextClosePath(c);
	CGContextFillPath(c);
}

@implementation ENListCell {
	ENListCellCanvas *_canvas;
	UIImageView *_bg;
	UIButton *_moreButton;
	UIActivityIndicatorView *_spin;
	ENTheme *_theme;           // the palette in use: _fixedTheme, else +current when last read (prepareForReuse, -reloadTheme)
	ENTheme *_fixedTheme;      // `theme` as set (nil = follow +current)
	UIImage *_image;           // the art (both accessors are ours: UITableViewCell declares a deprecated -image)
	NSString *_token;          // the art's image token
	NSString *_pendingKey;     // the ENImageCache key of this cell's outstanding load: (nil = none); one cancel: balances it
	// 0.6 "added by" avatar (Up Next)
	NSString *_avToken, *_avName, *_avID;
	UIImage *_avImage;
	NSString *_avPendingKey;
	NSString *_iniName, *_iniKey;  // (R2a) the round art column's initials disc (-setInitialsName:key:)
	UIPanGestureRecognizer *_swipe;
	UIImageView *_under;       // the swipe strip: the selection gradient (A3)
	UIImageView *_underGlyph;
	UILabel *_underLabel;      // (the one UILabel: it only exists while a row is swiped)
	// (A3) an action row (-showAction:busy:)
	BOOL _isAction, _actionBusy;
	UIActivityIndicatorView *_actionSpin;
	CGFloat _bandH;            // (1.1, iOS 5) the row height the image views' bands were made for (-layoutSubviews)
}

+ (NSString *)reuseIdentifier { return @"ENListCell"; }

- (id)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)rid {
	if ((self = [super initWithStyle:UITableViewCellStyleDefault reuseIdentifier:rid])) {
		_theme = [ENTheme current];
		_bg = [[UIImageView alloc] initWithImage:_theme.cellBackground];
		self.backgroundView = _bg;
		self.selectedBackgroundView = [[UIImageView alloc] initWithImage:_theme.cellSelectedBackground];

		UIView *cv = self.contentView;
		_canvas = [[ENListCellCanvas alloc] initWithFrame:cv.bounds];
		_canvas.cell = self;
		_canvas.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
		_canvas.contentMode = UIViewContentModeRedraw;     // the swipe-to-delete button narrows the content view
		_canvas.opaque = YES;
		_canvas.clearsContextBeforeDrawing = NO;
		[cv addSubview:_canvas];

		// ••• hit area (44+ pt) over the drawn glyph: an empty custom button, so it costs no drawing or blending
		_moreButton = [UIButton buttonWithType:UIButtonTypeCustom];
		_moreButton.frame = CGRectMake(cv.bounds.size.width - ENCellMoreHit, 0, ENCellMoreHit, cv.bounds.size.height);
		_moreButton.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin | UIViewAutoresizingFlexibleHeight;
		_moreButton.hidden = YES;
		_moreButton.exclusiveTouch = YES;
		[_moreButton addTarget:self action:@selector(tapMore) forControlEvents:UIControlEventTouchUpInside];
		[cv addSubview:_moreButton];

		_swipe = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(swiped:)];
		_swipe.delegate = self;
		[self addGestureRecognizer:_swipe];
	}
	return self;
}

#pragma mark - swipe right to queue

// (A3, DESIGN-5 §2.4 #2) as the ••• sheet: while a Jam is on, only a role that can add can swipe
- (BOOL)swipeAllowed {
	ENTrack *t = [_item isKindOfClass:[ENTrack class]] ? _item : nil;
	if (!t.playable || _dimmed || self.editing || ![self.delegate respondsToSelector:@selector(listCellDidSwipeToQueue:)]) return NO;
	ENJam *jam = [ENJam shared];
	return !jam.active || [jam can:@"add"];
}

- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)g {
	if (g != _swipe) return YES;
	if (![self swipeAllowed]) return NO;
	CGPoint v = [_swipe velocityInView:self];
	return v.x > 0 && fabsf((float)v.x) > fabsf((float)v.y) * 1.5f;      // rightward and clearly horizontal: scrolling wins otherwise
}

- (void)makeUnder {
	if (_under) return;
	_under = [[UIImageView alloc] initWithFrame:self.bounds];
	_under.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
	_underGlyph = [[UIImageView alloc] initWithFrame:CGRectZero];
	[_under addSubview:_underGlyph];
	_underLabel = [[UILabel alloc] initWithFrame:CGRectZero];
	_underLabel.backgroundColor = [UIColor clearColor];
	_underLabel.shadowOffset = CGSizeMake(0, -1);
	[_under addSubview:_underLabel];
	[self skinUnder];
}

// the strip in the row's palette: the selection gradient, a white queue glyph and label with the selected title's shadow
- (void)skinUnder {
	ENTheme *th = _theme;
	_under.image = [th cellSelectedBackgroundOfHeight:self.bounds.size.height];     // (1.1: iOS 5 at the row's height)
	_underGlyph.image = [th glyphNamed:@"queue" size:20 color:th.cellSelectedTitle];
	[_underGlyph sizeToFit];
	_underLabel.font = th.swipeStripFont;
	_underLabel.textColor = th.cellSelectedTitle;
	_underLabel.shadowColor = th.cellSelectedTitleShadow;
}

- (void)layoutUnder:(CGFloat)x {
	CGFloat h = self.bounds.size.height;
	CGSize g = _underGlyph.image.size;
	_underGlyph.frame = CGRectMake(14, floorf((float)(h - g.height) / 2), g.width, g.height);
	CGRect l = _underLabel.frame;
	l.origin = CGPointMake(14 + g.width + 8, floorf((float)(h - l.size.height) / 2));
	_underLabel.frame = l;
	BOOL armed = x >= ENSwipeQueueAt;
	_underLabel.alpha = armed ? 1 : 0.55f;
	_underGlyph.alpha = armed ? 1 : 0.55f;
}

- (void)swiped:(UIPanGestureRecognizer *)g {
	UIView *cv = self.contentView;
	CGFloat t = MAX(0, [g translationInView:self].x);
	CGFloat x = t <= 110 ? t : 110 + (t - 110) * 0.3f;                 // rubber band past the strip
	if (g.state == UIGestureRecognizerStateBegan) {
		[self makeUnder];
		// (A3) the label comes from the screen: "Add to Queue", or "Add to Jam" while a Jam is on
		id<ENListCellDelegate> d = self.delegate;
		NSString *label = [d respondsToSelector:@selector(listCellSwipeTitle:)] ? [d listCellSwipeTitle:self] : nil;
		_underLabel.text = label.length ? label : @"Add to Queue";
		[_underLabel sizeToFit];
		_under.frame = self.bounds;
		_under.hidden = NO;
		[self insertSubview:_under belowSubview:cv];
	}
	if (g.state == UIGestureRecognizerStateBegan || g.state == UIGestureRecognizerStateChanged) {
		CGRect f = cv.frame;
		f.origin.x = x;
		cv.frame = f;
		[self layoutUnder:x];
		return;
	}
	BOOL fire = g.state == UIGestureRecognizerStateEnded && x >= ENSwipeQueueAt;
	[UIView animateWithDuration:0.2 delay:0 options:UIViewAnimationOptionCurveEaseOut animations:^{
		CGRect f = cv.frame;
		f.origin.x = 0;
		cv.frame = f;
	} completion:^(BOOL done) {
		self->_under.hidden = YES;
	}];
	if (fire) [self.delegate listCellDidSwipeToQueue:self];
}

- (void)dealloc {
	[self stopWaiting];
	[self stopAvatarWaiting];
}

- (void)layoutSubviews {
	[super layoutSubviews];
	// (4b-c) however UIKit set the editing state (a cell dequeued into an editing table), the ••• hit area follows it
	_moreButton.hidden = !(_showsMore && !_dimmed && !self.editing) || _moreBusy;
	CGRect b = self.contentView.bounds;
	if (_spin) _spin.center = CGPointMake(b.size.width - ENCellRightInset - floorf(ENCellMoreSlot / 2), floorf(b.size.height / 2));
	if (_actionSpin) _actionSpin.center = CGPointMake(floorf(b.size.width / 2), floorf(b.size.height / 2));
	// (1.1) iOS 5 tiles a resizable band's centre, so there the bands are made at the row's height: a row whose height
	// changed (a cell reused between Search's 60 pt Top Result and the Text size rows) takes the ones for its new height
	CGFloat rh = self.bounds.size.height;
	if (!ENSystemIs6() && rh != _bandH) {
		_bandH = rh;
		UIImageView *sel = [self.selectedBackgroundView isKindOfClass:[UIImageView class]] ? (UIImageView *)self.selectedBackgroundView : nil;
		sel.image = [_theme cellSelectedBackgroundOfHeight:rh];
		_bg.image = _playing ? [_theme cellPlayingBackgroundOfHeight:rh] : [_theme cellBackgroundOfHeight:rh];
		_under.image = [_theme cellSelectedBackgroundOfHeight:rh];
	}
}

- (void)prepareForReuse {
	[super prepareForReuse];
	if (self.contentView.frame.origin.x != 0) {             // reused mid-swipe
		CGRect f = self.contentView.frame;
		f.origin.x = 0;
		self.contentView.frame = f;
	}
	_under.hidden = YES;
	ENFadeInCancel(_canvas);                                // (3c) a cover fade still running belongs to the old row
	[self stopWaiting];
	_token = nil;
	[self resetFields];
	[self readTheme];                                       // (A3) a followed theme may have switched meanwhile
	[self applyState];
}

- (void)tapMore {
	if (_showsMore && !_dimmed && !_moreBusy) [self.delegate listCellDidTapMore:self];
}

#pragma mark - theme

// _theme from the setting (nil = +current) and the images that depend only on it; -applyState sets the background
- (void)readTheme {
	ENTheme *th = _fixedTheme ?: [ENTheme current];
	UIImageView *sel = [self.selectedBackgroundView isKindOfClass:[UIImageView class]] ? (UIImageView *)self.selectedBackgroundView : nil;
	UIImage *selImage = [th cellSelectedBackgroundOfHeight:self.bounds.size.height];     // (1.1: iOS 5 at the row's height)
	if (sel.image != selImage) sel.image = selImage;
	if (th == _theme) return;
	_theme = th;
	_spin.activityIndicatorViewStyle = th.spinnerStyle;
	_actionSpin.activityIndicatorViewStyle = th.spinnerStyle;
	if (_under) [self skinUnder];
}

- (ENTheme *)theme { return _theme; }

- (void)setTheme:(ENTheme *)theme {
	_fixedTheme = theme;
	[self readTheme];
	[self applyState];
}

- (void)reloadTheme {
	[self readTheme];
	[self applyState];
	[self setNeedsLayout];          // a text size change moves the spinners with the row height
}

#pragma mark - fields

- (void)resetFields {
	[self stopAvatarWaiting];
	_avToken = _avName = _avID = nil;
	_avImage = nil;
	_iniName = _iniKey = nil;
	_item = nil;
	_title = nil;
	_subtitle = nil;
	_art = ENCellArtNone;
	_number = 0;
	_image = nil;
	_placeholder = nil;
	_explicitBadge = NO;
	_pinned = NO;
	_showsMore = NO;
	_moreGlyphOverride = nil;
	_moreBusy = NO;
	_showsChevron = NO;
	_playing = NO;
	_dimmed = NO;
	_tall = NO;
	_titleColor = nil;
	_isAction = NO;
	_actionBusy = NO;
	_sourceTag = ENCellSourceNone;
	_showsDuration = NO;
}

// after the fields changed: the backgrounds, the ••• button / spinner, a redraw. While editing (Up Next, 4b-c) the ••• and
// its spinner are hidden: the delete control and the reorder control take the row's edges.
- (void)applyState {
	CGFloat rh = self.bounds.size.height;     // (1.1) iOS 5: the bands at the row's height (iOS 6: the theme's own)
	_bg.image = _playing ? [_theme cellPlayingBackgroundOfHeight:rh] : [_theme cellBackgroundOfHeight:rh];
	BOOL editing = self.editing;
	BOOL more = _showsMore && !_dimmed && !editing;
	_moreButton.hidden = !more || _moreBusy;
	if (_moreBusy && !editing) {
		if (!_spin) {
			_spin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:_theme.spinnerStyle];
			_spin.hidesWhenStopped = YES;
			_spin.userInteractionEnabled = NO;
			[self.contentView addSubview:_spin];
			[self setNeedsLayout];
		}
		[_spin startAnimating];
	} else [_spin stopAnimating];
	if (_isAction && _actionBusy) {
		if (!_actionSpin) {
			_actionSpin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:_theme.spinnerStyle];
			_actionSpin.hidesWhenStopped = YES;
			_actionSpin.userInteractionEnabled = NO;
			[self.contentView addSubview:_actionSpin];
			[self setNeedsLayout];
		}
		[_actionSpin startAnimating];
	} else [_actionSpin stopAnimating];
	[_canvas setNeedsDisplay];
}

- (UIImage *)image { return _image; }
- (void)setImage:(UIImage *)image { _image = image; [_canvas setNeedsDisplay]; }

- (void)setTitle:(NSString *)title { _title = [title copy]; [_canvas setNeedsDisplay]; }
- (void)setSubtitle:(NSString *)subtitle { _subtitle = [subtitle copy]; [_canvas setNeedsDisplay]; }
- (void)setNumber:(NSInteger)number { _number = number; [_canvas setNeedsDisplay]; }
- (void)setPlaceholder:(UIImage *)placeholder { _placeholder = placeholder; [_canvas setNeedsDisplay]; }
- (void)setExplicitBadge:(BOOL)explicitBadge { _explicitBadge = explicitBadge; [_canvas setNeedsDisplay]; }
- (void)setPinned:(BOOL)pinned { if (_pinned != pinned) { _pinned = pinned; [_canvas setNeedsDisplay]; } }
- (void)setShowsChevron:(BOOL)showsChevron { _showsChevron = showsChevron; [_canvas setNeedsDisplay]; }
- (void)setTitleColor:(UIColor *)titleColor { _titleColor = titleColor; [_canvas setNeedsDisplay]; }
- (void)setShowsMore:(BOOL)showsMore { _showsMore = showsMore; [self applyState]; }
- (void)setMoreGlyphOverride:(UIImage *)moreGlyphOverride { _moreGlyphOverride = moreGlyphOverride; [_canvas setNeedsDisplay]; }
- (void)setMoreBusy:(BOOL)moreBusy { if (_moreBusy != moreBusy) { _moreBusy = moreBusy; [self applyState]; } }
- (void)setPlaying:(BOOL)playing { if (_playing != playing) { _playing = playing; [self applyState]; } }
- (void)setDimmed:(BOOL)dimmed { _dimmed = dimmed; [self applyState]; }
- (void)setSourceTag:(ENCellSource)sourceTag { if (_sourceTag != sourceTag) { _sourceTag = sourceTag; [_canvas setNeedsDisplay]; } }
- (void)setShowsDuration:(BOOL)showsDuration { if (_showsDuration != showsDuration) { _showsDuration = showsDuration; [_canvas setNeedsDisplay]; } }

- (void)setArt:(ENCellArt)art {
	BOOL wasRound = _art == ENCellArtRound;
	_art = art;
	if (_token && wasRound != (art == ENCellArtRound)) [self setImageToken:_token];     // the round copy is another key
	[_canvas setNeedsDisplay];
}

- (void)setTall:(BOOL)tall {
	if (_tall == tall) return;
	_tall = tall;
	if (_token) [self setImageToken:_token];       // tall rows draw 54 pt art from the 216 tier
	[_canvas setNeedsDisplay];
}

- (void)setHighlighted:(BOOL)highlighted animated:(BOOL)animated {
	// (1.1, iOS 5) a row its screen says shouldn't highlight (iOS 6 asks the screen itself and never gets here for it)
	if (highlighted && !ENSystemIs6()) {
		id<ENListCellDelegate> d = self.delegate;
		if ([d respondsToSelector:@selector(listCellShouldHighlight:)] && ![d listCellShouldHighlight:self]) return;
	}
	[super setHighlighted:highlighted animated:animated];
	[_canvas setNeedsDisplay];
}

- (void)setSelected:(BOOL)selected animated:(BOOL)animated {
	[super setSelected:selected animated:animated];
	[_canvas setNeedsDisplay];
}

// (4b-c) Up Next's edit mode and swipe-to-remove: UIKit narrows the content view (the canvas follows it: the indent and the
// delete control on the left, the reorder control or the Remove button on the right); the ••• and the avatar go, in one
// redraw.
- (void)setEditing:(BOOL)editing animated:(BOOL)animated {
	BOOL was = self.editing;
	[super setEditing:editing animated:animated];
	if (was != editing) [self applyState];
}

#pragma mark - images

// ENImageCache counts load: calls and each cancel: takes one back, so consecutive Liked songs sharing one album cover
// (one key) don't cancel each other's request: the last cell to stop waiting drops it.
- (void)stopWaiting {
	if (!_pendingKey) return;
	[[ENImageCache shared] cancel:_pendingKey];
	_pendingKey = nil;
}

- (void)setImageToken:(NSString *)token {
	BOOL round = _art == ENCellArtRound;
	ENImgSize size = _tall ? ENImg216 : ENImg88;
	NSString *key = token ? [ENImageCache keyForToken:token size:size round:round] : nil;
	if (_pendingKey && ![_pendingKey isEqualToString:key]) [self stopWaiting];
	_token = [token copy];
	if (!token) { self.image = nil; return; }
	if (_pendingKey) return;                       // already waiting for exactly this
	ENImageCache *cache = [ENImageCache shared];
	UIImage *mem = [cache memoryImage:token size:size round:round];
	if (mem) { self.image = mem; return; }
	self.image = nil;                              // the placeholder until it comes
	__weak ENListCell *w = self;
	_pendingKey = [[cache load:token size:size round:round done:^(UIImage *img, NSString *k) {     // done is always async
		ENListCell *s = w;
		if (!s || !s->_pendingKey || ![s->_pendingKey isEqualToString:k]) return;
		s->_pendingKey = nil;                      // finished: nothing left to cancel
		if (!img) return;
		ENFadeIn(s->_canvas);                      // (3c, C1) it came from disk or the network: the row cross-fades to it, only
		s.image = img;                             // while on screen (a memory hit above shows at once, with no fade: P4)
	}] copy];
}

- (void)stopAvatarWaiting {
	if (!_avPendingKey) return;
	[[ENImageCache shared] cancel:_avPendingKey];
	_avPendingKey = nil;
}

- (void)setAvatarToken:(NSString *)token name:(NSString *)name memberID:(NSString *)memberID {
	if (!((token == _avToken) || [token isEqualToString:_avToken])) {
		[self stopAvatarWaiting];
		_avToken = [token copy];
		_avImage = token ? [[ENImageCache shared] memoryImage:token size:ENImg88 round:YES] : nil;
		if (token && !_avImage) {
			__weak ENListCell *w = self;
			_avPendingKey = [[[ENImageCache shared] load:token size:ENImg88 round:YES done:^(UIImage *img, NSString *k) {
				ENListCell *s = w;
				if (!s || ![s->_avPendingKey isEqualToString:k]) return;
				s->_avPendingKey = nil;
				if (img) { s->_avImage = img; [s->_canvas setNeedsDisplay]; }
			}] copy];
		}
	}
	_avName = [name copy];
	_avID = [memberID copy];
	[_canvas setNeedsDisplay];
}

- (void)setInitialsName:(NSString *)name key:(NSString *)key {
	_iniName = [name copy];
	_iniKey = [key copy];
	[_canvas setNeedsDisplay];
}

#pragma mark - rows

- (void)showTrack:(ENTrack *)t art:(ENCellArt)art playing:(BOOL)playing {
	[self resetFields];
	_item = t;
	_art = art;
	if (t.loading) { _title = @"Loading…"; _dimmed = YES; }
	else if (t.unavailable) { _title = @"Unavailable song"; _dimmed = YES; }
	else {
		_title = t.name ?: @"";
		_subtitle = t.subline;
		_explicitBadge = t.explicitSong;
	}
	_number = art == ENCellArtNumber ? t.trackNumber : 0;
	_showsMore = t.playable;
	_playing = playing && t.playable;
	[self applyState];
	[self setImageToken:(art == ENCellArtCover ? t.image : nil)];
}

- (void)showPlaylist:(ENPlaylist *)pl {
	[self resetFields];
	_item = pl;
	_art = ENCellArtCover;
	_title = pl.name ?: @"";
	_subtitle = pl.subline;
	_showsChevron = YES;
	[self applyState];
	[self setImageToken:pl.image];
}

- (void)showAlbum:(ENAlbumRow *)al subtitle:(NSString *)subtitle {
	[self resetFields];
	_item = al;
	_art = ENCellArtCover;
	_title = al.name ?: @"";
	_subtitle = [subtitle copy];
	_showsChevron = YES;
	[self applyState];
	[self setImageToken:al.image];
}

- (void)showArtist:(ENArtistRow *)ar subtitle:(NSString *)subtitle {
	[self resetFields];
	_item = ar;
	_art = ENCellArtRound;
	_title = ar.name ?: @"";
	_subtitle = subtitle ? [subtitle copy] : @"Artist";
	_showsChevron = YES;
	[self applyState];
	[self setImageToken:ar.image];
}

- (void)showTitle:(NSString *)title subtitle:(NSString *)subtitle image:(UIImage *)image chevron:(BOOL)chevron {
	[self resetFields];
	[self setImageToken:nil];
	_art = image ? ENCellArtCover : ENCellArtNone;
	_image = image;
	_title = [title copy];
	_subtitle = [subtitle copy];
	_showsChevron = chevron;
	[self applyState];
}

- (void)showAction:(NSString *)title busy:(BOOL)busy {
	[self resetFields];
	[self setImageToken:nil];
	_isAction = YES;
	_actionBusy = busy;
	_title = [title copy];
	[self applyState];
}

#pragma mark - drawing

- (void)drawCanvas:(CGRect)b {
	ENTheme *th = _theme;
	CGContextRef c = UIGraphicsGetCurrentContext();
	BOOL hi = self.highlighted || self.selected;
	CGFloat w = b.size.width, h = b.size.height;
	// (1.1) the band for this rect's height: iOS 6 stretches the theme's own; iOS 5 draws one made at h (no repeated centre)
	[(hi ? [th cellSelectedBackgroundOfHeight:h] : _playing ? [th cellPlayingBackgroundOfHeight:h] : [th cellBackgroundOfHeight:h]) drawInRect:b];
	// a selected row's white title has a black .25 line above it (mockup text-shadow 0 -1px)
	CGColorRef titleShadow = hi ? th.cellSelectedTitleShadow.CGColor : NULL;

	// (A3) an action row: only its centred title (or the spinner, a subview)
	if (_isAction) {
		if (_actionBusy || !_title.length) return;
		UIFont *af = th.actionRowFont;
		CGFloat ah = ceilf(af.lineHeight);
		CGContextSaveGState(c);
		if (titleShadow) CGContextSetShadowWithColor(c, CGSizeMake(0, -1), 0, titleShadow);
		[(hi ? th.cellSelectedTitle : (_titleColor ?: th.accent)) set];
		[_title drawInRect:CGRectMake(ENCellTextInset, floorf((h - ah) / 2), w - 2 * ENCellTextInset, ah) withFont:af
		     lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentCenter];
		CGContextRestoreGState(c);
		return;
	}

	// art column (the frame image carries the 1 pt ring and, in Light, the drop line under the box)
	CGFloat x = ENCellTextInset;
	if (_art == ENCellArtCover || _art == ENCellArtRound) {
		BOOL round = _art == ENCellArtRound;
		CGFloat box = _tall ? ENCellTallBox : ENCellBox;
		CGRect r = CGRectMake(ENCellInset, floorf((h - box) / 2), box, box);
		[[th thumbFrameImageOfSide:box round:round] drawAtPoint:r.origin];
		if (round && !_image && _iniName) {        // (R2a) a person without a picture: the initials disc
			[ENAvatarView drawAvatarInRect:CGRectInset(r, 1, 1) image:nil name:_iniName memberID:_iniKey];
		} else {
			UIImage *img = _image ?: (_placeholder ?: (round ? th.placeholderArtist : th.placeholderCover));
			[img drawInRect:CGRectInset(r, 1, 1)];
		}
		x = ENCellInset + box + ENCellGap;
	} else if (_art == ENCellArtNumber) {
		CGFloat col = th.numberColumnWidth;
		if (_number > 0) {
			UIFont *nf = th.numberFont;
			[(hi ? th.cellSelectedTitle : _dimmed ? th.cellDimmed : th.cellNumber) set];
			NSString *n = [NSString stringWithFormat:@"%ld", (long)_number];
			[n drawAtPoint:CGPointMake(ENCellInset, floorf((h - nf.lineHeight) / 2)) forWidth:col withFont:nf lineBreakMode:NSLineBreakByClipping];
		}
		x = ENCellInset + col;
	}

	// right-hand glyphs, right to left (editing: no •••, no avatar; the canvas is already the narrowed content view).
	// `right` ends as the text's right edge: ENCellGap clear of the nearest glyph, never under it.
	BOOL editing = self.editing;
	CGFloat right = w - ENCellRightInset;
	if (_showsChevron) {
		UIImage *ch = th.chevronImage;
		[ch drawAtPoint:CGPointMake(right - ch.size.width, floorf((h - ch.size.height) / 2))];
		right -= ch.size.width + ENCellGap;
	}
	if (((_showsMore && !_dimmed) || _moreBusy) && !editing) {
		if (!_moreBusy) {          // ••• (31 pt disc), or the screen's own glyph (0.9.5: the recent rows' ×) centred in its slot
			UIImage *mg = _moreGlyphOverride ?: th.moreGlyphImage;
			CGSize ms = mg.size;
			[mg drawAtPoint:CGPointMake(right - ENCellMoreSlot + floorf((ENCellMoreSlot - ms.width) / 2), floorf((h - ms.height) / 2))];
		}
		right -= ENCellMoreSlot + ENCellGap;
	}
	// (3b) Up Next: the song's length left of the •••, in the row's sub-line colours (mockup .q-row .c-dur)
	NSString *dur = _showsDuration && !editing && [_item isKindOfClass:[ENTrack class]] ? ((ENTrack *)_item).timeText : nil;
	if (dur.length) {
		UIFont *df = th.durationFont;
		CGFloat dw = ceilf([dur sizeWithFont:df].width);
		[(hi ? th.cellSelectedSub : _dimmed ? th.cellDimmed : th.cellDuration) set];
		[dur drawAtPoint:CGPointMake(right - dw, floorf((h - df.lineHeight) / 2)) forWidth:dw withFont:df lineBreakMode:NSLineBreakByClipping];
		right -= dw + ENCellGap;
	}
	if (_avName && !editing) {     // 0.6: who added it (Up Next in a Jam)
		[ENAvatarView drawAvatarInRect:CGRectMake(right - ENCellAvatar, floorf((h - ENCellAvatar) / 2), ENCellAvatar, ENCellAvatar)
		                         image:_avImage name:_avName memberID:_avID];
		right -= ENCellAvatar + ENCellGap;
	} else if (_sourceTag != ENCellSourceNone && !editing) {     // (3b) QUEUE / AUTOPLAY, set like the E badge
		BOOL queued = _sourceTag == ENCellSourceQueue;
		NSString *tag = queued ? @"QUEUE" : @"AUTOPLAY";
		UIFont *gf = th.sourceTagFont;
		CGFloat gw = ceilf([tag sizeWithFont:gf].width) + 2 * ENCellTagPad;
		CGRect gr = CGRectMake(right - gw, floorf((h - ENCellTagHeight) / 2), gw, ENCellTagHeight);
		[(_dimmed ? th.cellDimmed : queued ? th.sourceTagQueue : th.sourceTagAutoplay) setFill];
		ENFillRounded(c, gr, 3);
		[th.sourceTagText set];
		[tag drawInRect:CGRectMake(gr.origin.x, gr.origin.y + roundf((ENCellTagHeight - gf.lineHeight) / 2), gw, ENCellTagHeight)
		       withFont:gf lineBreakMode:NSLineBreakByClipping alignment:NSTextAlignmentCenter];
		right -= gw + ENCellGap;
	}

	// title over sub-line (the 0.9 pin glyph, then the E badge, lead the sub-line)
	UIColor *tc, *sc;
	if (hi) { tc = th.cellSelectedTitle; sc = th.cellSelectedSub; }
	else if (_dimmed) { tc = th.cellDimmed; sc = th.cellDimmed; }
	else { tc = _titleColor ?: (_playing ? th.cellPlaying : th.cellTitle); sc = th.cellSub; }
	UIFont *tf = th.titleFont, *sf = th.subFont;
	CGFloat tH = ceilf(tf.lineHeight), sH = ceilf(sf.lineHeight);
	BOOL badge = _explicitBadge && [ENTheme showsExplicitBadges];     // (3b) Settings → Explicit Badges
	BOOL hasSub = _subtitle.length > 0 || badge || _pinned;
	CGFloat ty = hasSub ? floorf((h - tH - sH) / 2) : floorf((h - tH) / 2);
	CGFloat tx = x;
	if (_playing) {                // (A3, §2.4 #1) the speaker leads the title (white on the selection)
		UIImage *sp = th.playingGlyph;
		if (hi) sp = [th glyphNamed:@"speakerHi" size:sp.size.width color:th.cellSelectedTitle];
		[sp drawAtPoint:CGPointMake(tx, ty + floorf((tH - sp.size.height) / 2))];
		tx += sp.size.width + ENCellSpeakerGap;
	}
	if (_title.length) {
		CGContextSaveGState(c);
		if (titleShadow) CGContextSetShadowWithColor(c, CGSizeMake(0, -1), 0, titleShadow);
		[tc set];
		[_title drawAtPoint:CGPointMake(tx, ty) forWidth:MAX(right - tx, 10) withFont:tf lineBreakMode:NSLineBreakByTruncatingTail];
		CGContextRestoreGState(c);
	}
	if (!hasSub) return;
	CGFloat sy = ty + tH, sx = x;
	UIFont *bf = th.badgeFont;
	CGFloat bh = roundf(bf.pointSize * 13 / 9);      // the E badge's box (and the pin): 12 / 13 / 14 pt with the text size
	if (_pinned) {                 // 0.9: a pinned playlist, set like the E badge (the pin has ~3 pt of air on its left:
		                           // shifted so it lines up with the title)
		UIImage *pin = [th glyphNamed:@"pin" size:bh color:(hi ? th.cellSelectedSub : _dimmed ? th.cellDimmed : th.accent)];
		[pin drawAtPoint:CGPointMake(sx - 3, sy + floorf((sH - bh) / 2) + 1)];
		sx += bh;
	}
	if (badge) {
		CGFloat bw = ceilf([@"E" sizeWithFont:bf].width) + 6;
		CGRect br = CGRectMake(sx, sy + floorf((sH - bh) / 2) + 1, bw, bh);
		[(hi ? th.cellSelectedSub : _dimmed ? th.cellDimmed : th.badgeBackground) setFill];
		ENFillRounded(c, br, 2);
		// on the selection (the same green in every palette) the E takes heartSaved, the palette-invariant #3fae3a
		[(hi ? th.heartSaved : th.badgeText) set];
		[@"E" drawInRect:CGRectMake(br.origin.x, br.origin.y + floorf((bh - bf.lineHeight) / 2), bw, bh) withFont:bf
		   lineBreakMode:NSLineBreakByClipping alignment:NSTextAlignmentCenter];
		sx += bw + 5;
	}
	if (_subtitle.length) {
		[sc set];
		[_subtitle drawAtPoint:CGPointMake(sx, sy) forWidth:MAX(right - sx, 10) withFont:sf lineBreakMode:NSLineBreakByTruncatingTail];
	}
}

@end

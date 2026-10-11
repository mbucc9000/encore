#import "ENShelfCell.h"
#import "ENModel.h"
#import "ENTheme.h"
#import "ENImageCache.h"
#import "ENUtil.h"
#import "ENAnon.h"

static const CGFloat ENCardW = 104, ENCardArt = 104, ENCardH = 150;     // 4 pt shadow room above the art, text under it
static const CGFloat ENCardPad = 4;                                     // shadow room left and right of the art
static const CGFloat ENShelfInset = 12, ENCardGap = 11;
// (3c) the mockup's Home paddings: .home-h 14 pt over a Bold 17 title (21 pt line) and 4 under it; .home-sub (13, a 16 pt
// line) 8 over the cards; under the cards' text (it ends 6 pt above ENCardH) the carousel's 12 pt and the separator's 6 pt
// margin, then the separator's two 1 pt lines
static const CGFloat ENShelfTitleTop = 14, ENShelfTitleH = 21, ENShelfSubH = 16;
static const CGFloat ENShelfTitleBlock = 38;            // 14 + the 20.4 pt line + 4 (the cards' 4 pt shadow room is the
                                                        // carousel's own 4 pt padding)
static const CGFloat ENShelfSubBlock = 24;              // 16 + the mockup's 8
static const CGFloat ENShelfSepGap = 12;                // ENCardH's spare 6 + 12 = the mockup's 18 under the text
static const CGFloat ENShelfSepH = 2;                   // homeSeparator over homeSeparatorHighlight

#pragma mark - card

// The card view is ENCardPad wider than the art on each side so the frame's shadow isn't clipped; the art sits at
// x = ENCardPad. Its picture is asked for only once the card is near the visible part of the shelf (-startLoad).
@interface ENShelfCard : UIControl
@property (nonatomic, strong) ENHomeTile *tile;
- (void)startLoad;
@end

@implementation ENShelfCard {
	UIImage *_image;
	NSString *_key;                 // the ENImageCache load this card waits for
	BOOL _asked;
}

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		self.opaque = NO;
		self.backgroundColor = [UIColor clearColor];
		self.contentMode = UIViewContentModeRedraw;
	}
	return self;
}

- (void)dealloc {
	if (_key) [[ENImageCache shared] cancel:_key];
}

- (void)setTile:(ENHomeTile *)tile {
	_tile = tile;
	_image = nil;
	_asked = NO;
	if (_key) { [[ENImageCache shared] cancel:_key]; _key = nil; }
	if (tile.image) _image = [[ENImageCache shared] memoryImage:tile.image size:ENImg216 round:tile.round];
	[self setNeedsDisplay];
}

// (3c) a memory copy that arrived since -setTile: (another card or screen loaded it) shows at once, without a fade; a
// picture from disk or the network cross-fades in while the card is on screen (C11)
- (void)startLoad {
	NSString *token = _tile.image;
	if (_asked || _image || !token) return;
	_asked = YES;
	ENImageCache *cache = [ENImageCache shared];
	UIImage *mem = [cache memoryImage:token size:ENImg216 round:_tile.round];
	if (mem) {
		_image = mem;
		[self setNeedsDisplay];
		return;
	}
	__weak ENShelfCard *w = self;
	_key = [cache load:token size:ENImg216 round:_tile.round done:^(UIImage *image, NSString *key) {
		ENShelfCard *s = w;
		if (!s || ![key isEqualToString:s->_key]) return;
		s->_key = nil;
		if (image && [s onScreen]) ENFadeIn(s);
		s->_image = image;
		[s setNeedsDisplay];
	}];
}

// within the shelf's visible part (loads also start for one card either side of it: those just draw)
- (BOOL)onScreen {
	UIView *sv = self.superview;
	return sv && CGRectIntersectsRect(self.frame, sv.bounds);
}

- (void)setHighlighted:(BOOL)highlighted {
	[super setHighlighted:highlighted];
	self.alpha = highlighted ? 0.7f : 1;           // (3c) the mockup's .tile:active
}

- (void)drawRect:(CGRect)rect {
	CGContextRef c = UIGraphicsGetCurrentContext();
	ENTheme *th = [ENTheme current];
	CGRect art = CGRectMake(ENCardPad, 4, ENCardArt, ENCardArt);
	BOOL round = _tile.round;
	UIImage *img = _image ?: (_tile.kind == ENHomeTileLiked ? th.likedTileLarge : nil);

	// the frame (a 2 pt ring for artists) with its soft shadow, then the picture inside it
	CGContextSaveGState(c);
	CGContextSetShadowWithColor(c, CGSizeMake(0, 2), th.tileMatShadowBlur, th.tileMatShadow.CGColor);
	[(round ? th.tileRing : th.coverMat) setFill];
	if (round) CGContextFillEllipseInRect(c, art);
	else CGContextFillRect(c, art);
	CGContextRestoreGState(c);
	CGRect in = CGRectInset(art, 2, 2);
	if (img) {
		CGContextSaveGState(c);
		if (round) { CGContextAddEllipseInRect(c, in); CGContextClip(c); }
		[img drawInRect:in];
		CGContextRestoreGState(c);
	} else {
		CGContextSaveGState(c);
		if (round) { CGContextAddEllipseInRect(c, in); CGContextClip(c); }
		[th.cardPlaceholderFill setFill];
		CGContextFillRect(c, in);
		CGContextRestoreGState(c);
		UIImage *g = [th glyphNamed:(round ? @"artist" : _tile.kind == ENHomeTileAlbum ? @"album" : @"note") size:44
		                      color:th.cardPlaceholderGlyph];
		[g drawAtPoint:CGPointMake(CGRectGetMidX(in) - 22, CGRectGetMidY(in) - 22)];
	}

	// the title and (square cards) the sub-line
	CGFloat y = CGRectGetMaxY(art) + 6;
	UIFont *tf = th.tileTitleFont, *sf = th.tileSubFont;
	[th.tileTitle setFill];
	NSString *title = _tile.title ?: @"";
	if (round) {
		[title drawInRect:CGRectMake(ENCardPad, y, ENCardW, 16) withFont:tf lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentCenter];
	} else {
		[title drawAtPoint:CGPointMake(ENCardPad, y) forWidth:ENCardW withFont:tf lineBreakMode:NSLineBreakByTruncatingTail];
		[th.tileSub setFill];
		[(_tile.subtitle ?: @"") drawAtPoint:CGPointMake(ENCardPad, y + 16) forWidth:ENCardW withFont:sf lineBreakMode:NSLineBreakByTruncatingTail];
	}
}

@end

#pragma mark - the shelf's scroll view

// A pan that starts on a card scrolls the shelf (and cancels the card's tap) even after the finger rested on it: the
// default refuses to cancel touches in a UIControl.
@interface ENShelfScroller : UIScrollView
@end

@implementation ENShelfScroller
- (BOOL)touchesShouldCancelInContentView:(UIView *)view { return YES; }
@end

#pragma mark - shelf

@interface ENShelfCell () <UIScrollViewDelegate>
@end

@implementation ENShelfCell {
	UILabel *_titleLabel, *_subLabel;
	ENShelfScroller *_scroller;
	NSMutableArray *_cards;
	UIView *_line, *_lineHi;        // (3c) the mockup's .home-sep: homeSeparator over a homeSeparatorHighlight line
	NSUInteger _anonGen;            // (R2a) the +[ENAnon generation] the cards were built under
}

+ (NSString *)reuseIdentifier { return @"ENShelfCell"; }

// where the cards start: under the title block (title, and its sub-title), else at the top
static CGFloat ENShelfCardsTop(BOOL title, BOOL subtitle) {
	return title ? ENShelfTitleBlock + (subtitle ? ENShelfSubBlock : 0) : 0;
}

+ (CGFloat)heightWithTitle:(BOOL)title subtitle:(BOOL)subtitle {
	return ENShelfCardsTop(title, subtitle) + ENCardH + ENShelfSepGap + ENShelfSepH;
}

- (id)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)rid {
	if ((self = [super initWithStyle:UITableViewCellStyleDefault reuseIdentifier:rid])) {
		ENTheme *th = [ENTheme current];
		UIColor *clear = [UIColor clearColor];
		self.selectionStyle = UITableViewCellSelectionStyleNone;
		self.opaque = NO;                       // (3c) Home's gradient shows through (see the header)
		self.backgroundColor = clear;
		self.contentView.backgroundColor = clear;
		self.contentView.opaque = NO;
		CGFloat w = self.contentView.bounds.size.width;

		_titleLabel = [[UILabel alloc] initWithFrame:CGRectMake(ENShelfInset, ENShelfTitleTop, w - 2 * ENShelfInset, ENShelfTitleH)];
		_titleLabel.font = th.shelfTitleFont;
		_titleLabel.textColor = th.homeTitle;
		_titleLabel.shadowColor = th.homeTitleShadow;
		_titleLabel.shadowOffset = CGSizeMake(0, 1);
		_titleLabel.backgroundColor = clear;
		_titleLabel.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		_titleLabel.hidden = YES;
		[self.contentView addSubview:_titleLabel];

		_subLabel = [[UILabel alloc] initWithFrame:CGRectMake(ENShelfInset, ENShelfTitleBlock, w - 2 * ENShelfInset, ENShelfSubH)];
		_subLabel.font = th.shelfSubFont;
		_subLabel.textColor = th.shelfSub;
		_subLabel.backgroundColor = clear;
		_subLabel.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		_subLabel.hidden = YES;
		[self.contentView addSubview:_subLabel];

		_scroller = [[ENShelfScroller alloc] initWithFrame:CGRectMake(0, 0, w, ENCardH)];
		_scroller.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		_scroller.showsHorizontalScrollIndicator = NO;
		_scroller.showsVerticalScrollIndicator = NO;
		_scroller.alwaysBounceHorizontal = YES;
		_scroller.scrollsToTop = NO;
		_scroller.backgroundColor = clear;
		_scroller.opaque = NO;
		_scroller.delegate = self;
		[self.contentView addSubview:_scroller];

		_line = [[UIView alloc] initWithFrame:CGRectZero];
		_line.backgroundColor = th.homeSeparator;
		_lineHi = [[UIView alloc] initWithFrame:CGRectZero];
		_lineHi.backgroundColor = th.homeSeparatorHighlight;
		for (UIView *v in @[ _line, _lineHi ]) {
			v.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleTopMargin;
			[self.contentView addSubview:v];
		}
		_cards = [NSMutableArray array];
	}
	return self;
}

- (void)dealloc {
	_scroller.delegate = nil;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGFloat w = self.contentView.bounds.size.width, h = self.contentView.bounds.size.height;
	CGFloat top = ENShelfCardsTop(!_titleLabel.hidden, !_subLabel.hidden);
	_scroller.frame = CGRectMake(0, top, w, ENCardH);
	_line.frame = CGRectMake(0, h - ENShelfSepH, w, 1);
	_lineHi.frame = CGRectMake(0, h - ENShelfSepH + 1, w, 1);
	[self loadVisible];
}

// (3c) nil or empty = no title block; the sub-title shows only under a title
- (void)setTitle:(NSString *)title {
	_title = [title copy];
	_titleLabel.text = title;
	_titleLabel.hidden = !title.length;
	_subLabel.hidden = _titleLabel.hidden || !_subtitle.length;
	[self setNeedsLayout];
}

- (void)setSubtitle:(NSString *)subtitle {
	_subtitle = [subtitle copy];
	_subLabel.text = subtitle;
	_subLabel.hidden = _titleLabel.hidden || !subtitle.length;
	[self setNeedsLayout];
}

// The same array again (the page's arrays are immutable, so -copy hands back the same instance): nothing changes, the
// shelf stays where it was scrolled to.
- (void)setTiles:(NSArray *)tiles {
	// (R2a) the same tiles after Anonymous Mode switched draw again: a playlist card's name, owner and cover follow the mode
	NSUInteger gen = [ENAnon generation];
	if ((tiles == _tiles || (tiles && _tiles && [tiles isEqualToArray:_tiles])) && gen == _anonGen) return;
	_anonGen = gen;
	_tiles = [tiles copy];
	for (ENShelfCard *card in _cards) [card removeFromSuperview];
	[_cards removeAllObjects];
	CGFloat x = ENShelfInset;
	for (ENHomeTile *t in _tiles) {
		ENShelfCard *card = [[ENShelfCard alloc] initWithFrame:CGRectMake(x - ENCardPad, 0, ENCardW + 2 * ENCardPad, ENCardH)];
		card.tile = t;
		[card addTarget:self action:@selector(cardTapped:) forControlEvents:UIControlEventTouchUpInside];
		[_scroller addSubview:card];
		[_cards addObject:card];
		x += ENCardW + ENCardGap;
	}
	_scroller.contentSize = CGSizeMake(x - ENCardGap + ENShelfInset, ENCardH);
	_scroller.contentOffset = CGPointZero;
	[self loadVisible];
}

- (CGFloat)scrollX { return _scroller.contentOffset.x; }

- (void)setScrollX:(CGFloat)x {
	CGFloat maxX = MAX(0, _scroller.contentSize.width - _scroller.bounds.size.width);
	_scroller.contentOffset = CGPointMake(MAX(0, MIN(x, maxX)), 0);
	[self loadVisible];
}

// Pictures for the cards on screen and one card either side; ENImageCache serves the newest request first, so asking
// for the visible ones only keeps the off-screen cards from going ahead of them.
- (void)loadVisible {
	CGRect near = CGRectInset(_scroller.bounds, -(ENCardW + ENCardGap), 0);
	for (ENShelfCard *card in _cards) if (CGRectIntersectsRect(card.frame, near)) [card startLoad];
}

- (void)scrollViewDidScroll:(UIScrollView *)scrollView { [self loadVisible]; }

- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView willDecelerate:(BOOL)decelerate {
	if (!decelerate && self.onScroll) self.onScroll(scrollView.contentOffset.x);
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView {
	if (self.onScroll) self.onScroll(scrollView.contentOffset.x);
}

- (void)cardTapped:(ENShelfCard *)card {
	if (self.onTap && card.tile) self.onTap(card.tile);
}

- (void)prepareForReuse {
	[super prepareForReuse];
	self.onTap = nil;
	self.onScroll = nil;
}

@end

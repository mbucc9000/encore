#import "ENArtistViewController.h"
#import "ENTheme.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENImageCache.h"
#import "ENTrackActions.h"
#import "ENTrackListViewController.h"
#import "ENAppDelegate.h"
#import "ENUtil.h"

static const CGFloat ENArtistHeaderHeight = 170;
static const CGFloat ENArtistNameBottom = 44;     // (3c) .ahdr .an: the name's box ends 44 pt above the header's bottom
static const CGFloat ENArtistButtonBottom = 9;    // (3c) .ahdr .ab: the button row 9 pt above it
static const CGFloat ENArtistButtonH = 34;        // (3c) the 34 pt green gbtn (C7)
static const CGFloat ENArtistSide = 12;           // .ahdr: 12 pt in from each side

#pragma mark - header

// 320 x 170: the 640-tier image aspect-filled into the view's own bitmap (no layer masking), a dark fade at the bottom,
// the name, and the Play Artist button (the only subview).
// (3c, DESIGN-5 §2.3 C2; the mockup's .ahdr) The name is artistNameFont (Bold 27) across the full width (12 pt in from each
// side), its box ending 44 pt above the bottom: one line, or two for a long name (it grows upwards; the second line truncated),
// in white with a soft shadow baked into the bitmap (artistNameShadow, (0,1), blur 3). Under it, 9 pt above the bottom, the
// button row: Play Artist, the 34 pt green gbtn with the .pi disc at its natural width (the mockup's ghost Follow is not
// built: following an artist needs the gateway, §2.5). The shade runs clear at 35 % of the height to artistShade (black .75)
// at the bottom. Every colour and font is an ENTheme token; the header is the same in both themes.
@interface ENArtistHeaderView : UIView
@property (nonatomic, copy) NSString *name;
@property (nonatomic, strong) UIImage *image;
@property (nonatomic, readonly) UIButton *playButton;
@end

@implementation ENArtistHeaderView

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		self.opaque = YES;
		self.contentMode = UIViewContentModeRedraw;
		CGFloat y = frame.size.height - ENArtistButtonBottom - ENArtistButtonH;
		_playButton = [UIButton buttonWithType:UIButtonTypeCustom];
		_playButton.frame = CGRectMake(ENArtistSide, y, 120, ENArtistButtonH);     // (the height first: C7 sizes by it)
		[ENTheme configureButton:_playButton style:ENButtonStyleGreen title:@"Play Artist" glyph:ENButtonGlyphPlayDisc];
		CGFloat pw = MIN(ceilf([_playButton sizeThatFits:CGSizeZero].width), frame.size.width - 2 * ENArtistSide);
		_playButton.frame = CGRectMake(ENArtistSide, y, pw, ENArtistButtonH);
		_playButton.autoresizingMask = UIViewAutoresizingFlexibleRightMargin | UIViewAutoresizingFlexibleTopMargin;
		[self addSubview:_playButton];
	}
	return self;
}

- (void)setName:(NSString *)name { _name = [name copy]; [self setNeedsDisplay]; }
- (void)setImage:(UIImage *)image { _image = image; [self setNeedsDisplay]; }

- (void)drawRect:(CGRect)rect {
	ENTheme *th = [ENTheme current];
	CGContextRef c = UIGraphicsGetCurrentContext();
	CGRect b = self.bounds;
	CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
	if (_image && _image.size.width > 0 && _image.size.height > 0) {
		// aspect fill, centred (a 640 source keeps its aspect)
		CGSize is = _image.size;
		CGFloat k = MAX(b.size.width / is.width, b.size.height / is.height);
		CGSize ds = CGSizeMake(ceilf(is.width * k), ceilf(is.height * k));
		CGContextSaveGState(c);
		CGContextClipToRect(c, b);
		[_image drawInRect:CGRectMake(floorf((b.size.width - ds.width) / 2), floorf((b.size.height - ds.height) / 2), ds.width, ds.height)];
		CGContextRestoreGState(c);
	} else {
		NSArray *cols = @[ (__bridge id)th.artistHeaderTop.CGColor, (__bridge id)th.artistHeaderBottom.CGColor ];
		CGGradientRef g = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)cols, NULL);
		CGContextDrawLinearGradient(c, g, CGPointZero, CGPointMake(0, b.size.height), 0);
		CGGradientRelease(g);
		UIImage *glyph = [th glyphNamed:@"artist" size:72 color:th.artistHeaderGlyph];
		[glyph drawAtPoint:CGPointMake(floorf((b.size.width - 72) / 2), 20)];
	}
	// (3c) the shade: clear at 35 % -> artistShade (black .75) at the bottom (.ahdr .shade)
	UIColor *shade = th.artistShade;
	NSArray *fade = @[ (__bridge id)[shade colorWithAlphaComponent:0].CGColor, (__bridge id)shade.CGColor ];
	CGGradientRef fg = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)fade, NULL);
	CGContextDrawLinearGradient(c, fg, CGPointMake(0, b.size.height * 0.35f), CGPointMake(0, b.size.height), 0);
	CGGradientRelease(fg);
	CGColorSpaceRelease(cs);

	if (_name.length) {
		// across the full width, the box's bottom 44 pt above the header's: 1 line, or 2 for a long name (measured whole, as the
		// list header's title: a 2.5-line box keeps the 2nd line and never a 3rd; the 2nd is truncated where it is drawn)
		UIFont *f = th.artistNameFont;
		CGFloat w = b.size.width - 2 * ENArtistSide, maxH = floorf(f.lineHeight * 2.5f);
		CGFloat h = MIN(maxH, ceilf([_name sizeWithFont:f constrainedToSize:CGSizeMake(w, maxH) lineBreakMode:NSLineBreakByWordWrapping].height));
		CGRect r = CGRectMake(ENArtistSide, b.size.height - ENArtistNameBottom - h, w, h);
		CGContextSetShadowWithColor(c, CGSizeMake(0, 1), 3, th.artistNameShadow.CGColor);
		[th.navTitle set];                         // white (the chrome's white text)
		[_name drawInRect:r withFont:f lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentLeft];
	}
}

@end

#pragma mark - the screen

typedef enum { ENArtistSecPopular, ENArtistSecAlbums, ENArtistSecSingles } ENArtistSec;

@implementation ENArtistViewController {
	NSString *_name;
	NSString *_token;               // the artist image token shown / loading (640 tier)
	ENArtistPage *_page;
	NSArray *_sections;             // @[ @[kind, title, rows] ... ], empty ones left out
	ENArtistHeaderView *_header;
}

- (instancetype)initWithArtist:(ENArtistRow *)artist {
	if ((self = [self initWithArtistURI:artist.uri name:artist.name])) _token = [artist.image copy];
	return self;
}

- (instancetype)initWithArtistURI:(NSString *)uri name:(NSString *)name {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		_artistURI = [uri copy];
		_name = [name copy];
		_sections = @[];
		self.title = name;
		self.meterName = @"artist";            // (R2a: the scroll meter's log line names no artist)
	}
	return self;
}

- (void)viewDidLoad {
	[super viewDidLoad];
	_header = [[ENArtistHeaderView alloc] initWithFrame:CGRectMake(0, 0, self.tableView.bounds.size.width, ENArtistHeaderHeight)];
	[_header.playButton addTarget:self action:@selector(playArtist) forControlEvents:UIControlEventTouchUpInside];
	_header.name = _name;
	self.tableView.tableHeaderView = _header;
	[self showImage:_token];
	[self reload:NO];
}

- (void)reload:(BOOL)fresh {
	if (!_page) [self setBusy:YES];
	__weak ENArtistViewController *w = self;
	[[ENCatalog shared] loadArtist:_artistURI fresh:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENArtistViewController *s = w;
		if (!s) return;
		if (error) {
			[s finishRefreshing];
			[s setBusy:NO];
			[s showError:error];
			if (!s->_page) [s setEmptyTitle:@"Couldn't load this artist." message:@"Pull to refresh."];     // (3c: title / body)
			return;
		}
		if (!fromCache) [s finishRefreshing];
		if ([result isKindOfClass:[ENArtistPage class]] && result != s->_page) [s applyPage:result];
	}];
}

- (void)applyPage:(ENArtistPage *)page {
	_page = page;
	[self setBusy:NO];
	[self setEmptyTitle:nil message:nil];
	NSMutableArray *secs = [NSMutableArray array];
	if (page.popular.count) [secs addObject:@[ @(ENArtistSecPopular), @"Popular", page.popular ]];
	if (page.albums.count) [secs addObject:@[ @(ENArtistSecAlbums), @"Albums", page.albums ]];
	if (page.singles.count) [secs addObject:@[ @(ENArtistSecSingles), @"Singles & EPs", page.singles ]];
	_sections = secs;
	if (!secs.count) [self setEmptyTitle:@"Nothing here yet" message:nil];
	NSString *name = page.artist.name;
	if (name.length) {
		_name = [name copy];
		self.title = name;
		_header.name = name;
	}
	if (page.artist.image) [self showImage:page.artist.image];
	if (page.stale) [self showBanner:@"Showing a saved copy"];
	else [self hideBannerIfShowing:@"Showing a saved copy"];     // a later good answer clears it (an error banner stays)
	[self.tableView reloadData];
}

- (void)showImage:(NSString *)token {
	if (!token || ([token isEqualToString:_token] && _header.image)) return;
	_token = [token copy];
	ENImageCache *cache = [ENImageCache shared];
	UIImage *mem = [cache memoryImage:token size:ENImg640 round:NO];
	if (mem) { _header.image = mem; return; }
	__weak ENArtistViewController *w = self;
	[cache load:token size:ENImg640 round:NO done:^(UIImage *image, NSString *key) {
		ENArtistViewController *s = w;
		if (!s || !image || ![token isEqualToString:s->_token]) return;
		ENFadeIn(s->_header);                      // (3c, C11) the 640-tier picture from disk or the network fades in (a memory
		s->_header.image = image;                  // hit above shows at once); the name and the button stay as they are
	}];
}

- (void)playArtist {
	if (_artistURI) [[ENPlayback shared] playContext:_artistURI offsetURI:nil];
}

- (void)dropModels {
	_page = nil;
	_sections = @[];
	if (self.isViewLoaded) [self.tableView reloadData];
}

#pragma mark - table

- (ENArtistSec)kindOfSection:(NSInteger)section { return (ENArtistSec)[_sections[(NSUInteger)section][0] intValue]; }
- (NSArray *)rowsOfSection:(NSInteger)section { return _sections[(NSUInteger)section][2]; }

- (id)itemAt:(NSIndexPath *)ip {
	if ((NSUInteger)ip.section >= _sections.count) return nil;
	NSArray *rows = [self rowsOfSection:ip.section];
	return (NSUInteger)ip.row < rows.count ? rows[(NSUInteger)ip.row] : nil;
}

- (ENTrack *)trackAtIndexPath:(NSIndexPath *)ip {
	id item = [self itemAt:ip];
	return [item isKindOfClass:[ENTrack class]] ? item : nil;
}

- (NSUInteger)menuOptionsForTrack:(ENTrack *)track {
	return [track.artistURI isEqualToString:_artistURI] ? ENTrackMenuNoArtist : ENTrackMenuDefault;
}

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return (NSInteger)_sections.count; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return (NSInteger)[self rowsOfSection:section].count;
}

- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	return [self sectionHeaderWithTitle:_sections[(NSUInteger)section][1]];
}

- (CGFloat)tableView:(UITableView *)tableView heightForHeaderInSection:(NSInteger)section { return 22; }

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	id item = [self itemAt:ip];
	if ([item isKindOfClass:[ENTrack class]]) {
		ENTrack *t = item;
		[cell showTrack:t art:ENCellArtCover playing:[[ENPlayback shared] isPlayingRow:t]];
		if (t.playable) cell.subtitle = t.album ?: @"";        // Popular: the album under the title
	} else if ([item isKindOfClass:[ENAlbumRow class]]) {
		ENAlbumRow *al = item;
		[cell showAlbum:al subtitle:al.yearText];
	}
	return cell;
}

- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	id item = [self itemAt:ip];
	return [item isKindOfClass:[ENTrack class]] ? ((ENTrack *)item).playable : item != nil;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	id item = [self itemAt:ip];
	if ([item isKindOfClass:[ENTrack class]]) {
		ENTrack *t = item;
		if (t.playable) [[ENPlayback shared] playURI:t.uri];
	} else if ([item isKindOfClass:[ENAlbumRow class]]) {
		[self.navigationController pushViewController:[[ENTrackListViewController alloc] initWithAlbum:item] animated:YES];
	}
}

@end

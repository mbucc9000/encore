#import "ENHomeViewController.h"
#import "ENShelfCell.h"
#import "ENProfileViewController.h"
#import "ENTrackListViewController.h"
#import "ENArtistViewController.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENModel.h"
#import "ENTheme.h"
#import "ENImageCache.h"
#import "ENDiag.h"
#import "ENUtil.h"
#import "ENAnon.h"

typedef enum { ENHomeSecJump = 0, ENHomeSecMade, ENHomeSecArtists, ENHomeSecReleases, ENHomeSecTop } ENHomeSec;

static NSString *const ENSavedCopyText = @"Showing a saved copy";

// (3c) the greeting header (mockup .home-h 21 pt: 14 pt over a 25.2 pt line, 4 under it; then .home-sub 13 pt, a 16 pt line
// and 8 under it, where the Jump back in cards start): 44 pt without the sub-line (as 0.7), 67 with it
static const CGFloat ENHomeGreetingTop = 14, ENHomeGreetingH = 26;
static const CGFloat ENHomeSubTop = 43, ENHomeSubH = 16;
static const CGFloat ENHomeHeadH = 44, ENHomeHeadSubH = 67;

#pragma mark - the profile button

@interface ENProfileButton : UIButton
@property (nonatomic, copy) NSString *token;
@property (nonatomic, copy) void (^onTap)(void);
@end

@implementation ENProfileButton {
	NSString *_key;
}

// (3c) the §1.3 profile button tokens: profileButtonFill / profileButtonGlyph without a picture, the profileButtonRing
+ (UIImage *)faceWithImage:(UIImage *)img {
	ENTheme *th = [ENTheme current];
	return [ENTheme imageOfSize:CGSizeMake(30, 30) opaque:NO drawing:^(CGContextRef c, CGSize s) {
		CGRect r = CGRectMake(1, 1, 28, 28);
		if (img) {
			CGContextSaveGState(c);
			CGContextAddEllipseInRect(c, r);
			CGContextClip(c);
			[img drawInRect:r];
			CGContextRestoreGState(c);
		} else {
			[th.profileButtonFill setFill];
			CGContextFillEllipseInRect(c, r);
			[[th glyphNamed:@"artist" size:18 color:th.profileButtonGlyph] drawAtPoint:CGPointMake(6, 5)];
		}
		[th.profileButtonRing setStroke];
		CGContextSetLineWidth(c, 1.5f);
		CGContextStrokeEllipseInRect(c, r);
	}];
}

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		[self setImage:[ENProfileButton faceWithImage:nil] forState:UIControlStateNormal];
		self.showsTouchWhenHighlighted = YES;
		[self addTarget:self action:@selector(tapped) forControlEvents:UIControlEventTouchUpInside];
		// (R2a) Anonymous Mode switched: the catalog's token is nil while it is on (the no-picture face), the picture after
		[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(anonChanged) name:ENAnonChangedNotification object:nil];
	}
	return self;
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)anonChanged {
	self.token = [ENCatalog shared].meImageToken;
}

- (void)tapped { if (self.onTap) self.onTap(); }

- (void)setToken:(NSString *)token {
	if ((token == _token || [token isEqualToString:_token]) && token) return;
	_token = [token copy];
	if (!token) { [self setImage:[ENProfileButton faceWithImage:nil] forState:UIControlStateNormal]; return; }
	ENImageCache *cache = [ENImageCache shared];
	UIImage *mem = [cache memoryImage:token size:ENImg88 round:YES];
	if (mem) { [self setImage:[ENProfileButton faceWithImage:mem] forState:UIControlStateNormal]; return; }
	__weak ENProfileButton *w = self;
	_key = [cache load:token size:ENImg88 round:YES done:^(UIImage *image, NSString *key) {
		ENProfileButton *s = w;
		if (!s || !image || ![token isEqualToString:s->_token]) return;
		ENFadeIn(s);                // (3c, C11) from disk or the network: the picture cross-fades in (only while on screen)
		[s setImage:[ENProfileButton faceWithImage:image] forState:UIControlStateNormal];
	}];
}

@end

#pragma mark - Home

@implementation ENHomeViewController {
	ENHomePage *_page;
	NSArray *_secs;                 // NSNumber (ENHomeSec), the non-empty ones in order
	UIBarButtonItem *_profileItem;
	UIView *_head;                  // (3c) the greeting header: clear, over the homeBackground gradient
	UILabel *_greeting;
	UILabel *_greetingSub;          // (3c) "Jump back in" while there is that shelf (it then has no title of its own)
	BOOL _launched;
	NSDate *_loadedAt;              // the last answer (cache or network)
	NSMutableDictionary *_scrollX;  // @(ENHomeSec) -> @(x): where each shelf was scrolled to (kept across reloads)
}

// What a shelf shows, as one string (its items' uris in order): equal keys = the same shelf, it keeps its scroll offset.
static NSString *ENShelfKey(NSArray *tiles) {
	NSMutableArray *parts = [NSMutableArray arrayWithCapacity:tiles.count];
	for (ENHomeTile *t in tiles) {
		id item = t.item;
		NSString *u = [item respondsToSelector:@selector(uri)] ? [item uri] : nil;
		[parts addObject:u ?: @"liked"];
	}
	return [parts componentsJoinedByString:@" "];
}

+ (UIBarButtonItem *)profileButtonFor:(UIViewController *)vc {
	ENProfileButton *b = [[ENProfileButton alloc] initWithFrame:CGRectMake(0, 0, 30, 30)];
	__weak UIViewController *w = vc;
	b.onTap = ^{
		UIViewController *s = w;
		if ([s.navigationController.topViewController isKindOfClass:[ENProfileViewController class]]) return;
		[s.navigationController pushViewController:[[ENProfileViewController alloc] init] animated:YES];
	};
	b.token = [ENCatalog shared].meImageToken;
	return [[UIBarButtonItem alloc] initWithCustomView:b];
}

+ (void)refreshProfileButton:(UIBarButtonItem *)item {
	if ([item.customView isKindOfClass:[ENProfileButton class]]) ((ENProfileButton *)item.customView).token = [ENCatalog shared].meImageToken;
}

- (id)initWithStyle:(UITableViewStyle)style {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		self.title = @"Home";
		self.meterName = @"home";
		_secs = @[];
		_scrollX = [NSMutableDictionary dictionary];
	}
	return self;
}

// (3c) the homeBackground gradient behind everything (the base set listBackground); the header, the shelves, the empty state
// and the footer are clear over it
- (void)viewDidLoad {
	[super viewDidLoad];
	ENTheme *th = [ENTheme current];
	UITableView *tv = self.tableView;
	ENRegisterCellClass(tv, [ENShelfCell class], [ENShelfCell reuseIdentifier]);       // (1.1: iOS 5 too, ENCompat)
	tv.backgroundView = [[UIImageView alloc] initWithImage:th.homeBackground];
	UIColor *clear = [UIColor clearColor];
	CGFloat w = tv.bounds.size.width;
	_head = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, ENHomeHeadH)];
	_head.backgroundColor = clear;
	_head.opaque = NO;
	_greeting = [[UILabel alloc] initWithFrame:CGRectMake(12, ENHomeGreetingTop, w - 24, ENHomeGreetingH)];
	_greeting.font = th.greetingFont;
	_greeting.textColor = th.homeTitle;
	_greeting.shadowColor = th.homeTitleShadow;
	_greeting.shadowOffset = CGSizeMake(0, 1);
	_greetingSub = [[UILabel alloc] initWithFrame:CGRectMake(12, ENHomeSubTop, w - 24, ENHomeSubH)];
	_greetingSub.font = th.shelfSubFont;
	_greetingSub.textColor = th.shelfSub;
	_greetingSub.text = @"Jump back in";
	_greetingSub.hidden = YES;
	for (UILabel *l in @[ _greeting, _greetingSub ]) {
		l.backgroundColor = clear;
		l.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		[_head addSubview:l];
	}
	tv.tableHeaderView = _head;
	_profileItem = [ENHomeViewController profileButtonFor:self];
	self.navigationItem.leftBarButtonItem = _profileItem;
	[[ENCatalog shared] cachedLibrarySync];          // the greeting's name before Home itself has answered
	[self updateGreeting];
	[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(homeActive:)
	                                             name:UIApplicationDidBecomeActiveNotification object:nil];
	// (R2a) Anonymous Mode switched: the greeting drops (or gets back) the name; the shelves redraw with the lists
	[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(updateGreeting)
	                                             name:ENAnonChangedNotification object:nil];
}

// Back from the background on Home: the greeting follows the clock, and an old page is checked again.
- (void)homeActive:(NSNotification *)n {
	if (!self.visible) return;
	[self updateGreeting];
	if (_launched && (!_loadedAt || -[_loadedAt timeIntervalSinceNow] > 120)) [self reload:NO];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	[ENHomeViewController refreshProfileButton:_profileItem];
	[self updateGreeting];
	if (_launched && (!_loadedAt || -[_loadedAt timeIntervalSinceNow] > 120)) [self reload:NO];
}

- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	if (!_launched) {               // the first frame is up: only now the network (DESIGN-3 §5.7)
		_launched = YES;
		[ENDiag launchFinished];
		[self reload:NO];
		[[ENCatalog shared] loadLibrary:NO done:nil];    // Playlists, Library and the Add-to picker share it
	}
}

- (void)updateGreeting {
	NSInteger hr = [[[NSCalendar currentCalendar] components:NSHourCalendarUnit fromDate:[NSDate date]] hour];
	NSString *hello = hr < 5 ? @"Good night" : hr < 12 ? @"Good morning" : hr < 18 ? @"Good afternoon" : @"Good evening";
	// (R2a) both are nil while Anonymous Mode is on: the greeting without a name
	NSString *name = _page.meName ?: [ENCatalog shared].library.meName;
	NSArray *words = [name componentsSeparatedByString:@" "];
	NSString *first = words.count ? words[0] : nil;
	_greeting.text = first.length ? [NSString stringWithFormat:@"%@, %@", hello, first] : hello;
}

// (3c) "Jump back in" under the greeting while the page has that shelf (it leads the page); the header 67 pt then, else 44
- (void)updateHeader {
	if (!_head) return;
	BOOL jump = _page.jump.count > 0;
	_greetingSub.hidden = !jump;
	CGFloat h = jump ? ENHomeHeadSubH : ENHomeHeadH;
	if (_head.bounds.size.height != h) {
		_head.frame = CGRectMake(0, 0, self.tableView.bounds.size.width, h);
		self.tableView.tableHeaderView = _head;          // re-set so the table takes the new height
	}
}

// (3c, C1) the base's empty state and footer sit on the gradient, not in a listBackground box
- (UIColor *)listOverlayColor {
	return [UIColor clearColor];
}

#pragma mark - data

- (void)reload:(BOOL)fresh {
	if (!_page) {
		[self setEmptyTitle:nil message:nil];    // (a failed first load put it there; the spinner replaces it)
		[self setBusy:YES];
	}
	__weak ENHomeViewController *w = self;
	[[ENCatalog shared] loadHome:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENHomeViewController *s = w;
		if (!s) return;
		if (error) {
			[s finishRefreshing];
			[s setBusy:NO];
			[s showError:error];
			if (!s->_page) [s setEmptyTitle:@"Home fills up once your Encore Bridge answers." message:@"Pull to refresh."];
			return;
		}
		s->_loadedAt = [NSDate date];
		if (!fromCache) [s finishRefreshing];
		if ([result isKindOfClass:[ENHomePage class]] && result != s->_page) [s applyPage:result];
	}];
}

- (void)applyPage:(ENHomePage *)page {
	// a shelf whose items changed starts at its first card again; the others stay where they were scrolled to
	ENHomePage *old = _page;
	if (![ENShelfKey(old.jump) isEqualToString:ENShelfKey(page.jump)]) [_scrollX removeObjectForKey:@(ENHomeSecJump)];
	if (![ENShelfKey(old.made) isEqualToString:ENShelfKey(page.made)]) [_scrollX removeObjectForKey:@(ENHomeSecMade)];
	if (![ENShelfKey(old.artists) isEqualToString:ENShelfKey(page.artists)]) [_scrollX removeObjectForKey:@(ENHomeSecArtists)];
	if (![ENShelfKey(old.releases) isEqualToString:ENShelfKey(page.releases)]) [_scrollX removeObjectForKey:@(ENHomeSecReleases)];
	_page = page;
	[self setBusy:NO];
	NSMutableArray *secs = [NSMutableArray array];
	if (page.jump.count) [secs addObject:@(ENHomeSecJump)];
	if (page.made.count) [secs addObject:@(ENHomeSecMade)];
	if (page.artists.count) [secs addObject:@(ENHomeSecArtists)];
	if (page.releases.count) [secs addObject:@(ENHomeSecReleases)];
	if (page.top.count) [secs addObject:@(ENHomeSecTop)];
	_secs = secs;
	[self updateHeader];            // (3c) first: the empty state is placed under the header
	if (secs.count) [self setEmptyTitle:nil message:nil];
	else [self setEmptyTitle:@"Play some music" message:@"Home fills up with what you listen to."];
	if (page.stale) [self showBanner:ENSavedCopyText];
	else [self hideBannerIfShowing:ENSavedCopyText];
	[self updateGreeting];
	[ENHomeViewController refreshProfileButton:_profileItem];
	[self.tableView reloadData];
}

- (void)dropModels {
	_page = nil;
	_secs = @[];
	[_scrollX removeAllObjects];
	[self updateHeader];
	if (self.isViewLoaded) [self.tableView reloadData];
}

- (void)openTile:(ENHomeTile *)t {
	UIViewController *vc = nil;
	switch (t.kind) {
		case ENHomeTilePlaylist: vc = [[ENTrackListViewController alloc] initWithPlaylist:t.item]; break;
		case ENHomeTileAlbum: vc = [[ENTrackListViewController alloc] initWithAlbum:t.item]; break;
		case ENHomeTileArtist: vc = [[ENArtistViewController alloc] initWithArtist:t.item]; break;
		case ENHomeTileLiked: vc = [[ENTrackListViewController alloc] initWithLikedLibrary:[ENCatalog shared].library]; break;
	}
	if (vc) [self.navigationController pushViewController:vc animated:YES];
}

#pragma mark - table

- (ENHomeSec)secAt:(NSInteger)section { return (ENHomeSec)[_secs[(NSUInteger)section] intValue]; }

- (ENTrack *)trackAtIndexPath:(NSIndexPath *)ip {
	if ((NSUInteger)ip.section >= _secs.count || [self secAt:ip.section] != ENHomeSecTop) return nil;
	return (NSUInteger)ip.row < _page.top.count ? _page.top[(NSUInteger)ip.row] : nil;
}

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return (NSInteger)_secs.count; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return [self secAt:section] == ENHomeSecTop ? (NSInteger)_page.top.count : 1;
}

- (CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)ip {
	ENHomeSec k = [self secAt:ip.section];
	if (k == ENHomeSecTop) return tableView.rowHeight;     // (0.10, Drop 3a) the Text size row height: 44 / 48 / 54
	// (3c) Jump back in has no title (the greeting's sub-line names it)
	return [ENShelfCell heightWithTitle:(k != ENHomeSecJump) subtitle:(k == ENHomeSecArtists || k == ENHomeSecReleases)];
}

- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	return [self secAt:section] == ENHomeSecTop ? [self sectionHeaderWithTitle:@"Your Top Tracks · last 4 weeks"] : nil;
}

- (CGFloat)tableView:(UITableView *)tableView heightForHeaderInSection:(NSInteger)section {
	return [self secAt:section] == ENHomeSecTop ? 22 : 0;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENHomeSec k = [self secAt:ip.section];
	if (k == ENHomeSecTop) {
		ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
		cell.delegate = self;
		ENTrack *t = [self trackAtIndexPath:ip];
		[cell showTrack:t art:ENCellArtCover playing:[[ENPlayback shared] isPlayingRow:t]];
		return cell;
	}
	ENShelfCell *cell = ENDequeueCell(tableView, [ENShelfCell reuseIdentifier], ip);
	switch (k) {
		case ENHomeSecJump: cell.title = nil; cell.subtitle = nil; cell.tiles = _page.jump; break;     // (3c) see the header
		case ENHomeSecMade: cell.title = @"Made For You"; cell.subtitle = nil; cell.tiles = _page.made; break;
		case ENHomeSecArtists: cell.title = @"Your top artists"; cell.subtitle = @"Last 4 weeks"; cell.tiles = _page.artists; break;
		case ENHomeSecReleases: cell.title = @"New releases for you"; cell.subtitle = @"From the artists you play most"; cell.tiles = _page.releases; break;
		case ENHomeSecTop: break;
	}
	cell.scrollX = [_scrollX[@(k)] floatValue];
	__weak ENHomeViewController *w = self;
	cell.onTap = ^(ENHomeTile *t) { [w openTile:t]; };
	cell.onScroll = ^(CGFloat x) {
		ENHomeViewController *s = w;
		if (s) s->_scrollX[@(k)] = @(x);
	};
	return cell;
}

// (3c) iOS 6 gives a plain table's cells a background colour of its own as they show: the shelves stay clear over the gradient
- (void)tableView:(UITableView *)tableView willDisplayCell:(UITableViewCell *)cell forRowAtIndexPath:(NSIndexPath *)ip {
	if ([cell isKindOfClass:[ENShelfCell class]]) cell.backgroundColor = [UIColor clearColor];
}

- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	return [self trackAtIndexPath:ip].playable;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	ENTrack *t = [self trackAtIndexPath:ip];
	if (t.playable) [[ENPlayback shared] playURI:t.uri];
}

@end

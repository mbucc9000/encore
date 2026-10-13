#import "ENPlaylistsViewController.h"
#import "ENTheme.h"
#import "ENModel.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENTrackListViewController.h"
#import "ENTrackActions.h"
#import "ENDiag.h"
#import "ENUtil.h"
#import "ENPins.h"
#import "ENSheets.h"
#import "ENL.h"

@interface ENPlaylistsViewController () <UIActionSheetDelegate, UIGestureRecognizerDelegate>
@end

@implementation ENPlaylistsViewController {
	ENLibrary *_library;          // what the rows show (row 0 = Liked Songs, then _rows)
	NSArray *_rows;               // (0.9) library.playlists with the pinned ones first (-orderRows)
	NSUInteger _pinnedCount;      // how many of _rows lead as pinned (they draw the pin glyph)
	UIActionSheet *_pinSheet;     // the long press's Pin / Unpin sheet while it is on screen (one at a time)
	NSString *_pinURI;            // the playlist it is about (by uri: the rows may move while it is up)
	BOOL _pinAction;              // its button pins (YES) or unpins (NO)
	BOOL _launched;               // the first viewDidAppear ran (launch_ms, then the first revalidation)
	NSInteger _launchChecks;
	NSTimer *_checkTimer;         // a revalidation in flight (see -watchCheck)
	NSDate *_checkSince;
}

#define ENSavedCopyText ENL(@"Showing a saved copy")     // (a macro: a static initializer can't look it up)

- (id)initWithStyle:(UITableViewStyle)style {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		self.title = ENL(@"Playlists");
		self.meterName = @"playlists";
	}
	return self;
}

- (void)dealloc {
	_pinSheet.delegate = nil;
}

- (void)viewDidLoad {
	[super viewDidLoad];
	self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemAdd
	                                                                                      target:self action:@selector(newPlaylist)];
	// launch path (§5.7): the cached library, read and parsed right here; no network until the first frame is up
	_library = [[ENCatalog shared] cachedLibrarySync] ?: [ENCatalog shared].library;
	[self orderRows];
	[self updateFooter];
	if (!_library) [self setBusy:YES];
	// 0.9 pins: a long press on a playlist row -> Pin / Unpin; a change (here or elsewhere) moves the rows
	UILongPressGestureRecognizer *lp = [[UILongPressGestureRecognizer alloc] initWithTarget:self action:@selector(longPressed:)];
	lp.delegate = self;
	[self.tableView addGestureRecognizer:lp];
	[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(pinsChanged:) name:ENPinsChangedNotification object:nil];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	ENLibrary *lib = [ENCatalog shared].library;
	if (lib && lib != _library) [self applyLibrary:lib];
	[self updateFooter];
	[self updateBanner];
	if (_launched) {
		NSDate *at = _library.checkedAt;
		if (!at || -[at timeIntervalSinceNow] > 60) [self reload:NO];
	}
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	[self stopCheck];             // viewWillAppear picks up .library again
}

- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	if (!_launched) {
		_launched = YES;
		_launchChecks = 0;
		[self checkLaunchCovers];
	}
}

// launch_ms ends when the visible covers are drawn (they decode from disk in the background), at most ~0.3 s after
// the first appearance; then the first revalidation.
- (void)checkLaunchCovers {
	BOOL ready = YES;
	for (UITableViewCell *c in self.tableView.visibleCells) {
		if (![c isKindOfClass:[ENListCell class]]) continue;
		ENListCell *cell = (ENListCell *)c;
		ENPlaylist *pl = [cell.item isKindOfClass:[ENPlaylist class]] ? cell.item : nil;
		if (pl.image && !cell.image) { ready = NO; break; }
	}
	if (!ready && ++_launchChecks < 10) {
		[self performSelector:@selector(checkLaunchCovers) withObject:nil afterDelay:0.03];
		return;
	}
	[ENDiag launchFinished];
	[self reload:NO];
}

#pragma mark - data

- (void)reload:(BOOL)fresh {
	if (!_library) [self setBusy:YES];
	[self watchCheck];
	__weak ENPlaylistsViewController *w = self;
	[[ENCatalog shared] loadLibrary:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENPlaylistsViewController *s = w;
		if (!s) return;
		if (error) {
			[s finishRefreshing];
			[s setBusy:NO];
			if ([ENCatalog shared].gatewayTooOld) [s updateBanner];
			else [s showError:error];
			if (!s->_library) [s setEmptyTitle:ENL(@"Your playlists will show here once your Encore Bridge answers.") message:ENL(@"Pull to refresh.")];
			return;
		}
		if (!fromCache) [s finishRefreshing];
		if ([result isKindOfClass:[ENLibrary class]] && result != s->_library) [s applyLibrary:result];
	}];
}

- (void)applyLibrary:(ENLibrary *)lib {
	if (_library && lib.playlists == _library.playlists && lib.likedLength == _library.likedLength) {
		_library = lib;           // a 304's copy (only checkedAt / stale differ): no row reloads
		[self updateFooter];
		[self updateBanner];
		return;
	}
	_library = lib;
	[self orderRows];
	[self setBusy:NO];
	[self setEmptyTitle:nil message:nil];     // (3c) the two-tier kit's call (the failed first load's empty state goes)
	if (self.isViewLoaded) [self.tableView reloadData];
	[self updateFooter];
	[self updateBanner];
}

// a refresh that ended in a 304 delivers nothing: pick up the new check time (and any patched copy) from the catalog
- (void)finishRefreshing {
	[super finishRefreshing];
	[self takeCatalogLibrary];
}

- (void)takeCatalogLibrary {
	ENLibrary *lib = [ENCatalog shared].library;
	if (lib && lib != _library) [self applyLibrary:lib];
	else [self updateFooter];
}

// The gateway answered a library request since `start`: every answer (200 or 304) gives .library a new checkedAt; local
// patches keep the old one. Precise where the catalog-wide `loading` isn't (a like or an add in flight).
- (BOOL)refreshAnsweredSince:(NSDate *)start {
	NSDate *at = [ENCatalog shared].library.checkedAt;
	return at && [at timeIntervalSinceDate:start] >= 0;
}

// A revalidation that ends in a 304 calls nothing back: ENCatalog only replaces .library with a copy carrying the new
// checkedAt (no notification). Watch for it (two compares every 0.5 s) so the footer's "updated …" follows; stops at the
// answer, after 25 s (the GET times out at 20 s; its error calls back anyway) or when the screen is hidden.
- (void)watchCheck {
	_checkSince = [NSDate date];
	if (_checkTimer) return;
	_checkTimer = [NSTimer timerWithTimeInterval:0.5 target:self selector:@selector(checkTick) userInfo:nil repeats:YES];
	[[NSRunLoop mainRunLoop] addTimer:_checkTimer forMode:NSRunLoopCommonModes];
}

- (void)checkTick {
	if ([self refreshAnsweredSince:_checkSince]) {
		[self stopCheck];
		[self takeCatalogLibrary];
	} else if (-[_checkSince timeIntervalSinceNow] > 25) [self stopCheck];
}

- (void)stopCheck {
	[_checkTimer invalidate];
	_checkTimer = nil;
}

- (void)catalogChanged:(NSNotification *)note {
	[super catalogChanged:note];
	if (![note.userInfo[ENCatalogKindKey] isEqualToString:ENCatalogKindLibrary]) return;
	ENLibrary *lib = [ENCatalog shared].library;
	if (lib && lib != _library) [self applyLibrary:lib];
	else [self updateBanner];
}

- (void)updateFooter {
	if (!_library) { self.footerText = nil; return; }
	NSString *n = ENCountText((NSInteger)_library.playlists.count, ENL(@"playlist"), ENL(@"playlists"));
	self.footerText = _library.checkedAt ? [NSString stringWithFormat:ENL(@"%@ · updated %@"), n, ENRelativeTime(_library.checkedAt)] : n;
}

// "Showing a saved copy" goes again with the first answer that isn't stale (an error banner stays until tapped)
- (void)updateBanner {
	if ([ENCatalog shared].gatewayTooOld) [self showBanner:ENUpdateBridgeShortText];
	else if (_library.stale) [self showBanner:ENSavedCopyText];
	else [self hideBannerIfShowing:ENSavedCopyText];
}

#pragma mark - table

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return 1 + (NSInteger)_rows.count;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	if (ip.row == 0) {
		NSInteger n = _library ? _library.likedLength : -1;
		[cell showTitle:ENL(@"Liked Songs") subtitle:(n >= 0 ? ENCountText(n, ENL(@"song"), ENL(@"songs")) : nil)
		          image:[ENTheme current].likedTile chevron:YES];
	} else {
		NSUInteger i = (NSUInteger)ip.row - 1;
		[cell showPlaylist:_rows[i]];
		cell.pinned = i < _pinnedCount;
	}
	return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	UIViewController *vc;
	if (ip.row == 0) vc = [[ENTrackListViewController alloc] initWithLikedLibrary:_library];
	else if ((NSUInteger)ip.row - 1 < _rows.count) vc = [[ENTrackListViewController alloc] initWithPlaylist:_rows[(NSUInteger)ip.row - 1]];
	else return;
	[self.navigationController pushViewController:vc animated:YES];
}

#pragma mark - pins (0.9, DESIGN-0.9 §2)

// Row 0 Liked Songs, then the pinned playlists that are in the library (pin order, each once), then every other playlist
// in sidebar order. Pins live in ENPins (per phone); Liked Songs itself can't be pinned (it always leads).
- (void)orderRows {
	NSUInteger n = 0;
	_rows = [ENPins orderPlaylists:_library.playlists pinnedCount:&n];
	_pinnedCount = n;
}

// A pin or an unpin: the playlists whose pinned state changed move (the standard row move animation) and the moved cells
// redraw their pin glyph; a reload when the screen is hidden or the rows aren't simply re-ordered.
- (void)pinsChanged:(NSNotification *)note {
	NSArray *old = _rows;
	NSUInteger oldPinned = _pinnedCount;
	[self orderRows];
	if (!self.isViewLoaded) return;
	UITableView *tv = self.tableView;
	NSArray *moves = self.view.window ? [self movesFrom:old pinned:oldPinned] : nil;
	if (!moves) {
		[tv reloadData];
		return;
	}
	if (moves.count) {
		[tv beginUpdates];
		for (NSArray *m in moves)
			[tv moveRowAtIndexPath:[NSIndexPath indexPathForRow:[m[0] integerValue] inSection:0]
			           toIndexPath:[NSIndexPath indexPathForRow:[m[1] integerValue] inSection:0]];
		[tv endUpdates];
	}
	for (UITableViewCell *c in tv.visibleCells) {          // a moved row keeps its cell: only its glyph changes
		if (![c isKindOfClass:[ENListCell class]]) continue;
		ENListCell *cell = (ENListCell *)c;
		if (![cell.item isKindOfClass:[ENPlaylist class]]) continue;
		NSUInteger i = [_rows indexOfObjectIdenticalTo:cell.item];
		cell.pinned = i != NSNotFound && i < _pinnedCount;
	}
}

// The table row moves (@[from, to], Liked Songs counted) that turn `old` (its first oldPinned pinned) into _rows: the
// playlists whose pinned state changed; everything else must keep its relative order (pins lead in pin order, the rest
// stay in sidebar order). nil when the rows differ in any other way.
- (NSArray *)movesFrom:(NSArray *)old pinned:(NSUInteger)oldPinned {
	if (old.count != _rows.count) return nil;
	NSMutableDictionary *newIndex = [NSMutableDictionary dictionaryWithCapacity:_rows.count];     // by object, not by uri
	[_rows enumerateObjectsUsingBlock:^(id pl, NSUInteger j, BOOL *stop) {
		newIndex[[NSValue valueWithNonretainedObject:pl]] = @(j);
	}];
	if (newIndex.count != _rows.count) return nil;
	NSMutableArray *moves = [NSMutableArray array];
	NSMutableSet *moved = [NSMutableSet set];
	NSMutableArray *keptOld = [NSMutableArray arrayWithCapacity:old.count];
	for (NSUInteger i = 0; i < old.count; i++) {
		NSValue *k = [NSValue valueWithNonretainedObject:old[i]];
		NSNumber *jn = newIndex[k];
		if (!jn) return nil;
		NSUInteger j = [jn unsignedIntegerValue];
		if ((i < oldPinned) != (j < _pinnedCount)) {
			[moves addObject:@[ @(i + 1), @(j + 1) ]];
			[moved addObject:k];
		} else [keptOld addObject:k];
	}
	NSUInteger n = 0;
	for (id pl in _rows) {
		NSValue *k = [NSValue valueWithNonretainedObject:pl];
		if ([moved containsObject:k]) continue;
		if (n >= keptOld.count || ![keptOld[n] isEqual:k]) return nil;
		n++;
	}
	return moves;
}

// the playlist row under a press (nil on Liked Songs, which can't be pinned, and below the rows)
- (NSIndexPath *)pinRowForPress:(UIGestureRecognizer *)g {
	NSIndexPath *ip = [self.tableView indexPathForRowAtPoint:[g locationInView:self.tableView]];
	return (ip && ip.row >= 1 && (NSUInteger)ip.row - 1 < _rows.count) ? ip : nil;
}

// anywhere else the long press fails, so the touch carries on as usual (holding Liked Songs still opens it)
- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)g {
	return !_pinSheet && [self pinRowForPress:g] != nil;
}

- (void)longPressed:(UILongPressGestureRecognizer *)g {
	if (g.state != UIGestureRecognizerStateBegan || _pinSheet) return;
	UITableView *tv = self.tableView;
	NSIndexPath *ip = [self pinRowForPress:g];
	if (!ip) return;
	ENPlaylist *pl = _rows[(NSUInteger)ip.row - 1];
	if (!pl.uri.length) return;
	_pinURI = pl.uri;
	_pinAction = ![ENPins isPinned:pl.uri];
	// (Drop 3a, A3) the green sheet (ENSheets); delegate, buttons and the one-at-a-time guard are unchanged
	UIActionSheet *sheet = [[ENActionSheet alloc] initWithTitle:pl.name delegate:self cancelButtonTitle:nil destructiveButtonTitle:nil
	                                          otherButtonTitles:(_pinAction ? ENL(@"Pin Playlist") : ENL(@"Unpin Playlist")), nil];
	sheet.cancelButtonIndex = [sheet addButtonWithTitle:ENL(@"Cancel")];
	sheet.actionSheetStyle = UIActionSheetStyleBlackTranslucent;
	_pinSheet = sheet;
	[tv selectRowAtIndexPath:ip animated:NO scrollPosition:UITableViewScrollPositionNone];     // which row it is about
	// from the tab bar, as ENTrackActions does (else the tab bar swallows the sheet's bottom buttons)
	UITabBarController *tabs = self.tabBarController;
	if (tabs.view.window) [sheet showFromTabBar:tabs.tabBar];
	else [sheet showInView:self.view];
}

- (void)actionSheet:(UIActionSheet *)sheet didDismissWithButtonIndex:(NSInteger)index {
	if (sheet != _pinSheet) return;
	_pinSheet.delegate = nil;
	_pinSheet = nil;
	NSString *uri = _pinURI;
	_pinURI = nil;
	NSIndexPath *sel = self.tableView.indexPathForSelectedRow;
	if (sel) [self.tableView deselectRowAtIndexPath:sel animated:YES];
	if (index < 0 || index == sheet.cancelButtonIndex || !uri) return;
	[ENPins setPinned:_pinAction forURI:uri shownIn:_library.playlists];      // -> ENPinsChangedNotification -> -pinsChanged:
}

#pragma mark - "+" (3c)

- (void)newPlaylist {
	__weak ENPlaylistsViewController *w = self;
	[ENTrackActions newPlaylistFrom:self track:nil done:^(ENPlaylist *created) {
		ENPlaylistsViewController *s = w;
		if (!s || !created) return;
		[s.navigationController pushViewController:[[ENTrackListViewController alloc] initWithPlaylist:created] animated:YES];
	}];
}

@end

#import "ENUserPlaylistsViewController.h"
#import "ENTrackListViewController.h"
#import "ENUserRows.h"
#import "ENCatalog.h"
#import "ENModel.h"
#import "ENTheme.h"
#import "ENUtil.h"
#import "ENAnon.h"
#import "ENL.h"

// (0.11 profiles) see ENUserPlaylistsViewController.h

#define ENUserPlaylistsSavedCopyText ENL(@"Showing a saved copy")     // (a macro: a static initializer can't look it up)

@implementation ENUserPlaylistsViewController {
	NSString *_uri, *_name;         // whose (never logged)
	NSMutableDictionary *_pages;    // offset (NSNumber) -> ENRowList (Playlists), as delivered
	NSArray *_rows;                 // ENPlaylist: the pages from offset 0 on, while each follows the one before
	NSInteger _next;                // the next page to load; -1 = none (or the first page isn't here yet)
	NSInteger _total;
	BOOL _loadingMore;
	NSInteger _gen;                 // a pull to refresh starts the pages again: a "Load more…" answer from before is dropped
}

- (instancetype)initWithUserURI:(NSString *)uri name:(NSString *)name {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		_uri = [uri copy];
		_name = [name copy];
		_pages = [NSMutableDictionary dictionary];
		_rows = @[];
		_next = -1;
		self.title = ENL(@"Public Playlists");
		self.meterName = @"user playlists";
	}
	return self;
}

- (void)viewDidLoad {
	[super viewDidLoad];
	[self reload:NO];
}

#pragma mark - loading

- (void)reload:(BOOL)fresh {
	if (!_pages[@0]) {
		[self setEmptyTitle:nil message:nil];     // (3c) a failed load's empty state: the spinner replaces it
		[self setBusy:YES];
	}
	__weak ENUserPlaylistsViewController *w = self;
	[[ENCatalog shared] loadUserPlaylists:_uri offset:0 fresh:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENUserPlaylistsViewController *s = w;
		if (!s) return;
		if (error) {
			[s finishRefreshing];
			[s setBusy:NO];
			[s showError:error];
			if (!s->_pages[@0]) [s setEmptyTitle:ENL(@"Couldn't load this list.") message:ENL(@"Pull to refresh.")];     // (3c)
			return;
		}
		if (!fromCache) [s finishRefreshing];
		if (![result isKindOfClass:[ENRowList class]]) return;
		if (fresh && !fromCache) {         // a pull to refresh: the pages start again from this one
			[s->_pages removeAllObjects];
			s->_gen++;
			s->_loadingMore = NO;
		}
		[s takePage:result offset:0];
	}];
}

- (void)loadMore {
	if (_loadingMore || _next < 0) return;
	_loadingMore = YES;
	[self reloadMoreRow];
	NSInteger offset = _next, gen = _gen;
	__weak ENUserPlaylistsViewController *w = self;
	[[ENCatalog shared] loadUserPlaylists:_uri offset:offset fresh:NO done:^(id result, BOOL fromCache, NSError *error) {
		ENUserPlaylistsViewController *s = w;
		if (!s || gen != s->_gen) return;
		s->_loadingMore = NO;
		if (error) {
			[s showError:error];
			[s reloadMoreRow];
			return;
		}
		if ([result isKindOfClass:[ENRowList class]]) [s takePage:result offset:offset];
		else [s reloadMoreRow];
	}];
}

- (void)takePage:(ENRowList *)page offset:(NSInteger)offset {
	if (_pages[@(offset)] == page) return;
	_pages[@(offset)] = page;
	[self rebuild];
}

// the rows: page 0, then the page at its next, and so on while it is here (each playlist once); the footer and banner from
// the first page
- (void)rebuild {
	ENRowList *first = _pages[@0];
	NSMutableArray *rows = [NSMutableArray array];
	NSMutableSet *seen = [NSMutableSet set];
	NSInteger off = 0, next = -1;
	for (ENRowList *p = first; p; p = _pages[@(off)]) {
		for (ENPlaylist *pl in p.items) {
			if (![pl isKindOfClass:[ENPlaylist class]] || [seen containsObject:pl.uri]) continue;
			[seen addObject:pl.uri];
			[rows addObject:pl];
		}
		next = p.next;
		if (next <= off) { next = -1; break; }
		off = next;
	}
	_rows = rows;
	_next = first ? next : -1;
	_total = first ? MAX(first.total, (NSInteger)rows.count) : 0;
	if (first) [self setBusy:NO];
	self.footerText = _total > 0 ? ENCountText(_total, ENL(@"public playlist"), ENL(@"public playlists")) : nil;
	[self setEmptyTitle:(first && !rows.count ? ENL(@"No public playlists") : nil) message:nil];
	if (first.stale) [self showBanner:ENUserPlaylistsSavedCopyText];
	else [self hideBannerIfShowing:ENUserPlaylistsSavedCopyText];
	if (self.isViewLoaded) [self.tableView reloadData];
}

- (void)reloadMoreRow {
	if (!self.isViewLoaded || _next < 0) return;
	NSIndexPath *ip = [NSIndexPath indexPathForRow:(NSInteger)_rows.count inSection:0];
	[self.tableView reloadRowsAtIndexPaths:@[ ip ] withRowAnimation:UITableViewRowAnimationNone];
}

#pragma mark - table

- (BOOL)isMoreRow:(NSIndexPath *)ip { return (NSUInteger)ip.row >= _rows.count; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return (NSInteger)_rows.count + (_next >= 0 ? 1 : 0);
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	if ([self isMoreRow:ip]) {
		[cell showAction:ENL(@"Load more…") busy:_loadingMore];
		return cell;
	}
	ENPlaylist *pl = _rows[(NSUInteger)ip.row];
	[cell showPlaylist:pl];
	// (R2a) whose page this is, as their playlists' owner shows: the made-up name while Anonymous Mode is on
	cell.subtitle = ENProfilePlaylistSub(pl, ([ENAnon on] ? [ENAnon nameForUser:_uri] : _name));
	return cell;
}

- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	return [self isMoreRow:ip] ? !_loadingMore : YES;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	if ([self isMoreRow:ip]) {
		[self loadMore];
		return;
	}
	ENTrackListViewController *vc = [[ENTrackListViewController alloc] initWithPlaylist:_rows[(NSUInteger)ip.row]];
	vc.ignoresMiniPlayer = self.ignoresMiniPlayer;
	[self.navigationController pushViewController:vc animated:YES];
}

@end

#import "ENPeopleViewController.h"
#import "ENProfileViewController.h"
#import "ENArtistViewController.h"
#import "ENUserRows.h"
#import "ENCatalog.h"
#import "ENModel.h"
#import "ENTheme.h"
#import "ENUtil.h"
#import "ENL.h"

// (0.11 profiles) see ENPeopleViewController.h

typedef enum { ENPeopleSearch = 0, ENPeopleFollowers, ENPeopleFollowing } ENPeopleMode;

#define ENPeopleSavedCopyText ENL(@"Showing a saved copy")     // (a macro: a static initializer can't look it up)

@implementation ENPeopleViewController {
	ENPeopleMode _mode;
	NSString *_query;               // search: the query (never logged)
	NSString *_uri;                 // followers / following: whose
	NSArray *_rows;                 // ENUserRow / ENArtistRow
	ENRowList *_list;               // followers / following: the answer shown
	NSInteger _total;               // search: the gateway's total
	NSInteger _next;                // search: the next page's offset; -1 = none
	BOOL _loadingMore;
}

- (instancetype)initWithMode:(ENPeopleMode)mode {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		_mode = mode;
		_rows = @[];
		_next = -1;
		self.meterName = @"people";
		self.title = mode == ENPeopleSearch ? ENL(@"Profiles") : mode == ENPeopleFollowers ? ENL(@"Followers") : ENL(@"Following");
		if (mode == ENPeopleSearch) self.refreshable = NO;     // (a search has no fresh copy)
	}
	return self;
}

- (instancetype)initWithSearchQuery:(NSString *)q first:(ENRowList *)page {
	if ((self = [self initWithMode:ENPeopleSearch])) {
		_query = [q copy];
		_rows = page.items ?: @[];
		_total = page.total;
		_next = page.next;
		[self updateFooter];
	}
	return self;
}

- (instancetype)initFollowersOf:(NSString *)uri {
	if ((self = [self initWithMode:ENPeopleFollowers])) _uri = [uri copy];
	return self;
}

- (instancetype)initFollowingOf:(NSString *)uri {
	if ((self = [self initWithMode:ENPeopleFollowing])) _uri = [uri copy];
	return self;
}

- (void)viewDidLoad {
	[super viewDidLoad];
	if (_mode != ENPeopleSearch) [self reload:NO];
}

#pragma mark - loading

- (void)reload:(BOOL)fresh {
	if (_mode == ENPeopleSearch) {
		[self finishRefreshing];
		return;
	}
	if (!_list) {
		[self setEmptyTitle:nil message:nil];     // (3c) a failed load's empty state: the spinner replaces it
		[self setBusy:YES];
	}
	__weak ENPeopleViewController *w = self;
	ENCatalogBlock done = ^(id result, BOOL fromCache, NSError *error) {
		ENPeopleViewController *s = w;
		if (!s) return;
		if (error) {
			[s finishRefreshing];
			[s setBusy:NO];
			[s listFailed:error];
			return;
		}
		if (!fromCache) [s finishRefreshing];
		if ([result isKindOfClass:[ENRowList class]] && result != s->_list) [s applyList:result];
	};
	if (_mode == ENPeopleFollowers) [[ENCatalog shared] loadFollowers:_uri fresh:fresh done:done];
	else [[ENCatalog shared] loadFollowing:_uri fresh:fresh done:done];
}

- (void)applyList:(ENRowList *)l {
	_list = l;
	_rows = l.items ?: @[];
	[self setBusy:NO];
	if (_rows.count) [self setEmptyTitle:nil message:nil];
	else [self setEmptyTitle:(_mode == ENPeopleFollowers ? ENL(@"No followers yet") : ENL(@"Not following anyone yet")) message:nil];
	[self updateFooter];
	if (l.stale) [self showBanner:ENPeopleSavedCopyText];
	else [self hideBannerIfShowing:ENPeopleSavedCopyText];
	if (self.isViewLoaded) [self.tableView reloadData];
}

// 404 user_not_found: the empty title; anything else: the banner (rows stay)
- (void)listFailed:(NSError *)error {
	if ([[ENCatalog codeOfError:error] isEqualToString:@"user_not_found"]) {
		_list = nil;
		_rows = @[];
		self.footerText = nil;
		[self hideBanner];
		if (self.isViewLoaded) [self.tableView reloadData];
		[self setEmptyTitle:ENL(@"Profile not available") message:ENL(@"This profile isn't available on Spotify.")];
		return;
	}
	[self showError:error];
	if (!_list) [self setEmptyTitle:ENL(@"Couldn't load this list.") message:ENL(@"Pull to refresh.")];     // (3c) nothing to show
}

- (void)updateFooter {
	if (_mode == ENPeopleSearch) self.footerText = _total > 0 ? ENCountText(_total, ENL(@"profile"), ENL(@"profiles")) : nil;
	else self.footerText = _list.truncated ? [NSString stringWithFormat:ENL(@"Showing the first %@"), ENGroupedNumber((NSInteger)_rows.count)] : nil;
}

// search: the next 10 ([ENCatalog searchUsers:offset:done:]), each person once
- (void)loadMore {
	if (_loadingMore || _next < 0 || !_query.length) return;
	_loadingMore = YES;
	[self reloadMoreRow];
	NSInteger offset = _next;
	__weak ENPeopleViewController *w = self;
	[[ENCatalog shared] searchUsers:_query offset:offset done:^(id result, BOOL fromCache, NSError *error) {
		ENPeopleViewController *s = w;
		if (!s) return;
		s->_loadingMore = NO;
		if (error || ![result isKindOfClass:[ENRowList class]]) {
			if (error) [s showError:error];
			[s reloadMoreRow];
			return;
		}
		ENRowList *r = result;
		[s hideBanner];
		NSMutableSet *seen = [NSMutableSet setWithCapacity:s->_rows.count];
		for (id x in s->_rows) if ([x isKindOfClass:[ENUserRow class]]) [seen addObject:((ENUserRow *)x).uri];
		NSMutableArray *rows = [NSMutableArray arrayWithArray:s->_rows];
		NSUInteger from = rows.count;
		for (ENUserRow *u in r.items) {
			if (![u isKindOfClass:[ENUserRow class]] || [seen containsObject:u.uri]) continue;
			[seen addObject:u.uri];
			[rows addObject:u];
		}
		s->_rows = rows;
		s->_next = r.next > offset ? r.next : -1;            // never ask for the same page twice
		if (r.total > s->_total) s->_total = r.total;
		[s updateFooter];
		if (s.isViewLoaded) {
			[s.tableView reloadData];
			if (rows.count > from) [s.tableView flashScrollIndicators];
		}
	}];
}

- (void)reloadMoreRow {
	if (!self.isViewLoaded || _mode != ENPeopleSearch || _next < 0) return;
	NSIndexPath *ip = [NSIndexPath indexPathForRow:(NSInteger)_rows.count inSection:0];
	[self.tableView reloadRowsAtIndexPaths:@[ ip ] withRowAnimation:UITableViewRowAnimationNone];
}

#pragma mark - table

- (BOOL)isMoreRow:(NSIndexPath *)ip { return _mode == ENPeopleSearch && (NSUInteger)ip.row >= _rows.count; }

- (id)itemAt:(NSIndexPath *)ip { return (NSUInteger)ip.row < _rows.count ? _rows[(NSUInteger)ip.row] : nil; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return (NSInteger)_rows.count + (_mode == ENPeopleSearch && _next >= 0 ? 1 : 0);
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	if ([self isMoreRow:ip]) {
		[cell showAction:ENL(@"Load 10 more…") busy:_loadingMore];
		return cell;
	}
	id x = [self itemAt:ip];
	if ([x isKindOfClass:[ENUserRow class]]) {
		ENUserRow *u = x;
		[cell showUser:u subtitle:(u.followers >= 0 ? ENCountText(u.followers, ENL(@"follower"), ENL(@"followers")) : ENL(@"Profile"))];
	} else if ([x isKindOfClass:[ENArtistRow class]]) {
		[cell showArtist:x subtitle:nil];
	}
	return cell;
}

- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	return [self isMoreRow:ip] ? !_loadingMore : [self itemAt:ip] != nil;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	if ([self isMoreRow:ip]) {
		[self loadMore];
		return;
	}
	id x = [self itemAt:ip];
	ENListViewController *vc = nil;
	if ([x isKindOfClass:[ENUserRow class]]) {
		ENUserRow *u = x;
		vc = [[ENProfileViewController alloc] initWithUserURI:u.uri name:u.name image:u.image];     // (the user's own uri: their profile)
	} else if ([x isKindOfClass:[ENArtistRow class]]) {
		vc = [[ENArtistViewController alloc] initWithArtist:x];
	}
	if (!vc) return;
	vc.ignoresMiniPlayer = self.ignoresMiniPlayer;
	[self.navigationController pushViewController:vc animated:YES];
}

@end

#import "ENLibraryViewController.h"
#import "ENHomeViewController.h"
#import "ENTheme.h"
#import "ENModel.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENTrackListViewController.h"
#import "ENArtistViewController.h"
#import "ENUtil.h"

typedef enum { ENLibRowLiked = 0, ENLibRowAlbums, ENLibRowArtists, ENLibRowRecent, ENLibRowCount } ENLibRow;

// (Drop 3a, A3) the mockup's iconTile, a 42 pt square with a white glyph: -[ENTheme iconTileNamed:size:] (the same gradients
// and glyphs as the 0.7 tiles drawn here before, cached once in ENTheme)
static const CGFloat ENLibTileSide = 42;

@implementation ENLibraryViewController {
	ENLibrary *_library;          // for the Liked Songs count
	ENRowList *_albums, *_artists;
	UIBarButtonItem *_profileItem;
	NSDate *_loadedAt;
	BOOL _albumsStale;            // (0.9) Your Library's albums changed while hidden: reloaded (fresh) on the next appearance
}

- (id)initWithStyle:(UITableViewStyle)style {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		self.title = @"Library";
		self.meterName = @"library";
	}
	return self;
}

- (void)viewDidLoad {
	[super viewDidLoad];
	_profileItem = [ENHomeViewController profileButtonFor:self];
	self.navigationItem.leftBarButtonItem = _profileItem;
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	[ENHomeViewController refreshProfileButton:_profileItem];
	ENLibrary *lib = [ENCatalog shared].library;
	if (lib != _library) {
		_library = lib;
		[self.tableView reloadData];
	}
	if (!_loadedAt || -[_loadedAt timeIntervalSinceNow] > 60) [self reload:NO];
	else if (_albumsStale) [self loadAlbums:YES];
}

- (void)reload:(BOOL)fresh {
	_loadedAt = [NSDate date];
	__weak ENLibraryViewController *w = self;
	// (a 304 calls nothing back: the base's refresh watch ends the spinner then)
	void (^ended)(BOOL) = ^(BOOL network) { if (network) [w finishRefreshing]; };
	[[ENCatalog shared] loadLibrary:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENLibraryViewController *s = w;
		if (!s) return;
		if (error) [s showError:error];
		ended(!fromCache || error);
		if ([result isKindOfClass:[ENLibrary class]] && result != s->_library) {
			s->_library = result;
			[s.tableView reloadData];
		}
	}];
	[self loadAlbums:(fresh || _albumsStale)];
	[[ENCatalog shared] loadFollowedArtists:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENLibraryViewController *s = w;
		if (!s) return;
		if (error) [s showError:error];
		ended(!fromCache || error);
		if ([result isKindOfClass:[ENRowList class]] && result != s->_artists) {
			s->_artists = result;
			[s.tableView reloadData];
		}
	}];
}

// The saved albums: the Albums count and Recently Added Albums. (A network answer ends a pull to refresh, as in -reload:.)
- (void)loadAlbums:(BOOL)fresh {
	_albumsStale = NO;
	__weak ENLibraryViewController *w = self;
	[[ENCatalog shared] loadSavedAlbums:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENLibraryViewController *s = w;
		if (!s) return;
		if (error) [s showError:error];
		if (!fromCache || error) [s finishRefreshing];
		if ([result isKindOfClass:[ENRowList class]] && result != s->_albums) {
			s->_albums = result;
			[s.tableView reloadData];
		}
	}];
}

- (void)catalogChanged:(NSNotification *)note {
	[super catalogChanged:note];
	NSString *kind = note.userInfo[ENCatalogKindKey];
	if (!self.isViewLoaded) return;
	if ([kind isEqualToString:ENCatalogKindAlbums]) {
		// (0.9) the saved albums list changed (an album page's ♥, or another phone): the count and Recently Added Albums
		// follow at once while on screen, else on the next appearance. A state-only change (with uris) isn't one.
		if (note.userInfo[ENCatalogURIsKey]) return;
		if (self.visible) [self loadAlbums:YES];
		else _albumsStale = YES;
		return;
	}
	if (![kind isEqualToString:ENCatalogKindLibrary]) return;
	ENLibrary *lib = [ENCatalog shared].library;
	if (lib && lib != _library) {
		_library = lib;
		[self.tableView reloadData];
	}
}

- (void)dropModels {
	_albums = _artists = nil;
	_loadedAt = nil;
	if (self.isViewLoaded) [self.tableView reloadData];
}

#pragma mark - table

- (NSArray *)recentAlbums {
	NSArray *a = _albums.items;
	return a.count > 4 ? [a subarrayWithRange:NSMakeRange(0, 4)] : (a ?: @[]);
}

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return [self recentAlbums].count ? 2 : 1; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return section == 0 ? ENLibRowCount : (NSInteger)[self recentAlbums].count;
}

- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	return section == 1 ? [self sectionHeaderWithTitle:@"Recently Added Albums"] : nil;
}

- (CGFloat)tableView:(UITableView *)tableView heightForHeaderInSection:(NSInteger)section { return section == 1 ? 22 : 0; }

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	if (ip.section == 1) {
		ENAlbumRow *al = [self recentAlbums][(NSUInteger)ip.row];
		[cell showAlbum:al subtitle:al.artist];
		return cell;
	}
	switch ((ENLibRow)ip.row) {
		case ENLibRowLiked: {
			NSInteger n = _library ? _library.likedLength : -1;
			[cell showTitle:@"Liked Songs" subtitle:(n >= 0 ? ENCountText(n, @"song", @"songs") : nil) image:[ENTheme current].likedTile chevron:YES];
			break;
		}
		case ENLibRowAlbums: {
			NSInteger n = _albums ? _albums.total : -1;
			[cell showTitle:@"Albums" subtitle:(n >= 0 ? ENCountText(n, @"album", @"albums") : nil)
			          image:[[ENTheme current] iconTileNamed:@"album" size:ENLibTileSide] chevron:YES];
			break;
		}
		case ENLibRowArtists: {
			NSInteger n = _artists ? _artists.total : -1;
			[cell showTitle:@"Artists" subtitle:(n >= 0 ? ENCountText(n, @"following", @"following") : nil)
			          image:[[ENTheme current] iconTileNamed:@"artist" size:ENLibTileSide] chevron:YES];
			break;
		}
		case ENLibRowRecent:
			[cell showTitle:@"Recently Played" subtitle:@"Last 50 plays"
			          image:[[ENTheme current] iconTileNamed:@"recent" size:ENLibTileSide] chevron:YES];
			break;
		case ENLibRowCount: break;
	}
	return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	UIViewController *vc = nil;
	if (ip.section == 1) {
		NSArray *a = [self recentAlbums];
		if ((NSUInteger)ip.row < a.count) vc = [[ENTrackListViewController alloc] initWithAlbum:a[(NSUInteger)ip.row]];
	} else {
		switch ((ENLibRow)ip.row) {
			case ENLibRowLiked: vc = [[ENTrackListViewController alloc] initWithLikedLibrary:_library]; break;
			case ENLibRowAlbums: vc = [[ENLibraryListViewController alloc] initWithKind:ENRowListAlbums]; break;
			case ENLibRowArtists: vc = [[ENLibraryListViewController alloc] initWithKind:ENRowListArtists]; break;
			case ENLibRowRecent: vc = [[ENLibraryListViewController alloc] initWithKind:ENRowListRecent]; break;
			case ENLibRowCount: break;
		}
	}
	if (vc) [self.navigationController pushViewController:vc animated:YES];
}

@end

#pragma mark - Albums / Artists / Recently Played

@implementation ENLibraryListViewController {
	ENRowListKind _kind;
	ENRowList *_list;
	BOOL _stale;                  // (0.9) Albums: Your Library's albums changed while hidden
}

- (instancetype)initWithKind:(NSInteger)kind {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		_kind = (ENRowListKind)kind;
		self.title = _kind == ENRowListAlbums ? @"Albums" : _kind == ENRowListArtists ? @"Artists" : @"Recently Played";
		self.meterName = _kind == ENRowListAlbums ? @"my albums" : _kind == ENRowListArtists ? @"my artists" : @"recent";
		// (3c) the mockup's small title on Recently Played (after self.title: the base set the 20 pt one)
		if (_kind == ENRowListRecent) [[ENTheme current] applyTitle:self.title toItem:self.navigationItem small:YES];
	}
	return self;
}

- (void)viewDidLoad {
	[super viewDidLoad];
	[self reload:NO];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	if (_stale) [self reload:YES];
}

// (0.9) Albums: an album saved or removed (its page's ♥, or another phone) reloads the list (fresh), at once while on
// screen, else on the next appearance (back from that album's page)
- (void)catalogChanged:(NSNotification *)note {
	[super catalogChanged:note];
	if (_kind != ENRowListAlbums || ![note.userInfo[ENCatalogKindKey] isEqualToString:ENCatalogKindAlbums] ||
		note.userInfo[ENCatalogURIsKey] || !self.isViewLoaded) return;
	if (self.visible) [self reload:YES];
	else _stale = YES;
}

- (void)reload:(BOOL)fresh {
	_stale = NO;
	if (!_list) {
		[self setEmptyTitle:nil message:nil];
		[self setBusy:YES];
	}
	__weak ENLibraryListViewController *w = self;
	ENCatalogBlock done = ^(id result, BOOL fromCache, NSError *error) {
		ENLibraryListViewController *s = w;
		if (!s) return;
		if (error) {
			[s finishRefreshing];
			[s setBusy:NO];
			[s showError:error];
			if (!s->_list) [s setEmptyTitle:@"Couldn't load this list." message:@"Pull to refresh."];
			return;
		}
		if (!fromCache) [s finishRefreshing];
		if ([result isKindOfClass:[ENRowList class]] && result != s->_list) [s applyList:result];
	};
	ENCatalog *cat = [ENCatalog shared];
	if (_kind == ENRowListAlbums) [cat loadSavedAlbums:fresh done:done];
	else if (_kind == ENRowListArtists) [cat loadFollowedArtists:fresh done:done];
	else [cat loadRecentlyPlayed:fresh done:done];
}

- (void)applyList:(ENRowList *)list {
	_list = list;
	[self setBusy:NO];
	NSInteger n = list.total >= 0 ? list.total : (NSInteger)list.items.count;
	if (!list.items.count) {
		// (3c) two-tier: a short title over the sentence of before
		if (_kind == ENRowListAlbums) [self setEmptyTitle:@"No albums yet" message:@"Albums you save show up here."];
		else if (_kind == ENRowListArtists) [self setEmptyTitle:@"No artists yet" message:@"Artists you follow show up here."];
		else [self setEmptyTitle:@"Nothing played yet" message:@"Songs you play show up here."];
		self.footerText = nil;
	} else {
		[self setEmptyTitle:nil message:nil];
		self.footerText = _kind == ENRowListAlbums ? ENCountText(n, @"album", @"albums") : _kind == ENRowListArtists ?
			ENCountText(n, @"artist", @"artists") : ENCountText(n, @"play", @"plays");
	}
	if (list.stale) [self showBanner:@"Showing a saved copy"];
	else [self hideBannerIfShowing:@"Showing a saved copy"];
	[self.tableView reloadData];
}

- (void)dropModels {
	_list = nil;
	if (self.isViewLoaded) [self.tableView reloadData];
}

- (id)itemAt:(NSIndexPath *)ip { return (NSUInteger)ip.row < _list.items.count ? _list.items[(NSUInteger)ip.row] : nil; }

- (ENTrack *)trackAtIndexPath:(NSIndexPath *)ip {
	id x = [self itemAt:ip];
	return [x isKindOfClass:[ENTrack class]] ? x : nil;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section { return (NSInteger)_list.items.count; }

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	id x = [self itemAt:ip];
	if ([x isKindOfClass:[ENAlbumRow class]]) [cell showAlbum:x subtitle:((ENAlbumRow *)x).artistYearText];
	else if ([x isKindOfClass:[ENArtistRow class]]) [cell showArtist:x subtitle:@""];     // (3c) no "Artist" sub-line
	else if ([x isKindOfClass:[ENTrack class]]) {
		ENTrack *t = x;
		[cell showTrack:t art:ENCellArtCover playing:[[ENPlayback shared] isPlayingRow:t]];
		if (t.playable && t.playedAt) cell.subtitle = [NSString stringWithFormat:@"%@ · %@", t.subline, ENRelativeTime(t.playedAt)];
	}
	return cell;
}

- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	id x = [self itemAt:ip];
	return [x isKindOfClass:[ENTrack class]] ? ((ENTrack *)x).playable : x != nil;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	id x = [self itemAt:ip];
	UIViewController *vc = nil;
	if ([x isKindOfClass:[ENAlbumRow class]]) vc = [[ENTrackListViewController alloc] initWithAlbum:x];
	else if ([x isKindOfClass:[ENArtistRow class]]) vc = [[ENArtistViewController alloc] initWithArtist:x];
	else if ([x isKindOfClass:[ENTrack class]] && ((ENTrack *)x).playable) [[ENPlayback shared] playURI:((ENTrack *)x).uri];
	if (vc) [self.navigationController pushViewController:vc animated:YES];
}

@end

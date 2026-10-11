#import "ENSearchSongsViewController.h"
#import "ENTheme.h"
#import "ENModel.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENRecents.h"
#import "ENUtil.h"

@implementation ENSearchSongsViewController {
	NSString *_query;
	NSMutableArray *_tracks;        // every page so far
	NSInteger _next;                // the next page's offset; -1 = no more
	BOOL _loadingMore;
}

- (instancetype)initWithResult:(ENSearchResult *)first {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		_query = [first.query copy];
		_tracks = [NSMutableArray arrayWithArray:first.tracks ?: @[]];
		_next = first.tracksNext;
		// (3c, C4) titled “q” in the small (17 pt) title, as the mockup's See all; the back button still says "Search"
		self.title = _query.length ? [NSString stringWithFormat:@"“%@”", _query] : @"Songs";
		[[ENTheme current] applyTitle:self.title toItem:self.navigationItem small:YES];
		self.refreshable = NO;
		self.meterName = @"search songs";
		if (first.tracksTotal > 0) self.footerText = [NSString stringWithFormat:@"%@ for “%@”", ENCountText(first.tracksTotal, @"song", @"songs"), _query ?: @""];
	}
	return self;
}

- (BOOL)isMoreRow:(NSIndexPath *)ip { return (NSUInteger)ip.row >= _tracks.count; }

- (ENTrack *)trackAtIndexPath:(NSIndexPath *)ip {
	return (NSUInteger)ip.row < _tracks.count ? _tracks[(NSUInteger)ip.row] : nil;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return (NSInteger)_tracks.count + (_next >= 0 ? 1 : 0);
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	if ([self isMoreRow:ip]) {                 // (3c) a centred green action row; while loading its spinner replaces the text
		[cell showAction:@"Load 10 more…" busy:_loadingMore];
	} else {
		ENTrack *t = _tracks[(NSUInteger)ip.row];
		[cell showTrack:t art:ENCellArtCover playing:[[ENPlayback shared] isPlayingRow:t]];
	}
	return cell;
}

- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	return [self isMoreRow:ip] ? !_loadingMore : [self trackAtIndexPath:ip].playable;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	if ([self isMoreRow:ip]) { [self loadMore]; return; }
	ENTrack *t = [self trackAtIndexPath:ip];
	if (!t.playable) return;
	[ENRecents add:t];                     // (0.9.5) Search's "Recent searches", before it plays
	[[ENPlayback shared] playURI:t.uri];
}

- (void)loadMore {
	if (_loadingMore || _next < 0 || !_query.length) return;
	_loadingMore = YES;
	[self reloadMoreRow];
	NSInteger offset = _next;
	__weak ENSearchSongsViewController *w = self;
	[[ENCatalog shared] search:_query offset:offset done:^(id result, BOOL fromCache, NSError *error) {
		ENSearchSongsViewController *s = w;
		if (!s) return;
		s->_loadingMore = NO;
		if (error || ![result isKindOfClass:[ENSearchResult class]]) {
			if (error) [s showError:error];
			[s reloadMoreRow];
			return;
		}
		ENSearchResult *r = result;
		[s hideBanner];
		NSUInteger from = s->_tracks.count;
		[s->_tracks addObjectsFromArray:r.tracks ?: @[]];
		s->_next = r.tracksNext > offset ? r.tracksNext : -1;     // never ask for the same page twice
		if (s.isViewLoaded) {
			[s.tableView reloadData];
			if (s->_tracks.count > from) [s.tableView flashScrollIndicators];
		}
	}];
}

- (void)reloadMoreRow {
	if (!self.isViewLoaded || _next < 0) return;
	NSIndexPath *ip = [NSIndexPath indexPathForRow:(NSInteger)_tracks.count inSection:0];
	[self.tableView reloadRowsAtIndexPaths:@[ ip ] withRowAnimation:UITableViewRowAnimationNone];
}

@end

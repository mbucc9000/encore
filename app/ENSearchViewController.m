#import "ENSearchViewController.h"
#import "ENTheme.h"
#import "ENModel.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENTrackListViewController.h"
#import "ENArtistViewController.h"
#import "ENSearchSongsViewController.h"
#import "ENTrackActions.h"
#import "ENRecents.h"
#import "ENUtil.h"
#import "ENProfileViewController.h"
#import "ENPeopleViewController.h"
#import "ENUserRows.h"
#import "ENDiag.h"
#import "ENTabBarController.h"
#import "ENAnon.h"

#pragma mark - "Add songs" (0.9.3, DESIGN-JAM-UI): the pages it pushes, their song rows adding to the Jam

// See all songs: a song row adds it (the ••• Add to Jam's path and HUD) and, like the plain page's play, goes first in
// "Recent searches" (0.9.5); "Load 10 more…" is the page's own.
@interface ENJamPickSongsViewController : ENSearchSongsViewController
@end

@implementation ENJamPickSongsViewController
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	ENTrack *t = [self trackAtIndexPath:ip];
	if (!t) {
		[super tableView:tableView didSelectRowAtIndexPath:ip];
		return;
	}
	[tableView deselectRowAtIndexPath:ip animated:YES];
	if (!t.playable) return;
	[ENRecents add:t];
	[ENTrackActions addToQueue:t];
}
@end

// An album or a playlist: a song row adds it; the header's Play / Shuffle still play.
@interface ENJamPickTrackListViewController : ENTrackListViewController
@end

@implementation ENJamPickTrackListViewController
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	ENTrack *t = [self trackAtIndexPath:ip];
	if (!t) {
		[super tableView:tableView didSelectRowAtIndexPath:ip];
		return;
	}
	[tableView deselectRowAtIndexPath:ip animated:YES];
	if (t.playable) [ENTrackActions addToQueue:t];
}
@end

// An artist: a Popular song adds it; an album opens the album's page in the same "add" version.
@interface ENJamPickArtistViewController : ENArtistViewController
@end

@implementation ENJamPickArtistViewController
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	ENTrack *t = [self trackAtIndexPath:ip];
	UITableViewCell *cell = t ? nil : [tableView cellForRowAtIndexPath:ip];
	id item = [cell isKindOfClass:[ENListCell class]] ? ((ENListCell *)cell).item : nil;
	if (!t && ![item isKindOfClass:[ENAlbumRow class]]) {
		[super tableView:tableView didSelectRowAtIndexPath:ip];
		return;
	}
	[tableView deselectRowAtIndexPath:ip animated:YES];
	if (t) {
		if (t.playable) [ENTrackActions addToQueue:t];
		return;
	}
	ENJamPickTrackListViewController *vc = [[ENJamPickTrackListViewController alloc] initWithAlbum:item];
	vc.ignoresMiniPlayer = YES;
	[self.navigationController pushViewController:vc animated:YES];
}
@end

#pragma mark - Search

static NSString *const ENSeeAllRow = @"<see all songs>";      // compared by identity in the Songs section
static NSString *const ENSeeAllProfilesRow = @"<see all profiles>";   // (0.11) the same in the Profiles section
static NSString *const ENRecentsHint = @"Your recent searches show up here";    // (0.9.5) the footer while there are none
// (3c, C4; mockup .empty under the recents) Search's hint under the recents, the empty state's look as the table's footer
// (-setFooterTitle:message:); with no recents its message ends with ENRecentsHint. Not in "Add songs" (songs are added there,
// not played): that sheet keeps the 0.9.5 footer.
static NSString *const ENSearchHintTitle = @"Search all of Spotify";
static NSString *const ENSearchHintBody = @"Songs play instantly. Tap ••• on any song to add it to a playlist.";

// (3c, C4) the UISearchBar's 6.1 text field (UISearchBarTextField), found with a class check; nil = an unexpected hierarchy
static UITextField *ENSearchFieldIn(UIView *v, NSUInteger depth) {
	if (depth > 3) return nil;
	for (UIView *s in v.subviews) {
		if ([s isKindOfClass:[UITextField class]]) return (UITextField *)s;
		UITextField *f = ENSearchFieldIn(s, depth + 1);
		if (f) return f;
	}
	return nil;
}

// a recent row's model -> its uri (the five kinds ENRecents keeps; 0.11: + people)
static NSString *ENItemURI(id item) {
	if ([item isKindOfClass:[ENTrack class]]) return ((ENTrack *)item).uri;
	if ([item isKindOfClass:[ENArtistRow class]]) return ((ENArtistRow *)item).uri;
	if ([item isKindOfClass:[ENAlbumRow class]]) return ((ENAlbumRow *)item).uri;
	if ([item isKindOfClass:[ENPlaylist class]]) return ((ENPlaylist *)item).uri;
	if ([item isKindOfClass:[ENUserRow class]]) return ((ENUserRow *)item).uri;
	return nil;
}

// (0.11) ENSecProfiles: people found for the query (0.11.1: after Artists, or right after the Top Result when one of them is
// named the query; -profilesIndexIn:); ENSecProfile: the one row of a pasted profile link
typedef enum { ENSecRecent, ENSecTop, ENSecSongs, ENSecArtists, ENSecAlbums, ENSecPlaylists, ENSecProfiles, ENSecProfile } ENSecKind;

// (0.11.1) a person's name "is" the query: any case, any accents, runs of spaces as one ("Zoë" for "zoe")
static NSString *ENSquashedSpaces(NSString *s) {
	NSMutableArray *words = [NSMutableArray array];
	for (NSString *w in [s componentsSeparatedByCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]])
		if (w.length) [words addObject:w];
	return [words componentsJoinedByString:@" "];
}

static BOOL ENNameIsQuery(NSString *name, NSString *q) {
	NSString *a = ENSquashedSpaces(name ?: @""), *b = ENSquashedSpaces(q ?: @"");
	return a.length && b.length && [a compare:b options:(NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch)] == NSOrderedSame;
}

// (0.11.1) a Top Result's name (a song, an artist or an album)
static NSString *ENTopName(id item) {
	if ([item isKindOfClass:[ENTrack class]]) return ((ENTrack *)item).name;
	if ([item isKindOfClass:[ENArtistRow class]]) return ((ENArtistRow *)item).name;
	if ([item isKindOfClass:[ENAlbumRow class]]) return ((ENAlbumRow *)item).name;
	return nil;
}

@interface ENSearchSection : NSObject
@property (nonatomic) ENSecKind kind;
@property (nonatomic, copy) NSString *title;
@property (nonatomic, copy) NSArray *rows;
+ (instancetype)kind:(ENSecKind)kind title:(NSString *)title rows:(NSArray *)rows;
@end

@implementation ENSearchSection
+ (instancetype)kind:(ENSecKind)kind title:(NSString *)title rows:(NSArray *)rows {
	ENSearchSection *s = [[ENSearchSection alloc] init];
	s.kind = kind;
	s.title = title;
	s.rows = rows;
	return s;
}
@end

@implementation ENSearchViewController {
	UISearchBar *_searchBar;
	NSArray *_sections;             // ENSearchSection
	ENSearchResult *_result;        // the answer shown (nil = Recent searches)
	NSString *_shownQuery;          // the query _result answers
	NSString *_askedQuery;          // in flight
	NSUInteger _seq;                // drops replies for older queries
	BOOL _forJam;                   // (0.9.3) the Jam's "Add songs" sheet: song rows add instead of playing
	BOOL _focused;                  // the sheet's field has been focused once
	BOOL _showingRecents;           // (0.9.5) the rows are "Recent searches" (the empty field)
	BOOL _recentsDirty;             // ENRecents changed since they were built: rebuilt on the next viewWillAppear:
	ENRowList *_users;              // (0.11) the people found for _usersQuery (the Profiles section; first page)
	NSString *_usersQuery;
	NSString *_linkURI;             // (0.11) a pasted profile link's spotify:user: uri (nil: a normal search)
	ENUserRow *_linkUser;           // its row: the id until loadUser: answers, then the person
	NSInteger _linkState;           // 0 opening ("Open profile"), 1 found ("Profile"), 2 not available
	CFAbsoluteTime _fadeAt;         // (0.11.2) when the last Profiles fade began (its content height comes at its end)
	BOOL _keyboardUp;               // (0.11.2) between UIKeyboardWillShow and UIKeyboardWillHide (any keyboard)
	BOOL _debouncing;               // (3c) a runSearch is scheduled (the 380 ms debounce): the field's spinner shows
	UIView *_fieldSpinBox;          // (3c) the field's rightView while it spins: a clear 28 x 22 pt box with the spinner
	UIActivityIndicatorView *_fieldSpin;
}

- (id)initWithStyle:(UITableViewStyle)style {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		self.title = @"Search";
		self.refreshable = NO;
		self.meterName = @"search";
		_sections = @[];
		[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(recentsChanged:)
		                                             name:ENRecentsChangedNotification object:nil];
		// (R2a) Anonymous Mode switched: the recents are built again (people leave or come back)
		[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(recentsChanged:)
		                                             name:ENAnonChangedNotification object:nil];
		NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];        // (0.11.2) the keyboard, for the scroll range
		[nc addObserver:self selector:@selector(keyboardWillShow:) name:UIKeyboardWillShowNotification object:nil];
		[nc addObserver:self selector:@selector(keyboardWillHide:) name:UIKeyboardWillHideNotification object:nil];
		[nc addObserver:self selector:@selector(keyboardDidHide:) name:UIKeyboardDidHideNotification object:nil];
	}
	return self;
}

- (instancetype)initForJam {
	if ((self = [self initWithStyle:UITableViewStylePlain])) {
		_forJam = YES;
		self.title = @"Add songs";
		self.meterName = @"jam add";
		self.ignoresMiniPlayer = YES;          // a sheet: no mini player under it
	}
	return self;
}

- (void)dealloc {
	_searchBar.delegate = nil;
}

- (void)viewDidLoad {
	[super viewDidLoad];
	_searchBar = [[UISearchBar alloc] initWithFrame:CGRectMake(0, 0, 320, 44)];
	_searchBar.tintColor = [ENTheme current].navTint;
	_searchBar.autocorrectionType = UITextAutocorrectionTypeNo;
	_searchBar.autocapitalizationType = UITextAutocapitalizationTypeNone;
	_searchBar.delegate = self;
	if (_forJam) {                             // the title shows, Done at the left, the field heads the rows
		_searchBar.frame = CGRectMake(0, 0, self.tableView.bounds.size.width ?: 320, 44);
		_searchBar.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		_searchBar.backgroundImage = [ENTheme current].filterBarBackground;
		_searchBar.placeholder = @"Find songs to add";
		self.tableView.tableHeaderView = _searchBar;
		UIBarButtonItem *done = [[UIBarButtonItem alloc] initWithTitle:@"Done" style:UIBarButtonItemStyleDone
		                                                        target:self action:@selector(closeSheet)];
		[ENTheme skinBarItem:done];          // (1.1) iOS 5: the Done look on the item itself
		self.navigationItem.leftBarButtonItem = done;
	} else {
		_searchBar.backgroundImage = [ENTheme imageOfSize:CGSizeMake(1, 1) opaque:NO drawing:nil];    // the nav bar shows through
		_searchBar.placeholder = @"Songs, artists, albums, playlists";
		self.navigationItem.titleView = _searchBar;
	}
	[self showRecents];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	if (_showingRecents && _recentsDirty) [self reloadRecents];
}

- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	if (!_forJam || _focused) return;
	_focused = YES;                            // the sheet opens ready to type, once
	[_searchBar becomeFirstResponder];
}

- (void)closeSheet {
	if (_searchBar.isFirstResponder) [_searchBar resignFirstResponder];
	[self dismissViewControllerAnimated:YES completion:nil];
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	if (_searchBar.isFirstResponder) [_searchBar resignFirstResponder];
}

- (NSString *)typedQuery {
	NSString *q = [_searchBar.text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	return q.length > 100 ? [q substringToIndex:100] : q;
}

#pragma mark - recent searches (0.9.5: the items tapped here, ENRecents: 20, newest first)

- (void)showRecents {
	_result = nil;
	_shownQuery = nil;
	_linkURI = nil;                            // (0.11)
	_linkUser = nil;
	[self setBusy:NO];
	[self setEmptyTitle:nil message:nil];
	[self hideBanner];
	[self reloadRecents];
}

- (void)reloadRecents {
	_showingRecents = YES;
	_recentsDirty = NO;
	NSArray *items = [ENRecents items];
	// (0.11) "Add songs" has no people in it; (R2a) nor has Search while Anonymous Mode is on (D1: people in Recent searches)
	if (_forJam || [ENAnon on]) {
		NSMutableArray *keep = [NSMutableArray arrayWithCapacity:items.count];
		for (id x in items) if (![x isKindOfClass:[ENUserRow class]]) [keep addObject:x];
		items = keep;
	}
	_sections = items.count ? @[ [ENSearchSection kind:ENSecRecent title:@"Recent searches" rows:items] ] : @[];
	[self showRecentsHint:!items.count];      // (the Jam sheet's "saved copy" footer belongs to results)
	[self.tableView reloadData];
}

// (3c, C4) the footer under the recents. Search: "Search all of Spotify" over "Songs play instantly. Tap ••• …" (with none,
// "Your recent searches show up here." after it). "Add songs": the 0.9.5 footer, only while there are none.
- (void)showRecentsHint:(BOOL)none {
	if (_forJam) {
		self.footerText = none ? ENRecentsHint : nil;
		return;
	}
	[self setFooterTitle:ENSearchHintTitle
	             message:(none ? [NSString stringWithFormat:@"%@ %@.", ENSearchHintBody, ENRecentsHint] : ENSearchHintBody)];
}

// (3c) leaving the recents: no hint under the results (they have no footer, but "Add songs"' "Showing a saved copy")
- (void)hideRecentsHint {
	self.footerText = nil;
	[self setFooterTitle:nil message:nil];
}

// Every change only marks the list: the screen's own changes (×, Clear) update the rows themselves, and an item tapped
// again here moves to the top when the list is next built (coming back to the screen, or the field cleared), not under
// the finger.
- (void)recentsChanged:(NSNotification *)note {
	_recentsDirty = YES;
	// (R2a) Anonymous Mode switched while the recents are up (Settings is another tab, so normally hidden): build them now
	if ([note.name isEqualToString:ENAnonChangedNotification] && _showingRecents && self.isViewLoaded && self.view.window) [self reloadRecents];
}

- (void)clearRecents {
	NSInteger sec = -1;
	for (NSUInteger i = 0; i < _sections.count; i++)
		if (((ENSearchSection *)_sections[i]).kind == ENSecRecent) sec = (NSInteger)i;
	[ENRecents clear];
	if (sec < 0 || !self.isViewLoaded) return;
	NSMutableArray *secs = [_sections mutableCopy];
	[secs removeObjectAtIndex:(NSUInteger)sec];
	_sections = secs;
	[self.tableView deleteSections:[NSIndexSet indexSetWithIndex:(NSUInteger)sec] withRowAnimation:UITableViewRowAnimationFade];
	[self showRecentsHint:YES];
}

// a recent row's ×: that row goes (animated; the section and its header with the last one), then the item from ENRecents
- (void)removeRecentAt:(NSIndexPath *)ip {
	ENSearchSection *sec = [self sectionAt:ip.section];
	NSString *uri = ENItemURI([self itemAt:ip]);
	if (sec.kind != ENSecRecent || !uri) return;
	UITableView *tv = self.tableView;
	NSMutableArray *rows = [sec.rows mutableCopy];
	[rows removeObjectAtIndex:(NSUInteger)ip.row];
	if (rows.count) {
		sec.rows = rows;
		[tv deleteRowsAtIndexPaths:@[ ip ] withRowAnimation:UITableViewRowAnimationFade];
	} else {
		NSMutableArray *secs = [_sections mutableCopy];
		[secs removeObjectAtIndex:(NSUInteger)ip.section];
		_sections = secs;
		[tv deleteSections:[NSIndexSet indexSetWithIndex:(NSUInteger)ip.section] withRowAnimation:UITableViewRowAnimationFade];
		[self showRecentsHint:YES];
	}
	[ENRecents removeURI:uri];
}

#pragma mark - searching (debounced 380 ms; a sequence number drops stale replies)

- (void)searchBar:(UISearchBar *)searchBar textDidChange:(NSString *)text {
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(runSearch) object:nil];
	if (![self typedQuery].length) {
		_seq++;
		_askedQuery = nil;
		_debouncing = NO;                      // (3c)
		[self updateFieldSpinner];
		[self showRecents];
		return;
	}
	[self performSelector:@selector(runSearch) withObject:nil afterDelay:0.38];
	_debouncing = YES;                         // (3c) the field's spinner, from this keystroke
	[self updateFieldSpinner];
}

- (void)searchBarSearchButtonClicked:(UISearchBar *)searchBar {
	[searchBar resignFirstResponder];
	[self runSearch];
	if (_linkURI && _linkUser && _linkState != 2) [self openUser:_linkUser record:(_linkState == 1)];   // (0.11) a pasted link
}

- (void)searchBarTextDidBeginEditing:(UISearchBar *)searchBar { [searchBar setShowsCancelButton:YES animated:YES]; }
- (void)searchBarTextDidEndEditing:(UISearchBar *)searchBar { [searchBar setShowsCancelButton:NO animated:YES]; }

- (void)searchBarCancelButtonClicked:(UISearchBar *)searchBar {
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(runSearch) object:nil];
	searchBar.text = @"";
	[searchBar resignFirstResponder];
	_seq++;
	_askedQuery = nil;
	_debouncing = NO;                          // (3c)
	[self updateFieldSpinner];
	[self showRecents];
}

// (3c) the debounce ended (or Search was pressed): the search itself (-startSearch, 0.11.2's runSearch body unchanged), then
// the field's spinner stops (the debounce is over; the × is back while the search is out)
- (void)runSearch {
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(runSearch) object:nil];
	_debouncing = NO;
	[self startSearch];
	[self updateFieldSpinner];
}

- (void)startSearch {
	NSString *q = [self typedQuery];
	if (!q.length) return;
	ENCatalog *cat = [ENCatalog shared];
	// (0.11) a pasted profile link (open.spotify.com/user/… or spotify:user:…): its one Profile row, no catalog search
	NSString *link = !_forJam && cat.profilesAvailable ? ENUserURIFromLink(_searchBar.text) : nil;
	if (link) {
		[self showLink:link];
		return;
	}
	if (_linkURI) {                            // typed on from a link: a normal search again
		_linkURI = nil;
		_linkUser = nil;
		_sections = @[];
		[self.tableView reloadData];
	}
	if ([q isEqualToString:_askedQuery]) return;
	if (_result && [q isEqualToString:_shownQuery]) {        // on screen already; its people may have been skipped (below)
		if (_askedQuery) {                     // (0.11.1) typed back to it: the newer search's reply must not replace it
			_seq++;
			_askedQuery = nil;
			[self setBusy:NO];
		}
		[self searchPeople:q seq:_seq];
		return;
	}
	NSUInteger seq = ++_seq;
	_askedQuery = q;
	if (!_result) {
		_showingRecents = NO;
		_sections = @[];
		[self hideRecentsHint];                // the recents' hint (3c: or Search's "Search all of Spotify")
		[self setEmptyTitle:nil message:nil];
		[self.tableView reloadData];
		[self setBusy:YES];
	}
	__weak ENSearchViewController *w = self;
	[[ENCatalog shared] search:q offset:0 done:^(id result, BOOL fromCache, NSError *error) {
		ENSearchViewController *s = w;
		if (!s || seq != s->_seq) return;
		s->_askedQuery = nil;
		[s setBusy:NO];
		[s updateFieldSpinner];                // (3c) answered: no change unless a newer debounce runs (then it keeps spinning)
		if (error) {
			[s showError:error];
			return;
		}
		[s hideBanner];
		if ([result isKindOfClass:[ENSearchResult class]]) [s showResult:result query:q];
		if ([[s typedQuery] isEqualToString:q]) [s searchPeople:q seq:seq];
	}];
}

// (0.11) The people for 2+ characters, under the search's sequence number; a failure is silent (no Profiles section).
// Asked once the song search has answered, and only while the field still says q: each people search costs one of the
// gateway's private-API starts (1 s apart, 60 per 5 min, shared with the profile pages), so a prefix typed past is never sent.
- (void)searchPeople:(NSString *)q seq:(NSUInteger)seq {
	ENCatalog *cat = [ENCatalog shared];
	if (_forJam || q.length < 2 || !cat.profilesAvailable || (_users && [_usersQuery isEqualToString:q])) return;
	__weak ENSearchViewController *w = self;
	[cat searchUsers:q offset:0 done:^(id result, BOOL fromCache, NSError *error) {
		ENSearchViewController *s = w;
		if (!s || seq != s->_seq || error || ![result isKindOfClass:[ENRowList class]]) return;
		[s usersArrived:result query:q];
	}];
}

- (void)showResult:(ENSearchResult *)r query:(NSString *)q {
	_result = r;
	_shownQuery = q;
	_showingRecents = NO;
	NSMutableArray *secs = [NSMutableArray array];
	NSString *topURI = nil;
	if (r.top && r.topKind != ENSearchTopNone) {
		[secs addObject:[ENSearchSection kind:ENSecTop title:@"Top Result" rows:@[ r.top ]]];
		if (r.topKind == ENSearchTopTrack && [r.top isKindOfClass:[ENTrack class]]) topURI = ((ENTrack *)r.top).uri;
	}
	NSMutableArray *songs = [NSMutableArray array];
	for (ENTrack *t in r.tracks) {
		if (songs.count == 5) break;
		if (topURI && [t.uri isEqualToString:topURI]) continue;
		[songs addObject:t];
	}
	if (songs.count) {
		if (r.tracksNext >= 0 || r.tracksTotal > (NSInteger)songs.count || r.tracks.count > songs.count) [songs addObject:ENSeeAllRow];
		[secs addObject:[ENSearchSection kind:ENSecSongs title:@"Songs" rows:songs]];
	}
	if (r.artists.count) [secs addObject:[ENSearchSection kind:ENSecArtists title:@"Artists" rows:[self first:3 of:r.artists]]];
	if (r.albums.count) [secs addObject:[ENSearchSection kind:ENSecAlbums title:@"Albums" rows:[self first:3 of:r.albums]]];
	if (r.playlists.count) [secs addObject:[ENSearchSection kind:ENSecPlaylists title:@"Playlists" rows:[self first:3 of:r.playlists]]];
	if (_users.items.count && [_usersQuery isEqualToString:q]) {          // (0.11.1) the people already here: at their place
		NSUInteger at = [self profilesIndexIn:secs];
		[secs insertObject:[self profilesSection] atIndex:at];
		ENLog(@"search: profiles section at %lu of %lu (with the result)", (unsigned long)at, (unsigned long)secs.count);
	}
	_sections = secs;
	if (secs.count) [self setEmptyTitle:nil message:nil];         // (3c) the mockup's "No results" over "Nothing found for “q”."
	else [self setEmptyTitle:@"No results" message:[NSString stringWithFormat:@"Nothing found for “%@”.", q]];
	if (_forJam) self.footerText = r.stale ? @"Showing a saved copy" : nil;     // the banner would cover the field
	else if (r.stale) [self showBanner:@"Showing a saved copy"];
	[self.tableView reloadData];
	[self.tableView setContentOffset:CGPointMake(0, -self.tableView.contentInset.top) animated:NO];
}

// (0.9.3) In "Add songs" the field heads the rows, where the floating banner would sit over it: a failed search takes the
// rows' place instead (the empty text; typing again or Search retries). Elsewhere the base's banner over the rows.
- (void)showError:(NSError *)error {
	if (!_forJam) {
		[super showError:error];
		return;
	}
	_result = nil;
	_shownQuery = nil;
	_showingRecents = NO;
	_sections = @[];
	self.footerText = nil;
	[self.tableView reloadData];
	[self setEmptyTitle:[ENCatalog messageForError:error] message:nil];      // (3c: the same title-only look as before)
}

- (NSArray *)first:(NSUInteger)n of:(NSArray *)a {
	return a.count > n ? [a subarrayWithRange:NSMakeRange(0, n)] : a;
}

#pragma mark - the field's spinner (3c, C4; DESIGN-5 §2.3, §2.4 #9)

// A 16 pt spinner inside the field during each 380 ms debounce only (§2.3 C4), off once the search goes out so the × is back
// for the network wait. The table's centred spinner still shows only while there is no result yet (-startSearch).
// It is the 6.1 text field's rightView (rightViewMode Always): iOS 6.1 shows a right view instead of the clear button
// (-[UITextField _showsClearButtonWhenNonEmpty:] answers NO while -_showsRightView is YES), so the spinner takes the ×'s
// place and the × is back when it stops. The box is the ×'s footprint (its 19 pt + 9 pt margin; 22 pt tall, centred like it)
// with the spinner where the × sits. Only rightView / rightViewMode change (UITextField just lays out again): the field keeps
// the first responder, the keyboard, the text and the caret. No field found, or a right view that isn't ours: no spinner.
- (void)updateFieldSpinner {
	if (!_searchBar) return;
	BOOL on = _debouncing;
	UITextField *f = ENSearchFieldIn(_searchBar, 0);
	if (!f || (f.rightView && f.rightView != _fieldSpinBox)) return;
	if (on) {
		if (!_fieldSpinBox) {
			_fieldSpinBox = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 28, 22)];
			_fieldSpinBox.backgroundColor = [UIColor clearColor];
			_fieldSpinBox.opaque = NO;
			_fieldSpinBox.userInteractionEnabled = NO;
			_fieldSpin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:[ENTheme current].spinnerStyle];
			_fieldSpin.transform = CGAffineTransformMakeScale(0.8f, 0.8f);      // 20 pt -> 16 pt
			_fieldSpin.center = CGPointMake(9.5f, 9);                           // the ×'s centre (6.1: it sits 1 pt higher)
			_fieldSpin.hidesWhenStopped = YES;
			_fieldSpin.userInteractionEnabled = NO;
			[_fieldSpinBox addSubview:_fieldSpin];
		}
		if (f.rightView != _fieldSpinBox) f.rightView = _fieldSpinBox;
		if (f.rightViewMode != UITextFieldViewModeAlways) f.rightViewMode = UITextFieldViewModeAlways;
		if (!_fieldSpin.isAnimating) [_fieldSpin startAnimating];
	} else if (f.rightView == _fieldSpinBox) {
		[_fieldSpin stopAnimating];
		f.rightViewMode = UITextFieldViewModeNever;      // as UISearchBar leaves it without a bookmark / results button
		f.rightView = nil;
	}
}

#pragma mark - people (0.11, DESIGN-PROFILES §4.4)

// Profiles: the first 3 people, then "See all profiles" when there are more (total > 3 or a next page). (0.11.1) Like Spotify,
// a person whose name is the query (any case, any accents) leads; the others keep the gateway's order. "See all profiles"
// shows the gateway's page as it came.
- (ENSearchSection *)profilesSection {
	NSMutableArray *people = [NSMutableArray arrayWithCapacity:_users.items.count];
	NSMutableArray *others = [NSMutableArray arrayWithCapacity:_users.items.count];
	for (id x in _users.items) {
		// (R2a) the real name decides the order, so the sections stay put when Anonymous Mode switches
		BOOL named = [x isKindOfClass:[ENUserRow class]] && ENNameIsQuery(((ENUserRow *)x).rawName, _usersQuery);
		[(named ? people : others) addObject:x];
	}
	[people addObjectsFromArray:others];
	NSMutableArray *rows = [NSMutableArray arrayWithArray:[self first:3 of:people]];
	if (_users.total > 3 || _users.next >= 0 || _users.items.count > 3) [rows addObject:ENSeeAllProfilesRow];
	return [ENSearchSection kind:ENSecProfiles title:@"Profiles" rows:rows];
}

// (0.11.1) where Profiles goes among the result's sections. When one of the people is named the query (ENNameIsQuery, as
// Spotify puts a person named what was typed high), they lead: right after the Top Result (else first), on the first screen
// even with the keyboard up (the header at 82 pt, the three people at 104 … 236, of the 288 pt the keyboard leaves). Not when
// the Top Result is named the query too (an artist, song or album of that name: the music stays first), and not otherwise:
// then right after Artists, else after Songs, else after the Top Result, else first (before Albums and Playlists).
- (NSUInteger)profilesIndexIn:(NSArray *)secs {
	BOOL lead = NO;
	for (id x in _users.items)
		if ([x isKindOfClass:[ENUserRow class]] && ENNameIsQuery(((ENUserRow *)x).rawName, _usersQuery)) lead = YES;
	for (ENSearchSection *sec in secs)
		if (sec.kind == ENSecTop && sec.rows.count && ENNameIsQuery(ENTopName(sec.rows[0]), _usersQuery)) lead = NO;
	NSUInteger at = 0;
	for (NSUInteger i = 0; i < secs.count; i++) {
		ENSecKind k = ((ENSearchSection *)secs[i]).kind;
		if (k == ENSecTop || (!lead && (k == ENSecSongs || k == ENSecArtists))) at = i + 1;
	}
	return at;
}

// The people search answered for q: -showResult:query: takes them when the result comes, or, when the result for q is already
// on screen, -placeLateProfiles puts the section in.
- (void)usersArrived:(ENRowList *)users query:(NSString *)q {
	if (!users.items.count) return;           // nobody: no section
	_users = users;
	_usersQuery = [q copy];
	[self placeLateProfiles];
}

// (0.11.1) The people came after the result for their query is on screen: the section goes in at its place (a "Nothing found"
// makes way) without moving a row that may be about to be tapped, and never unseen without a sign:
//   - its place is below the visible rows: it fades in there (nothing on screen moves);
//   - the list rests at the top (as the result left it) and its place is among the visible rows: it fades in there, the rows
//     under it slide down (the people show on the first screen);
//   - the list rests scrolled past its place: it goes in unanimated (0.11.2: by reloadData, with the offset clamped to the
//     scroll range; 0.11.1's insertSections: with animations off measured the new height at once too), the offset grows by
//     its height so the rows on screen stay put, and the scroll indicators flash (there is more above);
//   - otherwise (scrolled with its place among the visible rows, a finger on the list, or moving) it waits, and this runs
//     again when the scrolling stops (the scroll view delegate methods below).
- (void)placeLateProfiles {
	if (_showingRecents || _linkURI || !_result || !_users.items.count || ![_usersQuery isEqualToString:_shownQuery] ||
	    !self.isViewLoaded) return;
	for (ENSearchSection *sec in _sections) if (sec.kind == ENSecProfiles) return;
	UITableView *tv = self.tableView;
	NSUInteger at = [self profilesIndexIn:_sections];
	CGFloat y = at ? CGRectGetMaxY([tv rectForSection:(NSInteger)at - 1]) : 0;     // where it starts, measured before
	CGFloat top = tv.contentOffset.y + tv.contentInset.top;                       // the visible rows (content y)
	CGFloat bottom = tv.contentOffset.y + tv.bounds.size.height - tv.contentInset.bottom;
	BOOL still = !tv.tracking && !tv.dragging && !tv.decelerating;
	BOOL below = y >= bottom, above = still && top > 0 && y <= top;
	if (!below && !above && !(still && top <= 0)) {
		ENLog(@"search: profiles section waits (its place is on screen, the list is scrolled or moving)");
		if (tv.tracking && !tv.dragging && !tv.decelerating) [self placeLateProfilesAfter:0.5];   // a tap: no scroll end comes
		return;
	}
	NSMutableArray *secs = [NSMutableArray arrayWithArray:_sections];
	[secs insertObject:[self profilesSection] atIndex:at];
	_sections = secs;
	[self setEmptyTitle:nil message:nil];
	CGFloat shift = 0;
	if (above) {                              // scrolled past its place: keep what is on screen where it is
		// (0.11.2) reloadData (unanimated by nature: no global animation switch) and the grown offset clamped to the scroll
		// range. Not the fix for "doesn't scroll down all the way": 0.11.1's insert set the content height at once as well.
		CGFloat from = tv.contentOffset.y;
		[tv reloadData];
		shift = [tv rectForSection:(NSInteger)at].size.height;
		CGFloat minY = -tv.contentInset.top;
		CGFloat maxY = MAX(tv.contentSize.height + tv.contentInset.bottom - tv.bounds.size.height, minY);
		tv.contentOffset = CGPointMake(tv.contentOffset.x, MIN(MAX(from + shift, minY), maxY));
		[tv flashScrollIndicators];
	} else {
		_fadeAt = CFAbsoluteTimeGetCurrent();
		[tv insertSections:[NSIndexSet indexSetWithIndex:at] withRowAnimation:UITableViewRowAnimationFade];
		[self performSelector:@selector(profilesFadeSettled) withObject:nil afterDelay:0.5];     // (0.11.2)
	}
	ENLog(@"search: profiles section at %lu of %lu (late%@)", (unsigned long)at, (unsigned long)secs.count,
		shift > 0 ? [NSString stringWithFormat:@", above the visible rows: offset +%.0f", shift] : @"");
	if (above) [self logScrollRange:@"profiles placed above"];
}

// (0.11.1) -placeLateProfiles again a little later: UIScrollView may still say tracking / decelerating inside its own "ended"
// callbacks
- (void)placeLateProfilesAfter:(NSTimeInterval)delay {
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(placeLateProfiles) object:nil];
	[self performSelector:@selector(placeLateProfiles) withObject:nil afterDelay:delay];
}

#pragma mark - the scroll range (0.11.2)

// 0.11.1 was reported not to scroll down to the last row. The cause is not known yet: the unanimated Profiles insert set
// the content height at once (UIKit 6.1 sends an update's "did stop" synchronously when nothing animates), so its offset
// shift stayed in range. So the screen logs the terms of the range (numbers only, never a name or the query) at every
// scroll end and after each late placement, and corrects the two that can come out short: the bottom inset after the
// keyboard (-raiseBottomInset) and the content height (-fixScrollRange).

// one line: content height, bottom insets (content / indicators), the table's height and where its bottom edge is on
// screen (against the tab bar's top), the offset against its maximum, the bars' height, the keyboard
- (void)logScrollRange:(NSString *)why {
	if (!self.isViewLoaded) return;
	UITableView *tv = self.tableView;
	ENTabBarController *tab = [ENTabBarController shared];
	UIView *bar = tab.tabBar;
	UIEdgeInsets in = tv.contentInset;
	CGFloat h = tv.bounds.size.height;
	CGFloat maxY = MAX(tv.contentSize.height + in.bottom - h, -in.top);
	CGFloat edge = tv.window ? CGRectGetMaxY([tv convertRect:tv.bounds toView:nil]) : -1;
	CGFloat barTop = bar.window ? CGRectGetMinY([bar convertRect:bar.bounds toView:nil]) : -1;
	ENLog(@"search: range (%@): content %.0f, inset %.0f/%.0f, height %.0f (bottom at %.0f, tab bar at %.0f), offset %.0f "
	      @"of %.0f, bars %.0f, keyboard %@, sections %ld", why, tv.contentSize.height, in.bottom, tv.scrollIndicatorInsets.bottom,
	      h, edge, barTop, tv.contentOffset.y, maxY, self.ignoresMiniPlayer ? 0 : tab.miniPlayerHeight,
	      _keyboardUp ? @"up" : @"down", (long)[tv numberOfSections]);
}

// The scrolling stopped (or a drag begins): the range as it is, then the corrections (each logs what it changes)
- (void)checkScrollRange:(NSString *)why {
	if (!self.isViewLoaded) return;
	if (why) [self logScrollRange:why];
	[self raiseBottomInset];
	[self fixScrollRange];
}

// half a second after a Profiles fade began (UITableView's update animation is 0.3 s and sets the content height at its end)
- (void)profilesFadeSettled {
	[self checkScrollRange:@"after the profiles fade"];
}

// The content height reaches where the last section (and the footer) ends: when it falls short, a reloadData (which sets
// it at once) puts it right, the offset kept. Never within 0.45 s of a Profiles fade: until that animation ends the content
// height is the old one by design while the new section is already measured (-profilesFadeSettled checks after it).
- (void)fixScrollRange {
	if (!self.isViewLoaded || CFAbsoluteTimeGetCurrent() - _fadeAt < 0.45) return;
	UITableView *tv = self.tableView;
	NSInteger n = [tv numberOfSections];
	if (n < 1) return;
	CGFloat need = CGRectGetMaxY([tv rectForSection:n - 1]) + tv.tableFooterView.bounds.size.height;
	if (tv.contentSize.height + 0.5f >= need) return;
	ENLog(@"search: content height %.0f short of %.0f (offset %.0f, inset %.0f, height %.0f): measured again",
	      tv.contentSize.height, need, tv.contentOffset.y, tv.contentInset.bottom, tv.bounds.size.height);
	CGPoint o = tv.contentOffset;
	[tv reloadData];
	tv.contentOffset = o;
}

- (void)keyboardWillShow:(NSNotification *)note { _keyboardUp = YES; }
- (void)keyboardWillHide:(NSNotification *)note { _keyboardUp = NO; }

// UITableViewController adds the keyboard's overlap to contentInset.bottom and later takes it off by difference (6.1.2:
// -_adjustForAutomaticKeyboardInfo:animated:lastAdjustment:, the hide's share run one turn after UIKeyboardWillHide), so a
// bottom inset set to the bars' height while the keyboard was up (the mini player or the Jam / Connect bar changing under
// it) comes out short of the bars, or negative, and the last rows can't be scrolled into view. Checked a turn after the
// keyboard has gone (after UIKit's own share) and at every scroll end.
- (void)keyboardDidHide:(NSNotification *)note {
	[self performSelector:@selector(raiseBottomInset) withObject:nil afterDelay:0 inModes:@[ NSRunLoopCommonModes ]];
}

// with the keyboard down, the rows end above the mini player and the Jam / Connect bar (0 with ignoresMiniPlayer): a
// shorter bottom inset is raised to the bars' height (a taller one is left alone)
- (void)raiseBottomInset {
	if (!self.isViewLoaded || !self.view.window || _keyboardUp) return;
	CGFloat h = self.ignoresMiniPlayer ? 0 : [ENTabBarController shared].miniPlayerHeight;
	UITableView *tv = self.tableView;
	UIEdgeInsets in = tv.contentInset, si = tv.scrollIndicatorInsets;
	if (in.bottom < h) {
		ENLog(@"search: bottom inset %.0f with the keyboard down, set to %.0f", in.bottom, h);
		in.bottom = h;
		tv.contentInset = in;
	}
	if (si.bottom < h) {
		si.bottom = h;
		tv.scrollIndicatorInsets = si;
	}
}

#pragma mark - people: a pasted profile link, opening a person

// A pasted profile link: one "Profile" section with one row (the id as its name, "Open profile") that loadUser: fills in with
// the name and picture ("Profile"), or makes "Profile not available" (untappable) on a 404. The row or Search opens it.
- (void)showLink:(NSString *)uri {
	if ([uri isEqualToString:_linkURI] && !_showingRecents) return;      // already showing it
	NSUInteger seq = ++_seq;
	_askedQuery = nil;
	_result = nil;
	_shownQuery = nil;
	_showingRecents = NO;
	_linkURI = [uri copy];
	NSString *uid = ENUserIDFromURI(uri);
	_linkUser = [ENUserRow userWithJSON:@{ @"u": uri, @"id": uid ?: @"", @"n": uid ?: @"" }];
	_linkState = 0;
	[self setBusy:NO];
	[self setEmptyTitle:nil message:nil];
	[self hideBanner];
	[self hideRecentsHint];                    // (3c: Search's hint too)
	[self reloadLinkSection];
	[self.tableView setContentOffset:CGPointMake(0, -self.tableView.contentInset.top) animated:NO];
	__weak ENSearchViewController *w = self;
	[[ENCatalog shared] loadUser:uri fresh:NO done:^(id result, BOOL fromCache, NSError *error) {
		ENSearchViewController *s = w;
		if (!s || seq != s->_seq || ![uri isEqualToString:s->_linkURI]) return;
		if ([result isKindOfClass:[ENUserProfile class]]) {
			s->_linkUser = ((ENUserProfile *)result).user;
			s->_linkState = 1;
		} else if ([[ENCatalog codeOfError:error] isEqualToString:@"user_not_found"]) {
			s->_linkState = 2;
		} else {
			if (error) [s showError:error];       // (the row stays: the profile page says it again)
			return;
		}
		[s reloadLinkSection];
	}];
}

- (void)reloadLinkSection {
	_sections = _linkUser ? @[ [ENSearchSection kind:ENSecProfile title:@"Profile" rows:@[ _linkUser ]] ] : @[];
	[self.tableView reloadData];
}

// a person (a result, a recent one, the pasted link's row) opens their profile; record: it goes first in Recent searches
- (void)openUser:(ENUserRow *)u record:(BOOL)record {
	if (!u.uri) return;
	if (record) [ENRecents add:u];
	[_searchBar resignFirstResponder];
	ENProfileViewController *vc = [[ENProfileViewController alloc] initWithUserURI:u.uri name:u.name image:u.image];
	vc.ignoresMiniPlayer = self.ignoresMiniPlayer;
	[self.navigationController pushViewController:vc animated:YES];
}

#pragma mark - table

- (ENSearchSection *)sectionAt:(NSInteger)i { return (NSUInteger)i < _sections.count ? _sections[(NSUInteger)i] : nil; }

- (id)itemAt:(NSIndexPath *)ip {
	NSArray *rows = [self sectionAt:ip.section].rows;
	return (NSUInteger)ip.row < rows.count ? rows[(NSUInteger)ip.row] : nil;
}

- (ENTrack *)trackAtIndexPath:(NSIndexPath *)ip {
	id item = [self itemAt:ip];
	return [item isKindOfClass:[ENTrack class]] ? item : nil;
}

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return (NSInteger)_sections.count; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return (NSInteger)[self sectionAt:section].rows.count;
}

// (0.10, Drop 3a) the plain rows follow the Text size setting (the base keeps tableView.rowHeight at 44 / 48 / 54, as See all
// does); the Top Result stays 60 at every size
- (CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)ip {
	return [self sectionAt:ip.section].kind == ENSecTop ? [ENTheme current].tallRowHeight : tableView.rowHeight;
}

- (CGFloat)tableView:(UITableView *)tableView heightForHeaderInSection:(NSInteger)section { return 22; }

// (3c) the Top Result's header is the brighter green one (mockup .section-h.green); the same 22 pt
- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	ENSearchSection *sec = [self sectionAt:section];
	UIView<ENSectionHeader> *h = sec.kind == ENSecTop ? [self strongSectionHeaderWithTitle:sec.title] : [self sectionHeaderWithTitle:sec.title];
	if (sec.kind == ENSecRecent) [h setActionTitle:@"Clear" target:self action:@selector(clearRecents)];
	return h;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	ENSearchSection *sec = [self sectionAt:ip.section];
	id item = [self itemAt:ip];
	ENPlayback *pb = [ENPlayback shared];
	if (sec.kind == ENSecRecent) {
		[self showRecent:item inCell:cell];
	} else if (item == ENSeeAllRow) {                      // (3c) a centred green action row: "See all 1,234 songs"
		NSInteger n = _result.tracksTotal;
		[cell showAction:(n > 1 ? [@"See all " stringByAppendingString:ENCountText(n, @"song", @"songs")] : @"See all songs") busy:NO];
	} else if (item == ENSeeAllProfilesRow) {             // (0.11)
		[cell showTitle:@"See all profiles" subtitle:nil image:nil chevron:YES];
	} else if ([item isKindOfClass:[ENUserRow class]]) {
		if (sec.kind == ENSecProfile) {
			[cell showUser:item subtitle:(_linkState == 1 ? @"Profile" : _linkState == 2 ? @"Profile not available" : @"Open profile")];
			if (_linkState == 2) {
				cell.dimmed = YES;
				cell.showsChevron = NO;
			}
		} else {
			[cell showUser:item subtitle:@"Profile"];
		}
	} else if ([item isKindOfClass:[ENTrack class]]) {
		ENTrack *t = item;
		[cell showTrack:t art:ENCellArtCover playing:[pb isPlayingRow:t]];
		if (sec.kind == ENSecTop && t.playable) cell.subtitle = t.artists.length ? [@"Song · " stringByAppendingString:t.artists] : @"Song";
	} else if ([item isKindOfClass:[ENArtistRow class]]) {
		[cell showArtist:item subtitle:(sec.kind == ENSecTop ? nil : @"")];    // (3c) Artists: the name alone; the Top Result "Artist"
	} else if ([item isKindOfClass:[ENAlbumRow class]]) {
		ENAlbumRow *al = item;
		NSString *sub = al.artistYearText;
		if (sec.kind == ENSecTop) sub = al.artist.length ? [@"Album · " stringByAppendingString:al.artist] : @"Album";
		[cell showAlbum:al subtitle:sub];
	} else if ([item isKindOfClass:[ENPlaylist class]]) {
		[cell showPlaylist:item];
	}
	cell.tall = sec.kind == ENSecTop;
	return cell;
}

// (0.9.5) a recent item: the row its kind has in the results with Spotify's "Kind · …" sub-line, and a × (removes it) in
// place of the ••• / chevron
- (void)showRecent:(id)item inCell:(ENListCell *)cell {
	if ([item isKindOfClass:[ENTrack class]]) {
		ENTrack *t = item;
		[cell showTrack:t art:ENCellArtCover playing:[[ENPlayback shared] isPlayingRow:t]];
		cell.subtitle = t.artists.length ? [@"Song · " stringByAppendingString:t.artists] : @"Song";
	} else if ([item isKindOfClass:[ENArtistRow class]]) {
		[cell showArtist:item subtitle:@"Artist"];
	} else if ([item isKindOfClass:[ENAlbumRow class]]) {
		ENAlbumRow *al = item;
		[cell showAlbum:al subtitle:(al.artist.length ? [@"Album · " stringByAppendingString:al.artist] : @"Album")];
	} else if ([item isKindOfClass:[ENPlaylist class]]) {
		ENPlaylist *pl = item;
		[cell showPlaylist:pl];
		cell.subtitle = pl.owner.length ? [@"Playlist · " stringByAppendingString:pl.owner] : @"Playlist";
	} else if ([item isKindOfClass:[ENUserRow class]]) {           // (0.11) a person
		[cell showUser:item subtitle:@"Profile"];
	}
	ENTheme *th = cell.theme;
	cell.showsChevron = NO;
	cell.showsMore = YES;
	cell.moreGlyphOverride = [th glyphNamed:@"close" size:22 color:th.chevron];
}

- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	id item = [self itemAt:ip];
	if ([self sectionAt:ip.section].kind == ENSecProfile && _linkState == 2) return NO;     // (0.11) "Profile not available"
	return [item isKindOfClass:[ENTrack class]] ? ((ENTrack *)item).playable : item != nil;
}

// A song, artist, album or playlist (a result, or a recent one: it does what its first tap did) goes first in "Recent
// searches" (0.9.5), before it plays / is added / opens; "See all songs" is no item.
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	id item = [self itemAt:ip];
	if (!item) return;
	[_searchBar resignFirstResponder];
	// (0.11) people: their profile (into Recent searches once the name is known; never the "See all profiles" row)
	if (item == ENSeeAllProfilesRow) {
		if (!_users) return;
		ENPeopleViewController *vc = [[ENPeopleViewController alloc] initWithSearchQuery:_usersQuery first:_users];
		vc.ignoresMiniPlayer = self.ignoresMiniPlayer;
		[self.navigationController pushViewController:vc animated:YES];
		return;
	}
	if ([item isKindOfClass:[ENUserRow class]]) {
		ENSecKind k = [self sectionAt:ip.section].kind;
		if (k == ENSecProfile && _linkState == 2) return;
		[self openUser:item record:(k != ENSecProfile || _linkState == 1)];
		return;
	}
	if (item != ENSeeAllRow) [ENRecents add:item];
	if (_forJam) {
		[self pickForJam:item];
		return;
	}
	UIViewController *vc = nil;
	if (item == ENSeeAllRow) vc = [[ENSearchSongsViewController alloc] initWithResult:_result];
	else if ([item isKindOfClass:[ENTrack class]]) {
		ENTrack *t = item;
		if (t.playable) [[ENPlayback shared] playURI:t.uri];
	}
	else if ([item isKindOfClass:[ENArtistRow class]]) vc = [[ENArtistViewController alloc] initWithArtist:item];
	else if ([item isKindOfClass:[ENAlbumRow class]]) vc = [[ENTrackListViewController alloc] initWithAlbum:item];
	else if ([item isKindOfClass:[ENPlaylist class]]) vc = [[ENTrackListViewController alloc] initWithPlaylist:item];
	if (vc) [self.navigationController pushViewController:vc animated:YES];
}

// (0.9.3) "Add songs": a song is added to the Jam (the sheet stays for more); the other rows push their "add" pages
- (void)pickForJam:(id)item {
	ENListViewController *vc = nil;
	if (item == ENSeeAllRow) vc = [[ENJamPickSongsViewController alloc] initWithResult:_result];
	else if ([item isKindOfClass:[ENTrack class]]) {
		ENTrack *t = item;
		if (t.playable) [ENTrackActions addToQueue:t];
	}
	else if ([item isKindOfClass:[ENArtistRow class]]) vc = [[ENJamPickArtistViewController alloc] initWithArtist:item];
	else if ([item isKindOfClass:[ENAlbumRow class]]) vc = [[ENJamPickTrackListViewController alloc] initWithAlbum:item];
	else if ([item isKindOfClass:[ENPlaylist class]]) vc = [[ENJamPickTrackListViewController alloc] initWithPlaylist:item];
	if (!vc) return;
	vc.ignoresMiniPlayer = YES;
	[self.navigationController pushViewController:vc animated:YES];
}

// (0.9.5) a recent row's × removes it; any other row's ••• is the song sheet, as before
- (void)listCellDidTapMore:(ENListCell *)cell {
	NSIndexPath *ip = [self.tableView indexPathForCell:cell];
	if (ip && [self sectionAt:ip.section].kind == ENSecRecent) {
		if (cell.item && cell.item == [self itemAt:ip]) [self removeRecentAt:ip];     // never a row the cell no longer shows
		return;
	}
	[super listCellDidTapMore:cell];
}

// scrolling puts the keyboard away (ENTabBarController takes first responder back on UIKeyboardDidHideNotification)
- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView {
	[super scrollViewWillBeginDragging:scrollView];
	[self checkScrollRange:nil];               // (0.11.2) corrected before this drag, not logged
	if (_searchBar.isFirstResponder) [_searchBar resignFirstResponder];
}

// (0.11.1) the scrolling stopped: a Profiles section that waited for it goes in now (-placeLateProfiles; a no-op otherwise);
// (0.11.2) and the scroll range is logged and checked (-checkScrollRange:)
- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView willDecelerate:(BOOL)decelerate {
	[super scrollViewDidEndDragging:scrollView willDecelerate:decelerate];
	if (decelerate) return;
	[self checkScrollRange:@"scroll end"];
	[self placeLateProfilesAfter:0];
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView {
	[super scrollViewDidEndDecelerating:scrollView];
	[self checkScrollRange:@"scroll end"];
	[self placeLateProfilesAfter:0];
}

- (void)scrollViewDidEndScrollingAnimation:(UIScrollView *)scrollView {      // the tab's scroll to top
	[self checkScrollRange:@"scroll end"];
	[self placeLateProfilesAfter:0];
}

- (void)scrollViewDidScrollToTop:(UIScrollView *)scrollView {                // the status bar's
	[self checkScrollRange:@"scroll end"];
	[self placeLateProfilesAfter:0];
}

@end

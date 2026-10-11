#import "ENAddToPlaylistViewController.h"
#import "ENTrackActions.h"
#import "ENHUD.h"
#import "ENCatalog.h"
#import "ENModel.h"
#import "ENTheme.h"
#import "ENListCell.h"
#import "ENListViewController.h"
#import "ENImageCache.h"
#import "ENTabBarController.h"
#import "ENPins.h"
#import "ENUtil.h"
#import "ENDiag.h"

// The "Saved in" sheet (DESIGN-0.9 §3b; was the 0.5 Add to Playlist picker, DESIGN-3 §6.2): like the real Spotify app's,
// Liked Songs and every editable playlist with a check when the song is already in it. Ticks are local until Done, which
// applies the difference (adds AND removes) one request after another, then closes 0.8 s after the final HUD.
// Drop 3a (DESIGN-5 A3): every colour, font and image from ENTheme (the strip, the checks, the footer, the lists' green
// ENSectionHeaderView), the 17 pt title, the row height from the Text size setting, and a re-skin in place on
// ENThemeDidChangeNotification (the Automatic clock can flip the palette while the sheet is up).
// Drop 3c (DESIGN-5 C4): "New Playlist…" shows the green icon tile with the circled plus (-iconTileNamed:@"newPlaylist").

@interface ENTrackActions (ENPicker)
+ (void)alertTitle:(NSString *)title message:(NSString *)message;    // ENTrackActions.m: one error alert at a time
+ (BOOL)writeInFlight;                                              // a New Playlist create is running
@end

static NSString *const ENPickerHeaderID = @"ENPickerHeader";       // (A3) an ENSectionHeaderView, the lists' green header
static NSString *const ENPickerBusyText = @"Saving…";
static const CGFloat ENPickerStripHeight = 36;
static const CGFloat ENPickerCheckSide = 22;
static const NSTimeInterval ENPickerPollEvery = 2;       // while the gateway still has playlists `pending`
static const NSUInteger ENPickerMaxReasks = 10;

// ---------------------------------------------------------------------------------------------------------------- cell
// The sheet's rows (DESIGN-0.9.2 §3). A toggle row (Liked Songs, a playlist) never looks highlighted or selected: only its
// check changes. The 0.9 "cut-off square": the 22 pt check is the cell's accessoryView, so UIKit narrows the content view
// (ENListCell's opaque canvas) and leaves a ~42 x 48 pt strip on the right where the cell's own background views show.
// On a tap the canvas painted the green selection gradient and redrew plain the moment didSelect deselected the row, while
// UIKit's selectedBackgroundView faded out behind the accessory (the check turned white meanwhile): a green square round
// the disc with a hard edge where the content view ends. So a toggle row has no selection style and the highlighted /
// selected states never reach ENListCell (its canvas reads them to draw); UIKit still selects the row on a tap
// (-tableView:didSelectRowAtIndexPath: toggles the check). "New Playlist…" keeps the normal tap highlight.
@interface ENPickerCell : ENListCell
@property (nonatomic) BOOL toggles;
@end

@implementation ENPickerCell

- (void)setToggles:(BOOL)toggles {
	_toggles = toggles;
	self.selectionStyle = toggles ? UITableViewCellSelectionStyleNone : UITableViewCellSelectionStyleBlue;
}

- (void)setHighlighted:(BOOL)highlighted animated:(BOOL)animated {
	[super setHighlighted:(highlighted && !_toggles) animated:animated];
}

- (void)setSelected:(BOOL)selected animated:(BOOL)animated {
	[super setSelected:(selected && !_toggles) animated:animated];
}

@end

// ---------------------------------------------------------------------------------------------------------------- strip
// The song being added (mockup .note-strip): a light green gradient, a 22 pt thumbnail (88 tier) and "Song — Artists".
@interface ENPickerStrip : UIView
@property (nonatomic, copy) NSString *text;
@property (nonatomic, strong) UIImage *image;
@end

@implementation ENPickerStrip

- (instancetype)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		self.opaque = YES;
		self.contentMode = UIViewContentModeRedraw;
	}
	return self;
}

- (void)setImage:(UIImage *)image {
	_image = image;
	[self setNeedsDisplay];
}

- (void)setText:(NSString *)text {
	_text = [text copy];
	[self setNeedsDisplay];
}

// (A3) all from ENTheme: noteStripImage (#e7f4dc -> #d6eac6 over a #b6d0a0 line; Dark #1f2f18 -> #182613), the thumb frame
// (the rows' covers: a 1 pt ring, Light's drop line), noteStripFont in noteStripText. The thumbnail lines up with the rows'
// art column (8 pt in). No picture (yet): the palette's placeholder, so a theme switch redraws it right.
- (void)drawRect:(CGRect)rect {
	ENTheme *th = [ENTheme current];
	CGRect b = self.bounds;
	[th.noteStripImage drawInRect:b];
	CGFloat x = 8, side = 22;
	CGRect art = CGRectMake(x, floorf((b.size.height - 1 - side) / 2), side, side);
	[[th thumbFrameImageOfSide:side round:NO] drawAtPoint:art.origin];
	[(_image ?: th.placeholderCover) drawInRect:CGRectInset(art, 1, 1)];
	x += side + 8;

	if (_text.length) {
		UIFont *f = th.noteStripFont;
		[th.noteStripText set];
		CGFloat y = floorf((b.size.height - 1 - f.lineHeight) / 2);
		[_text drawAtPoint:CGPointMake(x, y) forWidth:b.size.width - x - 12 withFont:f lineBreakMode:NSLineBreakByTruncatingTail];
	}
}

@end

// ---------------------------------------------------------------------------------------------------------------- save
// One row of Done's difference. The chain below runs to its end even after the sheet is gone (Cancel while saving), so it
// holds the plan itself and never the sheet.
@interface ENPickerChange : NSObject
@property (nonatomic, strong) ENPlaylist *playlist;     // nil = Liked Songs
@property (nonatomic, copy) NSString *name;             // what the HUD / alert call it
@property (nonatomic) BOOL add;                         // YES add (save), NO remove
@property (nonatomic, strong) NSError *error;           // set when it failed
@end

@implementation ENPickerChange
@end

// Applies changes[i...] one request after another, then finished(). A 409 duplicate on an add counts as success: the song
// is already there.
static void ENPickerApply(NSArray *changes, NSUInteger i, ENTrack *track, void (^finished)(void)) {
	if (i >= changes.count) {
		finished();
		return;
	}
	ENPickerChange *ch = changes[i];
	void (^next)(NSError *) = ^(NSError *error) {
		ch.error = error;
		ENPickerApply(changes, i + 1, track, finished);
	};
	ENCatalog *cat = [ENCatalog shared];
	if (!ch.playlist) {
		[cat setSaved:ch.add tracks:@[track] done:next];
	} else if (ch.add) {
		[cat addTrackURIs:@[track.uri] toPlaylist:ch.playlist allowDuplicates:NO done:^(ENPlaylist *updated, NSError *error) {
			if (error.code == 409 && [[ENCatalog codeOfError:error] isEqualToString:@"duplicate"]) error = nil;
			if (!error && updated.name.length) ch.name = updated.name;
			next(error);
		}];
	} else {
		[cat removeTrackURIs:@[track.uri] fromPlaylist:ch.playlist done:^(ENPlaylist *updated, NSError *error) {
			if (!error && updated.name.length) ch.name = updated.name;
			next(error);
		}];
	}
}

// "A", "A and B", "A, B and C"
static NSString *ENPickerJoin(NSArray *names) {
	if (names.count < 2) return names.count ? names[0] : @"";
	NSArray *head = [names subarrayWithRange:NSMakeRange(0, names.count - 1)];
	return [NSString stringWithFormat:@"%@ and %@", [head componentsJoinedByString:@", "], [names lastObject]];
}

// The final word, in Spotify's: one change "Added to <name>" / "Removed from <name>"; several "Saved in N playlists" (all
// adds) / "Changes saved"; any failure an alert naming the ones that failed with the first error's message.
static void ENPickerReport(NSArray *changes) {
	NSMutableArray *failed = [NSMutableArray array];
	NSError *firstError = nil;
	NSUInteger adds = 0, failedAdds = 0;
	for (ENPickerChange *ch in changes) {
		if (ch.add) adds++;
		if (!ch.error) continue;
		[failed addObject:ch.name];
		if (ch.add) failedAdds++;
		if (!firstError) firstError = ch.error;
	}
	if (failed.count) {
		NSString *why = [ENCatalog messageForError:firstError];
		ENLog(@"picker: %lu of %lu changes failed: %@", (unsigned long)failed.count, (unsigned long)changes.count, [ENCatalog logTextForError:firstError]);
		[ENHUD hideText:ENPickerBusyText];
		NSString *names = ENPickerJoin(failed);
		NSString *title, *msg;
		if (failedAdds == failed.count) {
			title = @"Couldn't add";
			msg = [NSString stringWithFormat:@"The song wasn't added to %@. %@", names, why];
		} else if (!failedAdds) {
			title = @"Couldn't remove";
			msg = [NSString stringWithFormat:@"The song wasn't removed from %@. %@", names, why];
		} else {
			title = @"Couldn't save changes";
			msg = [NSString stringWithFormat:@"%@ weren't changed. %@", names, why];
		}
		[ENTrackActions alertTitle:title message:msg];
		return;
	}
	NSString *text;
	if (changes.count == 1) {
		ENPickerChange *ch = changes[0];
		if (ch.add) text = [NSString stringWithFormat:@"Added to %@", ch.name];
		else text = [NSString stringWithFormat:@"Removed from %@", ch.name];
	} else if (adds == changes.count) {
		text = [NSString stringWithFormat:@"Saved in %lu playlists", (unsigned long)changes.count];
	} else {
		text = @"Changes saved";
	}
	[ENHUD showDone:text];
}

// ---------------------------------------------------------------------------------------------------------------- sheet
@implementation ENAddToPlaylistViewController {
	ENTrack *_track;
	NSArray *_playlists;             // ENPlaylist: the library's editable ones, pinned first, then sidebar order
	NSUInteger _pinnedCount;         // how many of _playlists lead as pinned (they draw the pin glyph, as on the Playlists tab)
	NSMutableDictionary *_known;     // playlist uri -> @YES / @NO: what the gateway says (GET /v1/playlists/containing)
	NSMutableDictionary *_wanted;    // playlist uri -> @YES / @NO: the user's ticks that differ from _known (absent = untouched)
	NSNumber *_likedWanted;          // the same for Liked Songs (its known state is -[ENCatalog savedStateForURI:])
	BOOL _checking;                  // a containing request is in flight or the next one is scheduled
	BOOL _answered;                  // a containing answer came (an error after it only stops the polling)
	NSInteger _pending;              // the last answer's pending (playlists the gateway hasn't indexed yet)
	NSUInteger _asks;                // containing requests made (1 + at most ENPickerMaxReasks)
	NSUInteger _pollGen;             // the scheduled re-ask that is still wanted
	NSString *_checkError;           // the footer's text when the first containing request failed
	BOOL _saving;                    // Done is applying the difference: taps are ignored
	BOOL _closing;
	BOOL _loading;                   // no library yet and loadLibrary is running
	NSString *_loadError;
	ENPickerStrip *_strip;
	NSString *_thumbKey;
	UIView *_footView;
	UILabel *_foot;
	UIActivityIndicatorView *_spin;
	UIBarButtonItem *_done;
}

- (instancetype)initWithTrack:(ENTrack *)track {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		_track = track;
		_known = [NSMutableDictionary dictionary];
		_wanted = [NSMutableDictionary dictionary];
		self.title = @"Add to Playlist";
	}
	return self;
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];
	if (_thumbKey) [[ENImageCache shared] cancel:_thumbKey];
}

- (void)viewDidLoad {
	[super viewDidLoad];
	ENTheme *th = [ENTheme current];
	[th applyTitle:self.title toItem:self.navigationItem small:YES];          // (A3) the 17 pt title
	UITableView *tv = self.tableView;
	tv.separatorStyle = UITableViewCellSeparatorStyleNone;
	ENRegisterCellClass(tv, [ENPickerCell class], [ENListCell reuseIdentifier]);      // (1.1: iOS 5 too, ENCompat)
	ENRegisterSectionHeader(tv, ENPickerHeaderID);
	self.navigationItem.leftBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemCancel
		target:self action:@selector(cancel)];
	_done = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone target:self action:@selector(done)];
	[ENTheme skinBarItem:_done done:YES];    // (1.1) iOS 5: the Done look on the item itself (a system item's style reads Plain)
	_done.enabled = NO;
	self.navigationItem.rightBarButtonItem = _done;

	CGFloat w = tv.bounds.size.width;
	_strip = [[ENPickerStrip alloc] initWithFrame:CGRectMake(0, 0, w, ENPickerStripHeight)];
	_strip.autoresizingMask = UIViewAutoresizingFlexibleWidth;
	NSString *name = _track.name.length ? _track.name : @"Song";
	_strip.text = _track.artists.length ? [NSString stringWithFormat:@"%@ — %@", name, _track.artists] : name;
	tv.tableHeaderView = _strip;
	[self loadThumb];

	_footView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, 64)];
	_foot = [[UILabel alloc] initWithFrame:CGRectMake(16, 10, w - 32, 44)];
	_foot.autoresizingMask = UIViewAutoresizingFlexibleWidth;
	_foot.shadowOffset = CGSizeMake(0, 1);
	_foot.textAlignment = NSTextAlignmentCenter;
	_foot.numberOfLines = 0;
	[_footView addSubview:_foot];
	_spin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:th.spinnerStyle];
	_spin.hidesWhenStopped = YES;
	_spin.center = CGPointMake(floor(w / 2), 32);
	_spin.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin | UIViewAutoresizingFlexibleRightMargin;
	[_footView addSubview:_spin];
	tv.tableFooterView = _footView;
	[self applySkin];

	[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(catalogChanged:) name:ENCatalogChangedNotification object:nil];
	[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(themeChanged:) name:ENThemeDidChangeNotification object:nil];
	[self showLibrary];
	if (![ENCatalog shared].library) [self loadLibrary];

	// the checks: Liked Songs from the saved states (re-checked), the playlists from the gateway's membership index
	if (_track.uri.length) {
		__weak ENAddToPlaylistViewController *wself = self;
		[[ENCatalog shared] checkSaved:@[_track.uri] done:^{
			[wself refreshChecks];
		}];
		[self checkPlaylists];
	}
}

// the 88-tier cover, drawn at 22 pt: the memory copy at once, else the placeholder until it loads
- (void)loadThumb {
	NSString *token = _track.image;
	ENImageCache *ic = [ENImageCache shared];
	UIImage *img = [ic memoryImage:token size:ENImg88 round:NO];
	_strip.image = img;                 // nil: the strip draws the palette's placeholder
	if (img || !token.length) return;
	__weak ENPickerStrip *ws = _strip;
	_thumbKey = [ic load:token size:ENImg88 round:NO done:^(UIImage *image, NSString *key) {
		if (image) ws.image = image;
	}];
}

// (A3) the sheet's content colours from the palette in use (the chrome is the same in both themes)
- (void)applySkin {
	ENTheme *th = [ENTheme current];
	UITableView *tv = self.tableView;
	tv.rowHeight = th.rowHeight;
	tv.backgroundColor = th.listBackground;
	tv.indicatorStyle = th.indicatorStyle;
	_footView.backgroundColor = th.listBackground;
	_foot.backgroundColor = th.listBackground;
	_foot.font = th.footerFont;
	_foot.textColor = th.footerText;
	_foot.shadowColor = th.footerTextShadow;
	_spin.activityIndicatorViewStyle = th.spinnerStyle;
	[_strip setNeedsDisplay];
}

// (A3) a palette flip while the sheet is up (the Automatic clock): re-skin in place. The ticks, the pending checks and a
// running save are state, not views: untouched; the reload redraws the rows and their marks in the new palette.
- (void)themeChanged:(NSNotification *)n {
	if (!self.isViewLoaded) return;
	[self applySkin];
	UITableView *tv = self.tableView;
	for (UITableViewCell *c in tv.visibleCells)
		if ([c isKindOfClass:[ENListCell class]]) [(ENListCell *)c reloadTheme];
	[ENSectionHeaderForSection(tv, 1) reloadTheme];        // (1.1: iOS 5's too)
	[tv reloadData];
}

// ---- data

- (void)showLibrary {
	ENLibrary *lib = [ENCatalog shared].library;
	// a uri the sidebar holds twice gets one row (its first, as ENPins does for pinned ones): one tick, one change on Done
	NSMutableArray *editable = [NSMutableArray array];
	NSMutableSet *seen = [NSMutableSet set];
	for (ENPlaylist *pl in [lib editablePlaylists]) {
		if (pl.uri.length) {
			if ([seen containsObject:pl.uri]) continue;
			[seen addObject:pl.uri];
		}
		[editable addObject:pl];
	}
	NSUInteger pinned = 0;
	_playlists = lib ? [ENPins orderPlaylists:editable pinnedCount:&pinned] : @[];
	_pinnedCount = pinned;
	[self.tableView reloadData];
	[self updateFooter];
	[self updateDone];
}

- (void)updateFooter {
	ENLibrary *lib = [ENCatalog shared].library;
	if (!lib && _loading) {
		[_spin startAnimating];
		_foot.hidden = YES;
		return;
	}
	[_spin stopAnimating];
	_foot.hidden = NO;
	if (!lib) _foot.text = _loadError ?: @"Your playlists aren't loaded yet.";
	else if (_checking) _foot.text = @"Checking your playlists…";
	else if (_checkError) _foot.text = _checkError;
	else if (_pending > 0) _foot.text = @"Some of your playlists haven't been checked yet, so their checks may be missing.";
	else if (!_playlists.count) _foot.text = @"You have no playlists you can add to yet. Only playlists you own or collaborate on can be changed.";
	else _foot.text = @"Only playlists you own or collaborate on can be changed.";
}

- (void)loadLibrary {
	_loading = YES;
	_loadError = nil;
	[self updateFooter];
	__weak ENAddToPlaylistViewController *w = self;
	[[ENCatalog shared] loadLibrary:NO done:^(id result, BOOL fromCache, NSError *error) {
		ENAddToPlaylistViewController *s = w;
		if (!s) return;
		s->_loading = NO;
		if (error && ![ENCatalog shared].library) s->_loadError = [ENCatalog messageForError:error];
		[s showLibrary];
	}];
}

- (void)catalogChanged:(NSNotification *)n {
	NSString *kind = n.userInfo[ENCatalogKindKey];
	// an add / remove replaces the playlist in .library (its count changes); a new playlist goes on top
	if ([kind isEqualToString:ENCatalogKindLibrary] || [kind isEqualToString:ENCatalogKindReset]) [self showLibrary];
	else if ([kind isEqualToString:ENCatalogKindLiked]) {
		// a heart changed somewhere (or our own save): a tick that now matches is no longer a change
		NSNumber *known = [[ENCatalog shared] savedStateForURI:_track.uri];
		if (_likedWanted && !_saving && [_likedWanted boolValue] == [known boolValue]) _likedWanted = nil;
		[self refreshChecks];
	}
}

// GET /v1/playlists/containing; while the gateway is still indexing some (`pending`), again every 2 s, at most 10 times.
- (void)checkPlaylists {
	if (_closing || _saving) {
		_checking = NO;
		[self updateFooter];
		return;
	}
	_checking = YES;
	_asks++;
	__weak ENAddToPlaylistViewController *w = self;
	[[ENCatalog shared] loadPlaylistsContaining:_track.uri done:^(NSDictionary *states, NSInteger pending, NSError *e) {
		ENAddToPlaylistViewController *s = w;
		if (s && !s->_closing) [s gotStates:states pending:pending error:e];
	}];
	[self updateFooter];
}

- (void)gotStates:(NSDictionary *)states pending:(NSInteger)pending error:(NSError *)e {
	_pollGen++;                      // whatever was scheduled: this answer decides again
	if (e) {
		_checking = NO;
		if (!_answered) {
			// a gateway before 0.9.0 has no such route
			if (e.code == 404) _checkError = ENUpdateBridgeText;
			else _checkError = [NSString stringWithFormat:@"Couldn't check which playlists already have this song. %@", [ENCatalog messageForError:e]];
		}
		[self updateFooter];
		return;
	}
	_answered = YES;
	_checkError = nil;
	_pending = pending;
	if (!_saving) {
		for (NSString *uri in states) {
			NSNumber *v = states[uri];
			if (![uri isKindOfClass:[NSString class]] || ![v isKindOfClass:[NSNumber class]]) continue;
			BOOL has = [v boolValue];
			_known[uri] = @(has);
			// rows the user hasn't touched follow the answer; a tick that now matches it is no longer a change
			NSNumber *want = _wanted[uri];
			if (want && [want boolValue] == has) [_wanted removeObjectForKey:uri];
		}
	}
	if (pending > 0 && _asks <= ENPickerMaxReasks && !_saving && !_closing) {
		NSUInteger gen = _pollGen;
		__weak ENAddToPlaylistViewController *w = self;
		dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(ENPickerPollEvery * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
			ENAddToPlaylistViewController *s = w;
			if (s && s->_pollGen == gen) [s checkPlaylists];
		});
	} else {
		_checking = NO;
	}
	[self refreshChecks];
	[self updateFooter];
}

// ---- checks

- (BOOL)likedChecked {
	return [(_likedWanted ?: [[ENCatalog shared] savedStateForURI:_track.uri]) boolValue];
}

- (BOOL)checkedForURI:(NSString *)uri {
	return [(_wanted[uri] ?: _known[uri]) boolValue];
}

// section 1: row 0 Liked Songs, then _playlists
- (BOOL)checkedAtRow:(NSInteger)row {
	if (row == 0) return [self likedChecked];
	if (row < 1 || (NSUInteger)(row - 1) >= _playlists.count) return NO;
	return [self checkedForURI:((ENPlaylist *)_playlists[(NSUInteger)(row - 1)]).uri];
}

- (BOOL)hasChanges {
	if (_likedWanted && [_likedWanted boolValue] != [[[ENCatalog shared] savedStateForURI:_track.uri] boolValue]) return YES;
	for (ENPlaylist *pl in _playlists) {
		NSNumber *want = _wanted[pl.uri];
		if (want && [want boolValue] != [_known[pl.uri] boolValue]) return YES;
	}
	return NO;
}

- (void)updateDone {
	_done.enabled = !_saving && !_closing && [self hasChanges];
}

// The accessory: a clear, non-opaque 22 pt image view (no background of its own behind the disc). animated: a tap's 0.15 s
// cross-fade of the disc, the only thing a toggle shows.
- (void)showCheck:(BOOL)on inCell:(UITableViewCell *)cell animated:(BOOL)animated {
	UIImageView *iv = [cell.accessoryView isKindOfClass:[UIImageView class]] ? (UIImageView *)cell.accessoryView : nil;
	if (!iv) {
		iv = [[UIImageView alloc] initWithFrame:CGRectMake(0, 0, ENPickerCheckSide, ENPickerCheckSide)];
		iv.opaque = NO;
		iv.backgroundColor = [UIColor clearColor];
		cell.accessoryView = iv;
	}
	UIImage *img = [[ENTheme current] pickerCheckImage:on];
	if (iv.image == img) return;
	if (animated) [UIView transitionWithView:iv duration:0.15 options:UIViewAnimationOptionTransitionCrossDissolve | UIViewAnimationOptionAllowUserInteraction
	                              animations:^{ iv.image = img; } completion:nil];
	else iv.image = img;
}

// the visible rows' marks (no reload: a tap's cross-fade runs on) and the Done button
- (void)refreshChecks {
	UITableView *tv = self.tableView;
	for (NSIndexPath *ip in [tv indexPathsForVisibleRows]) {
		if (ip.section != 1) continue;
		UITableViewCell *cell = [tv cellForRowAtIndexPath:ip];
		if (cell) [self showCheck:[self checkedAtRow:ip.row] inCell:cell animated:NO];
	}
	[self updateDone];
}

// ---- table

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
	return 2;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return section == 0 ? 1 : 1 + (NSInteger)_playlists.count;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
	ENPickerCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], indexPath);
	ENTheme *th = [ENTheme current];
	cell.toggles = indexPath.section == 1;
	if (indexPath.section == 0) {
		// (3c, C4) the green icon tile with the circled plus (the Library's 42 pt kind; cached by ENTheme)
		[cell showTitle:@"New Playlist…" subtitle:nil image:[th iconTileNamed:@"newPlaylist" size:42] chevron:NO];
		cell.accessoryView = nil;
		return cell;
	}
	if (indexPath.row == 0) {
		ENLibrary *lib = [ENCatalog shared].library;
		NSInteger n = lib ? lib.likedLength : -1;
		[cell showTitle:@"Liked Songs" subtitle:(n >= 0 ? ENCountText(n, @"song", @"songs") : nil) image:th.likedTile chevron:NO];
	} else if ((NSUInteger)(indexPath.row - 1) < _playlists.count) {
		[cell showPlaylist:_playlists[(NSUInteger)(indexPath.row - 1)]];
		cell.showsChevron = NO;
		cell.pinned = (NSUInteger)(indexPath.row - 1) < _pinnedCount;
	}
	[self showCheck:[self checkedAtRow:indexPath.row] inCell:cell animated:NO];
	return cell;
}

- (CGFloat)tableView:(UITableView *)tableView heightForHeaderInSection:(NSInteger)section {
	return section == 1 ? 22 : 0;
}

- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	if (section != 1) return nil;
	UIView<ENSectionHeader> *h = ENDequeueSectionHeader(tableView, ENPickerHeaderID);      // (1.1: iOS 5, a new one)
	h.title = @"Your playlists";
	[h reloadTheme];                    // (a reused one may be from before a theme switch)
	return h;
}

- (NSIndexPath *)tableView:(UITableView *)tableView willSelectRowAtIndexPath:(NSIndexPath *)indexPath {
	return [self ignoringTaps] ? nil : indexPath;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
	// "New Playlist…" fades its highlight as usual; a toggle row has none (ENPickerCell), only the table's selection to drop
	[tableView deselectRowAtIndexPath:indexPath animated:indexPath.section == 0];
	if ([self ignoringTaps]) return;
	if (indexPath.section == 0) {
		// the New Playlist alert; it creates the playlist with this song and shows "Added to <name>" itself
		__weak ENAddToPlaylistViewController *w = self;
		[ENTrackActions newPlaylistFrom:self track:_track done:^(ENPlaylist *created) {
			[w closeSoon];
		}];
		return;
	}
	// a tick, no request yet; ticking back to what the gateway says is no change
	if (indexPath.row == 0) {
		NSNumber *known = [[ENCatalog shared] savedStateForURI:_track.uri];
		BOOL now = ![self likedChecked];
		_likedWanted = now == [known boolValue] ? nil : @(now);
	} else {
		if ((NSUInteger)(indexPath.row - 1) >= _playlists.count) return;
		NSString *uri = ((ENPlaylist *)_playlists[(NSUInteger)(indexPath.row - 1)]).uri;
		BOOL now = ![self checkedForURI:uri];
		if (now == [_known[uri] boolValue]) [_wanted removeObjectForKey:uri];
		else _wanted[uri] = @(now);
	}
	UITableViewCell *cell = [tableView cellForRowAtIndexPath:indexPath];
	if (cell) [self showCheck:[self checkedAtRow:indexPath.row] inCell:cell animated:YES];
	[self updateDone];
}

- (BOOL)ignoringTaps {
	return _saving || _closing || [ENTrackActions writeInFlight];
}

// ---- Done: apply the difference

- (void)done {
	if ([self ignoringTaps] || !_track.uri.length) return;
	NSMutableArray *changes = [NSMutableArray array];
	NSUInteger adds = 0;
	if (_likedWanted && [_likedWanted boolValue] != [[[ENCatalog shared] savedStateForURI:_track.uri] boolValue]) {
		ENPickerChange *ch = [ENPickerChange new];
		ch.name = @"Liked Songs";
		ch.add = [_likedWanted boolValue];
		[changes addObject:ch];
	}
	for (ENPlaylist *pl in _playlists) {
		NSNumber *want = _wanted[pl.uri];
		if (!want || [want boolValue] == [_known[pl.uri] boolValue]) continue;
		ENPickerChange *ch = [ENPickerChange new];
		ch.playlist = pl;
		ch.name = pl.name.length ? pl.name : @"a playlist";
		ch.add = [want boolValue];
		[changes addObject:ch];
	}
	if (!changes.count) {
		[self updateDone];
		return;
	}
	for (ENPickerChange *ch in changes) if (ch.add) adds++;
	_saving = YES;
	_pollGen++;                      // no more re-asks
	_checking = NO;
	[self updateDone];
	[self updateFooter];
	[ENHUD showBusy:ENPickerBusyText];
	ENLog(@"picker: save %lu add, %lu remove", (unsigned long)adds, (unsigned long)(changes.count - adds));
	__weak ENAddToPlaylistViewController *w = self;
	ENPickerApply(changes, 0, _track, ^{
		// Cancel meanwhile: w is nil / closing, the outcome still shows
		ENPickerReport(changes);
		[w closeSoon];
	});
}

// ---- closing

- (void)closeSoon {
	__weak ENAddToPlaylistViewController *w = self;
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		[w close];
	});
}

- (void)cancel {
	[self close];
}

- (void)close {
	if (_closing) return;
	_closing = YES;
	_pollGen++;
	_done.enabled = NO;
	UIViewController *host = self.navigationController.presentingViewController ?: self.presentingViewController;
	if (!host) return;
	ENTabBarController *tabs = [ENTabBarController shared];
	[host dismissViewControllerAnimated:YES completion:^{
		// the lock-screen / AirPods controls need a first responder again: Now Playing when the sheet was over it, else
		// the tab controller
		if (host != tabs && [host canBecomeFirstResponder] && host.view.window) [host becomeFirstResponder];
		else [tabs reclaimFirstResponder];
	}];
}

@end

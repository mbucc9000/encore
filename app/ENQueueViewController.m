#import "ENQueueViewController.h"
#import "ENL.h"
#import "ENModel.h"
#import "ENPlayback.h"
#import "ENJam.h"
#import "ENCatalog.h"
#import "ENTheme.h"
#import "ENTabBarController.h"
#import "ENQueueEditor.h"
#import "ENImageCache.h"
#import "ENUtil.h"

typedef enum { ENQueueSectionNow = 0, ENQueueSectionQueue, ENQueueSectionContext, ENQueueSectionAutoplay } ENQueueSectionKind;

// One section of the screen: its header, its rows, which of the gateway's lists it shows (now, q, cq, ap) and whether it
// is the Jam queue (the green header). An edit replaces `rows` with a new array; nothing is changed in place.
@interface ENQueueSection : NSObject
@property (nonatomic, copy) NSString *title;
@property (nonatomic, copy) NSArray *rows;
@property (nonatomic) ENQueueSectionKind kind;
@property (nonatomic) BOOL jamHeader;
@end

@implementation ENQueueSection
@end

static const NSTimeInterval ENQueueDropWait = 3;     // a rollback waits this long at most for the drop of a row being dragged
static const CGFloat ENQueueThumb = 28;               // (3b) the right bar button's cover (mockup .barbtn.icon img, 28 px) ...
static const CGFloat ENQueueThumbButtonWidth = 32;    // ... in a 32 pt glossy bar button (1 pt padding either side)
static const NSTimeInterval ENQueueJumpWait = 15;     // (DESIGN-QUEUE §2.1) a jump keeps the screen busy this long at most
static const NSTimeInterval ENQueueHoldTime = 0.5;    // (DESIGN-QUEUE §2.1) holding an editable row this long enters edit mode

@interface ENQueueViewController () <ENQueueEditorDelegate, UIGestureRecognizerDelegate>
@end

@implementation ENQueueViewController {
	ENQueue *_queue;             // what the rows were built from
	NSArray *_sections;          // ENQueueSection
	BOOL _loading, _retried;     // _retried: the one re-poll after retry_ms has been used for this run of x rows
	BOOL _again;                 // a reload was asked for while one was in flight or an edit was busy: one more follows it
	NSString *_loadBanner;       // the last load error's banner text (a later load hides it; an edit's banner stays)
	// 4b-c editing (DESIGN-4b §6.10)
	// the edits FIFO, the rev the next edit carries, the gateway's newest queue (a GET's, or the last edit reply's: shown
	// once the edits settle), the edit generation (a GET sent before an edit may predate it, so its answer is dropped) and
	// a capped reply's rows past the shown ones: ENQueueEditor (shared with the Jam screen)
	ENQueueEditor *_editor;
	BOOL _swiping;               // a swipe's Remove button is up (willBegin / didEndEditingRowAtIndexPath:)
	BOOL _failing;               // an edit failed: its own path puts the rows back
	NSString *_editBanner;       // the last edit failure's banner text
	NSString *_jamRole;          // the Jam role the edit rules last saw: off / host / guest / lim
	// (3b) the bar, root only (presented by Now Playing): the chevron that closes Up Next and Now Playing, and the cover button
	// that flips back (the 0.10 "Done"'s job); both hidden while editing, so the header's Done is the only way out of it
	UIBarButtonItem *_closeItem, *_thumbItem;
	UIButton *_thumbButton;
	NSString *_thumbToken;       // the cover token shown (ENPlayback track.img), its load in flight, and the image last drawn
	NSString *_thumbKey;
	UIImage *_thumbSource;
	// (3b) the busy spinner and the empty state in the +queue palette (the list base draws its own in +current)
	UIActivityIndicatorView *_queueSpin;
	UIView *_queueEmpty;
	UILabel *_queueEmptyTitle, *_queueEmptyBody;
	NSUInteger _shownGen;        // bumped by showQueue: (new rows); _editingGen = its value when edit mode began
	NSUInteger _editingGen;
	BOOL _dragging;              // a row is under the finger (targetIndexPathForMove… until its drop)
	BOOL _rollbackDue;           // a failure (or a role change) during that drag: the rows go back after the drop
	BOOL _shuffle;               // the snapshot's shuffle the editable rows were last worked out with
	// (DESIGN-QUEUE §2.1, §5.2) tap to jump: the jump is out (_jumpOut), or answered but the refilled rows aren't shown yet
	// (_jumping covers both: edits, swipes, holds and taps wait). _jumpEpoch is bumped as a jump starts and as it is
	// answered: a GET sent before that is dropped. _heldTap: the uid of the row tapped while an edit was out (a newer tap
	// replaces it), sent once the edits settle if that row is still shown (never logged).
	BOOL _jumping, _jumpOut;
	NSUInteger _jumpEpoch;
	NSString *_heldTap;
	UILongPressGestureRecognizer *_hold;     // holding an editable row enters edit mode
}

- (id)init {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		self.title = ENL(@"Up Next");
		self.ignoresMiniPlayer = YES;
		self.meterName = @"upnext";
		_sections = @[];
		_editor = [ENQueueEditor new];
		_editor.delegate = self;
	}
	return self;
}

- (void)dealloc {
	[NSObject cancelPreviousPerformRequestsWithTarget:self];
	if (_thumbKey) [[ENImageCache shared] cancel:_thumbKey];
}

- (void)viewDidLoad {
	[super viewDidLoad];
	// (DESIGN-QUEUE) a tap on an upcoming row jumps to it (-jumpableAt: says which rows highlight); none while editing
	self.tableView.allowsSelection = YES;
	self.tableView.allowsSelectionDuringEditing = NO;
	_hold = [[UILongPressGestureRecognizer alloc] initWithTarget:self action:@selector(held:)];
	_hold.minimumPressDuration = ENQueueHoldTime;
	_hold.delegate = self;
	[self.tableView addGestureRecognizer:_hold];
	[self skinQueue];                              // (3b) the dark "flip side" in both themes
	[[ENTheme current] applyTitle:self.title toItem:self.navigationItem small:YES];     // the mockup's small "Up Next"
	if (self.navigationController.viewControllers.count && self.navigationController.viewControllers[0] == self) {
		_closeItem = [ENTheme barButtonWithGlyph:@"chevDown" target:self action:@selector(closeAll)];
		_thumbItem = [[UIBarButtonItem alloc] initWithCustomView:[self makeThumbButton]];
		self.navigationItem.leftBarButtonItem = _closeItem;
		self.navigationItem.rightBarButtonItem = _thumbItem;
		[self updateThumb];
	}
	_jamRole = [self jamRole];
	_shuffle = [ENPlayback shared].shuffle;
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(queueChanged) name:ENQueueChangedNotification object:nil];
	[nc addObserver:self selector:@selector(jamChanged) name:ENJamChangedNotification object:nil];
	[nc addObserver:self selector:@selector(playbackChanged) name:ENPlaybackChangedNotification object:nil];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	[self reload:NO];
}

- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	[self becomeFirstResponder];               // lock screen / AirPods while it is up
}

- (void)viewDidDisappear:(BOOL)animated {
	[super viewDidDisappear:animated];
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(debouncedReload) object:nil];
	// dismissed (not just covered by a sheet's own window or the picker): the controls go back to whoever is under it
	if (!self.presentedViewController) [[ENTabBarController shared] reclaimFirstResponder];
}

- (BOOL)canBecomeFirstResponder { return YES; }

- (void)remoteControlReceivedWithEvent:(UIEvent *)event {
	[[ENPlayback shared] handleRemoteEvent:event];
}

// the cover button: Up Next flips back to Now Playing (what 0.10's left "Done" did)
- (void)done {
	[self dismissViewControllerAnimated:YES completion:nil];
}

// (3b, DESIGN-5 §2.2 B3, §2.4 #6) the chevron: Up Next AND Now Playing go. Dismissed from Now Playing's presenter (the tab
// controller), so both leave in one animation; Up Next takes Now Playing's own cover-vertical slide for it (the mockup's whole
// card going down) instead of flipping back. Then the controls come back to the tab controller (UPN7). Edits still waiting
// go out afterwards: ENQueueEditor holds this screen until its FIFO drains. Not over another presented screen (no presenter
// below it): only Up Next closes. Ignored while either is still coming or going.
- (void)closeAll {
	UINavigationController *nav = self.navigationController;
	UIViewController *np = nav.presentingViewController;
	if (!np || nav.isBeingPresented || nav.isBeingDismissed) return;
	UIViewController *below = np.presentingViewController;
	if (!below) {
		[self done];
		return;
	}
	if (np.isBeingPresented || np.isBeingDismissed) return;
	nav.modalTransitionStyle = UIModalTransitionStyleCoverVertical;
	[below dismissViewControllerAnimated:YES completion:^{ [[ENTabBarController shared] reclaimFirstResponder]; }];
}

#pragma mark - the cover button (3b)

// a 32 pt glossy bar button (the bar buttons' own skin) holding the playing song's 28 pt cover; pressed, the cover dims
- (UIButton *)makeThumbButton {
	ENTheme *th = [ENTheme current];
	UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
	UIImage *bg = [th barButtonImageDone:NO pressed:NO];
	b.frame = CGRectMake(0, 0, ENQueueThumbButtonWidth, bg.size.height);
	[b setBackgroundImage:bg forState:UIControlStateNormal];
	[b setBackgroundImage:[th barButtonImageDone:NO pressed:YES] forState:UIControlStateHighlighted];
	b.imageEdgeInsets = UIEdgeInsetsMake(0, 0, 1, 0);     // centred on the pill (its last 1 pt is the highlight line under it)
	b.exclusiveTouch = YES;
	[b addTarget:self action:@selector(done) forControlEvents:UIControlEventTouchUpInside];
	_thumbButton = b;
	return b;
}

// The playing song's cover, as the mini player finds it: the 88 tier of track.img (memory at once, else the placeholder and
// one load), or ENPlayback's artwork when the song has no token; the placeholder until then. Runs on every playback change:
// nothing is redrawn unless the picture itself changed.
- (void)updateThumb {
	if (!_thumbButton) return;
	ENPlayback *pb = [ENPlayback shared];
	NSString *tok = ENJStr(pb.track[@"img"]);
	BOOL same = tok == _thumbToken || [tok isEqualToString:_thumbToken];
	if (!same && _thumbKey) {
		[[ENImageCache shared] cancel:_thumbKey];
		_thumbKey = nil;
	}
	if (!tok) {
		_thumbToken = nil;
		[self showThumb:pb.artwork];
		return;
	}
	if (same) return;
	_thumbToken = [tok copy];
	ENImageCache *cache = [ENImageCache shared];
	UIImage *mem = [cache memoryImage:tok size:ENImg88 round:NO];
	[self showThumb:mem];
	if (mem) return;
	__weak ENQueueViewController *w = self;
	_thumbKey = [[cache load:tok size:ENImg88 round:NO done:^(UIImage *image, NSString *key) {
		ENQueueViewController *s = w;
		if (!s) return;
		if ([key isEqualToString:s->_thumbKey]) s->_thumbKey = nil;
		if (image && [tok isEqualToString:s->_thumbToken]) [s showThumb:image];
	}] copy];
}

// the cover scaled once to 28 pt (an opaque image, so the button never scales a big picture), or +queue's placeholder (the
// same in both themes, like the rest of this chrome)
- (void)showThumb:(UIImage *)image {
	UIImage *src = image ?: [ENTheme queue].placeholderCover;
	if (src == _thumbSource) return;
	_thumbSource = src;
	UIImage *small = [ENTheme imageOfSize:CGSizeMake(ENQueueThumb, ENQueueThumb) opaque:YES drawing:^(CGContextRef c, CGSize size) {
		[src drawInRect:CGRectMake(0, 0, size.width, size.height)];
	}];
	[_thumbButton setImage:small forState:UIControlStateNormal];
}

#pragma mark - the +queue palette (3b)

// Up Next is the dark "flip side" in both themes (DESIGN-5 §1.3 "+queue"): the table, its indicator, the refresh tint, the
// spinner and the empty state; the cells and the section headers are set to +queue as they are handed out
- (void)skinQueue {
	ENTheme *q = [ENTheme queue];
	UITableView *tv = self.tableView;
	tv.backgroundColor = q.listBackground;
	tv.indicatorStyle = q.indicatorStyle;
	ENRefreshSetTint(self, q.refreshTint);
	_queueSpin.activityIndicatorViewStyle = q.spinnerStyle;
	[self skinQueueEmpty];
}

// the base re-skins the table in +current (a text size change, or a palette flip): +queue goes back over it; the visible
// cells and headers keep +queue (their palette is fixed)
- (void)themeDidChange {
	[super themeDidChange];
	[self skinQueue];
}

// The base's spinner and empty state are drawn in +current, so Up Next keeps its own in +queue, placed where the base puts
// them (no table header here): the spinner 44 pt down, centred; the empty state 50 pt down and 30 pt in from each side, the
// title 6 pt over the message. Same calls, same copy.
- (void)setBusy:(BOOL)busy {
	if (!busy) {
		[_queueSpin stopAnimating];
		[_queueSpin removeFromSuperview];
		return;
	}
	if (!_queueSpin) {
		_queueSpin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:[ENTheme queue].spinnerStyle];
		_queueSpin.hidesWhenStopped = YES;
		_queueSpin.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin | UIViewAutoresizingFlexibleRightMargin;
	}
	if (_queueSpin.superview != self.tableView) [self.tableView addSubview:_queueSpin];
	[self layoutQueueOverlays];
	[_queueSpin startAnimating];
}

- (void)setEmptyTitle:(NSString *)title message:(NSString *)message {
	if (!title.length && !message.length) {
		[_queueEmpty removeFromSuperview];
		return;
	}
	if (!_queueEmpty) {
		_queueEmpty = [[UIView alloc] initWithFrame:CGRectZero];
		_queueEmpty.userInteractionEnabled = NO;
		_queueEmpty.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		_queueEmptyTitle = [[UILabel alloc] initWithFrame:CGRectZero];
		_queueEmptyBody = [[UILabel alloc] initWithFrame:CGRectZero];
		for (UILabel *l in @[ _queueEmptyTitle, _queueEmptyBody ]) {
			l.textAlignment = NSTextAlignmentCenter;
			l.numberOfLines = 0;
			l.lineBreakMode = NSLineBreakByWordWrapping;
			l.shadowOffset = CGSizeMake(0, 1);
			[_queueEmpty addSubview:l];
		}
		[self skinQueueEmpty];
	}
	_queueEmptyTitle.text = title;
	_queueEmptyBody.text = message;
	if (_queueEmpty.superview != self.tableView) [self.tableView addSubview:_queueEmpty];
	[self layoutQueueOverlays];
}

- (void)skinQueueEmpty {
	if (!_queueEmpty) return;
	ENTheme *q = [ENTheme queue];
	_queueEmpty.backgroundColor = q.listBackground;
	for (UILabel *l in @[ _queueEmptyTitle, _queueEmptyBody ]) {
		l.backgroundColor = q.listBackground;
		l.shadowColor = q.emptyTextShadow;
	}
	_queueEmptyTitle.font = q.emptyTitleFont;
	_queueEmptyTitle.textColor = q.emptyTitle;
	_queueEmptyBody.font = q.emptyBodyFont;
	_queueEmptyBody.textColor = q.emptyBody;
}

- (void)layoutQueueOverlays {
	CGFloat w = self.tableView.bounds.size.width;
	if (_queueSpin) _queueSpin.center = CGPointMake(floorf(w / 2), 44);
	if (!_queueEmpty) return;
	CGFloat lw = w - 60, y = 0;
	NSString *t = _queueEmptyTitle.text, *m = _queueEmptyBody.text;
	CGSize fit = CGSizeMake(lw, 400);
	CGFloat titleH = t.length ? ceilf([t sizeWithFont:_queueEmptyTitle.font constrainedToSize:fit lineBreakMode:NSLineBreakByWordWrapping].height) : 0;
	CGFloat bodyH = m.length ? ceilf([m sizeWithFont:_queueEmptyBody.font constrainedToSize:fit lineBreakMode:NSLineBreakByWordWrapping].height) : 0;
	_queueEmptyTitle.frame = CGRectMake(0, 0, lw, titleH);
	if (titleH && bodyH) y = titleH + 6;
	_queueEmptyBody.frame = CGRectMake(0, y, lw, bodyH);
	_queueEmpty.frame = CGRectMake(30, 50, lw, y + bodyH);
}

#pragma mark - loading

- (void)queueChanged {
	if (!self.visible) return;                 // the next viewWillAppear loads anyway
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(debouncedReload) object:nil];
	[self performSelector:@selector(debouncedReload) withObject:nil afterDelay:0.3];
}

- (void)debouncedReload {
	if (self.visible) [self reload:NO];
}

- (NSString *)jamRole {
	ENJam *j = [ENJam shared];
	return !j.active ? @"off" : j.hosting ? @"host" : j.guest ? @"guest" : @"lim";
}

- (void)jamChanged {
	if (!self.isViewLoaded) return;
	NSString *role = [self jamRole];
	BOOL roleChanged = ![role isEqualToString:_jamRole];
	_jamRole = role;
	if (!_queue) return;
	[self updateEditButton];                   // a guest's Jam began: no Edit, and edit mode ends
	if (![self editBusy]) [self.tableView reloadData];     // "added by" names and avatars, the Jam header (never under a drag)
	if (roleChanged) [self queueChanged];      // the gateway's `ed` follows the role: ask for it (debounced)
}

// Shuffle on or off: whether the "Next From" rows may be edited (-editsSection:), so the Edit button follows. The rows'
// reorder controls are set again when edit mode begins; a swipe asks -editableAt: itself. Nothing reloads here: the
// engine republishes its reordered list, and that `queue` event reloads the screen as usual.
- (void)playbackChanged {
	[self updateThumb];                        // (3b) the cover button follows the song
	BOOL sh = [ENPlayback shared].shuffle;
	if (sh == _shuffle) return;
	_shuffle = sh;
	if (_queue) [self updateEditButton];
}

- (void)reload:(BOOL)fresh {
	// a queue event, the retry_ms re-poll or a pull during a load (its answer may be older) or while an edit is busy (the
	// rows show what the user did, not yet the gateway's answer): once more after it
	if (_loading || [self loadsWait]) {
		_again = YES;
		return;
	}
	_loading = YES;
	if (!_queue) [self setBusy:YES];
	NSUInteger gen = _editor.generation, epoch = _jumpEpoch;
	__weak ENQueueViewController *w = self;
	[[ENPlayback shared] loadQueue:^(ENQueue *q, BOOL notModified, NSError *e) {
		ENQueueViewController *s = w;
		if (!s) return;
		s->_loading = NO;
		[s setBusy:NO];
		[s finishRefreshing];
		// an edit is busy, or one began after this GET went out (even if it has settled by now): this answer may have read
		// the engine before that edit, so it is dropped and a fresh GET follows once the edits settle (at once if they have).
		// (DESIGN-QUEUE) The same for a jump out, or one that started or was answered after this GET went out.
		if ([s loadsWait] || gen != s->_editor.generation || epoch != s->_jumpEpoch) {
			s->_again = YES;
			[s editsSettled];
			return;
		}
		// (DESIGN-QUEUE §2.1) the first answer to a GET sent after the jump's reply ends the busy state and is shown, even a
		// 304 (the rows on screen are the optimistic ones, not that queue's)
		BOOL endsJump = s->_jumping;
		if (endsJump) [s endJump];
		if (e && e.code == 404) {
			[s showQueue:nil];
			[s setEmptyTitle:ENUpdateBridgeText message:nil];      // (an engine without Up Next: D8's one message)
		} else if (e) {
			s->_loadBanner = [[ENCatalog messageForError:e] copy];
			[s showError:e];
		} else {
			if (s->_loadBanner) [s hideBannerIfShowing:s->_loadBanner];
			s->_loadBanner = nil;
			if (q && (endsJump || !notModified || q != s->_queue)) [s showQueue:q];
		}
		if (s->_again) {                       // once more, with this answer's ETag
			s->_again = NO;
			if (s.visible) [s reload:NO];
		}
	}];
}

- (void)poll { [self reload:NO]; }

- (BOOL)refreshAnsweredSince:(NSDate *)start { return !_loading; }

- (void)showQueue:(ENQueue *)q {
	_queue = q;
	[_editor showing:q];                       // the newest queue, its rev; every row the gateway sent is on screen now
	_swiping = NO;                             // reloadData takes any Remove button away
	_dragging = NO;
	_shownGen++;
	NSMutableArray *secs = [NSMutableArray array];
	BOOL loadingRows = NO;
	if (q.now) {
		ENQueueSection *s = [ENQueueSection new];
		s.title = ENL(@"Now Playing");
		s.rows = @[ q.now ];
		s.kind = ENQueueSectionNow;
		[secs addObject:s];
	}
	if (q.queued.count) {
		ENQueueSection *s = [ENQueueSection new];
		s.title = q.jam ? ENL(@"Jam queue: everyone can add") : ENL(@"Next in Queue");
		s.jamHeader = q.jam;
		s.rows = q.queued;
		s.kind = ENQueueSectionQueue;
		[secs addObject:s];
	}
	if (q.contextRows.count) {
		ENQueueSection *s = [ENQueueSection new];
		s.title = q.contextName.length ? [NSString stringWithFormat:ENL(@"Next From: %@"), q.contextName] : ENL(@"Next From: This List");
		s.rows = q.contextRows;
		s.kind = ENQueueSectionContext;
		[secs addObject:s];
	}
	if (q.autoplayRows.count) {
		ENQueueSection *s = [ENQueueSection new];
		s.title = ENL(@"Autoplay: similar songs");
		s.rows = q.autoplayRows;
		s.kind = ENQueueSectionAutoplay;
		[secs addObject:s];
	}
	for (ENQueueSection *s in secs) for (ENTrack *t in s.rows) if (t.loading) loadingRows = YES;
	_sections = [secs copy];
	[self setEmptyTitle:((q && q.empty) ? ENL(@"Nothing queued") : nil) message:nil];
	[self.tableView reloadData];
	[self updateEditButton];
	// rows the engine had no metadata for yet: ask once more after retry_ms (its window prefetch fills them in)
	if (loadingRows && q.retryMs > 0 && !_retried) {
		_retried = YES;
		[self schedulePoll:q.retryMs / 1000.0];
	} else if (!loadingRows) {
		_retried = NO;
	}
}

#pragma mark - editing (4b-c, DESIGN-4b §6.10: remove and reorder, iOS 2-3 UITableView editing only)

// §4.4 "Who may edit": the gateway's `ed` (it already allows the host and a plan-B Jam started on a computer with Encore as
// the speaker, where Encore owns the queue); never as a guest, whatever the last queue said
- (BOOL)canEdit {
	ENJam *j = [ENJam shared];
	return _queue.editable && !(j.active && j.guest);
}

- (ENQueueSection *)sectionAt:(NSInteger)i {
	return i >= 0 && (NSUInteger)i < _sections.count ? _sections[(NSUInteger)i] : nil;
}

// The queue (q) section, and "Next From" (cq) while shuffle is off, or (DESIGN-QUEUE §5.2) while shuffled when the queue's
// `ops` says "shuffled" (engine patch 9): an older gateway (409 not_editable, "Turn shuffle off to change these songs.")
// and engine refuse every cq edit of a shuffled context, by the same snapshot shuffle. Never Now Playing or Autoplay.
- (BOOL)editsSection:(ENQueueSection *)s {
	if (s.kind == ENQueueSectionQueue) return YES;
	return s.kind == ENQueueSectionContext && (![ENPlayback shared].shuffle || _queue.editsShuffled);
}

- (ENTrack *)rowAt:(NSIndexPath *)ip {
	ENQueueSection *s = ip ? [self sectionAt:ip.section] : nil;
	return s && ip.row >= 0 && (NSUInteger)ip.row < s.rows.count ? s.rows[(NSUInteger)ip.row] : nil;
}

// (DESIGN-QUEUE §1.3, §2.1) a row swipe right moves to the top (Play Next): a queued, "Next From" or autoplay row with a
// uid, while the queue offers `top` and this phone may edit (never a guest), outside edit mode and a jump. A "Next From" row
// of a shuffled context also needs "shuffled".
- (BOOL)topableAt:(NSIndexPath *)ip {
	if (!_queue.canTop || ![self canEdit] || self.editing || _jumping) return NO;
	ENQueueSection *s = [self sectionAt:ip.section];
	if (!s || s.kind == ENQueueSectionNow) return NO;
	if (s.kind == ENQueueSectionContext && ![self editsSection:s]) return NO;
	ENTrack *t = [self rowAt:ip];
	return t.uid.length > 0 && t.playable;
}

// (DESIGN-QUEUE §1.4, §2.1) a row a tap jumps to: a queued, "Next From" or autoplay row that is playable and has a uid,
// while the queue offers `jump` (no Jam, or its host: never a guest), not while editing, a Remove button is up or a jump is
// out. An edit still out doesn't stop it: that tap is held (-tableView:didSelectRowAtIndexPath:).
- (BOOL)jumpableAt:(NSIndexPath *)ip {
	ENJam *j = [ENJam shared];
	if (!_queue.canJump || (j.active && j.guest) || self.editing || _swiping || _jumping) return NO;
	ENQueueSection *s = [self sectionAt:ip.section];
	if (!s || s.kind == ENQueueSectionNow) return NO;
	ENTrack *t = [self rowAt:ip];
	return t.uid.length > 0 && t.playable;
}

// the rows of those sections that have a uid
- (BOOL)editableAt:(NSIndexPath *)ip {
	if (![self canEdit]) return NO;
	ENQueueSection *s = [self sectionAt:ip.section];
	if (![self editsSection:s]) return NO;
	ENTrack *t = ip.row >= 0 && (NSUInteger)ip.row < s.rows.count ? s.rows[(NSUInteger)ip.row] : nil;
	return t.uid.length > 0;
}

- (BOOL)hasEditableRows {
	for (ENQueueSection *s in _sections) {
		if (![self editsSection:s]) continue;
		for (ENTrack *t in s.rows) if (t.uid.length) return YES;
	}
	return NO;
}

// edit mode, a Remove button, an edit waiting for its reply, or (DESIGN-QUEUE) a jump out: loads wait
- (BOOL)loadsWait {
	return self.editing || _swiping || _editor.busy || _jumpOut;
}

// the same, or a jump whose refilled rows aren't shown yet: nothing reloads under the finger or over the optimistic rows
- (BOOL)editBusy {
	return [self loadsWait] || _jumping;
}

// (3b, DESIGN-5 §2.2 B3) Edit / Done is the header action of "Next in Queue" (the Jam screen's pattern): Edit while this phone
// may edit and there is something to edit, Done while editing (kept while editing, so Done can end it). Edit mode ends when
// editing stops being allowed (a guest's Jam began, `ed` went away): while a row is being dragged, after its drop
// (-rollBackAfterDrop), so the table is never reloaded under the finger.
- (void)updateEditButton {
	BOOL can = [self canEdit];
	if (!can && self.editing) {
		if (_dragging) [self rollBackAfterDrop];
		else [self setEditing:NO animated:YES];
	}
	[self updateEditHeaders];
}

// the section whose header carries Edit / Done: Next in Queue, else Next From (whose rows shuffle may lock); -1 neither
- (NSInteger)editHeaderSection {
	NSInteger context = -1;
	for (NSUInteger i = 0; i < _sections.count; i++) {
		ENQueueSectionKind k = ((ENQueueSection *)_sections[i]).kind;
		if (k == ENQueueSectionQueue) return (NSInteger)i;
		if (k == ENQueueSectionContext && context < 0) context = (NSInteger)i;
	}
	return context;
}

// a header's action: Edit / Done on the edit header (as above), nothing on the others
- (void)skinEditHeader:(UIView<ENSectionHeader> *)v section:(NSInteger)section {
	NSString *title = nil;
	if (section == [self editHeaderSection])
		title = self.editing ? ENL(@"Done") : (!_jumping && [self canEdit] && [self hasEditableRows]) ? ENL(@"Edit") : nil;
	[v setActionTitle:title target:self action:@selector(tapEdit)];
}

// the headers on screen follow at once (one scrolled in later gets it in -tableView:viewForHeaderInSection:)
- (void)updateEditHeaders {
	if (!self.isViewLoaded) return;
	UITableView *tv = self.tableView;
	NSInteger n = [tv numberOfSections];
	for (NSInteger i = 0; i < n; i++) {
		UIView<ENSectionHeader> *v = ENSectionHeaderForSection(tv, i);      // (1.1: iOS 5's too)
		if (v) [self skinEditHeader:v section:i];
	}
}

- (void)tapEdit {
	[self setEditing:!self.editing animated:YES];
}

// After a removal (on the next turn, outside the table's own callback): the last editable row may have gone, and a section
// that emptied may have taken the edit header with it, so Done moves to the header that carries it now. In edit mode with
// neither a queue nor a Next From section left there is nothing left to edit and no header for Done: edit mode ends.
- (void)removalSettledLater {
	__weak ENQueueViewController *w = self;
	dispatch_async(dispatch_get_main_queue(), ^{
		ENQueueViewController *s = w;
		if (!s) return;
		if (s.editing && [s editHeaderSection] < 0 && !s->_dragging) [s setEditing:NO animated:YES];
		else [s updateEditButton];
	});
}

// The Edit / Done header action. While editing the chevron and the cover button (or the back button when pushed) are
// hidden, so the header's Done is the only one and the only way out; when editing ends the rows settle (a deferred reply or
// load is shown), or a rollback waiting for a drop runs now.
- (void)setEditing:(BOOL)editing animated:(BOOL)animated {
	if (editing == self.editing) return;
	if (editing && (![self canEdit] || _jumping)) return;     // (DESIGN-QUEUE) never while a jump is out
	// Edit tapped while a swipe's Remove button is up: the table is already editing that row and would take the whole-table
	// setEditing:YES as nothing to do (no reorder controls), so the swipe ends first
	if (editing && _swiping) [self.tableView setEditing:NO animated:NO];
	// (DESIGN-QUEUE) no hold while editing: the recognizer would take a held reorder grip's touches
	_hold.enabled = !editing;
	// the reorder controls as the rows are editable now (shuffle may have changed since a row was drawn)
	if (editing) for (NSIndexPath *ip in self.tableView.indexPathsForVisibleRows)
		[self.tableView cellForRowAtIndexPath:ip].showsReorderControl = [self editableAt:ip];
	[super setEditing:editing animated:animated];
	_swiping = NO;                             // entering or leaving edit mode takes any Remove button away
	_dragging = NO;
	if (editing) _editingGen = _shownGen;     // the rows every drop of this edit session must still be on
	if (_closeItem) {
		[self.navigationItem setLeftBarButtonItem:(editing ? nil : _closeItem) animated:animated];
		[self.navigationItem setRightBarButtonItem:(editing ? nil : _thumbItem) animated:animated];
	} else {
		[self.navigationItem setHidesBackButton:editing animated:animated];
	}
	[self updateEditHeaders];                  // Edit <-> Done
	if (editing) return;
	if (_rollbackDue) [self rollBack];
	else [self editsSettled];
}

// Edit mode is over, no Remove button is up and every edit has its reply: the newest gateway queue replaces the edited
// rows (the last reply, already in the user's order), a tap held meanwhile jumps (DESIGN-QUEUE), and a load asked for
// meanwhile runs. A load also runs once a jump has been answered (its refilled rows aren't shown yet).
- (void)editsSettled {
	if (_failing) return;
	if (![self editBusy]) {
		_heldTap = [_editor uidNow:_heldTap];  // a row topped since the tap has a new uid (before -showing: forgets it)
		ENQueue *latest = _editor.latest;
		if (latest && latest != _queue) [self showQueue:latest];
		if ([self sendHeldTap]) return;        // the jump's answer runs the load
	}
	[self runDeferredLoad];
}

// a load asked for while loads waited
- (void)runDeferredLoad {
	if (!_again || [self loadsWait]) return;
	_again = NO;
	if (self.visible) [self reload:NO];
}

// the shown q and cq rows (the optimistic edits applied), as +[ENQueueEditor keysForQueued:context:]
- (NSArray *)shownEditKeys {
	NSArray *q = @[], *cq = @[];
	for (ENQueueSection *s in _sections) {
		if (s.kind == ENQueueSectionQueue) q = s.rows;
		else if (s.kind == ENQueueSectionContext) cq = s.rows;
	}
	return [ENQueueEditor keysForQueued:q context:cq];
}

// The edits go out through ENQueueEditor: one at a time, in order, each with the rev of the reply before it (a change from
// elsewhere since then is refused as stale), and a reply that already shows such a change is handled as that refusal.
// It holds this screen until its FIFO drains, so edits still waiting go out after Done or Back too.
- (void)enqueueEdit:(ENTrack *)row before:(ENTrack *)before move:(BOOL)move context:(BOOL)context {
	NSArray *after = [self shownEditKeys];     // the callers have already applied it to the rows
	if (move) [_editor move:row before:before context:context shown:after];
	else [_editor remove:row context:context shown:after];
}

// ENQueueEditorDelegate: a reply matched (no HUD: the row has already moved or gone); with nothing waiting, the edits
// have settled
- (void)queueEditorDidApply:(ENQueueEditor *)editor {
	if (_editBanner) [self hideBannerIfShowing:_editBanner];
	_editBanner = nil;
	if (!_editor.busy) [self editsSettled];
}

// §6.10 Errors: the edits behind it are dropped (by the editor), the banner says why, edit mode ends, and the rows go back
// to the gateway's order: the newest queue known at once, then a fresh GET. e nil: a reply that showed more than this
// phone's own edit, handled as queue_changed.
- (void)queueEditor:(ENQueueEditor *)editor didFail:(NSError *)e {
	NSString *text = !e || [[ENCatalog codeOfError:e] isEqualToString:@"queue_changed"] ? ENL(@"Up Next changed, so it was refreshed.")
		: [ENCatalog messageForError:e];
	_editBanner = [text copy];
	[self showBanner:text];
	_heldTap = nil;                            // (DESIGN-QUEUE) a tap held behind the edits went with them
	[self rollBackAfterDrop];
}

// The rows go back to the newest queue the gateway confirmed and edit mode ends, but never under the finger: while a row
// is being dragged this waits for its drop (which is then refused: nothing is sent), ENQueueDropWait s at most. Until then
// edit mode stays on, so loads and replies still wait; Done runs it at once.
- (void)rollBackAfterDrop {
	if (!(self.editing && _dragging)) {
		[self rollBack];
		return;
	}
	if (_rollbackDue) return;
	_rollbackDue = YES;
	[self performSelector:@selector(rollBackIfDue) withObject:nil afterDelay:ENQueueDropWait];
}

- (void)rollBackIfDue {
	if (_rollbackDue) [self rollBack];
}

- (void)rollBack {
	_rollbackDue = NO;
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(rollBackIfDue) object:nil];
	_failing = YES;
	if (self.editing) [self setEditing:NO animated:YES];
	_failing = NO;
	[self showQueue:_editor.latest];
	_again = NO;
	if (self.visible) [self reload:NO];       // off screen (dismissed while edits were out): the next viewWillAppear loads
}

// Called back by UITableView inside its own update: a drop the model can't follow is put right on the next turn. Edit mode
// ends, so no further drop lands on rows the model doesn't match, and the table shows the model's rows again (with an
// edit out or waiting, its reply settles them; else the newest gateway queue is shown).
- (void)abandonEditsLater {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (self.editing) [self setEditing:NO animated:YES];
		if (self->_editor.busy) [self.tableView reloadData];
		else [self showQueue:self->_editor.latest];
	});
}

#pragma mark - hold, Play Next and tap to jump (DESIGN-QUEUE §2.1, §5.2)

// Holding an editable row for 0.5 s enters edit mode, as Edit does. Not while editing, a Remove button is up or a jump is
// out, and not on another row: then it never begins, so it takes no touches (a tap still selects, a reorder grip drags).
- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)g {
	if (g != _hold) return YES;
	if (self.editing || _swiping || _jumping) return NO;
	NSIndexPath *ip = [self.tableView indexPathForRowAtPoint:[g locationInView:self.tableView]];
	return ip && [self editableAt:ip];
}

- (void)held:(UILongPressGestureRecognizer *)g {
	if (g.state == UIGestureRecognizerStateBegan) [self setEditing:YES animated:YES];
}

// a tap: a jump, or held while an edit is out (one tap is kept, a newer one replaces it; -editsSettled sends it)
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	if (![self jumpableAt:ip]) return;
	if (_editor.busy) {
		_heldTap = [[self rowAt:ip].uid copy];
		return;
	}
	[self jumpAt:ip];
}

// only the rows a tap jumps to highlight (iOS 5: the list base asks this through ENTableRowHighlightable)
- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	return [self jumpableAt:ip];
}

- (NSIndexPath *)tableView:(UITableView *)tableView willSelectRowAtIndexPath:(NSIndexPath *)ip {
	return [self jumpableAt:ip] ? ip : nil;
}

// the held tap, once the edits have settled: sent if that row is still shown (and may still be tapped)
- (BOOL)sendHeldTap {
	NSString *uid = _heldTap;
	_heldTap = nil;
	if (!uid) return NO;
	for (NSUInteger i = 0; i < _sections.count; i++) {
		NSArray *rows = ((ENQueueSection *)_sections[i]).rows;
		for (NSUInteger r = 0; r < rows.count; r++) {
			if (![((ENTrack *)rows[r]).uid isEqualToString:uid]) continue;
			NSIndexPath *ip = [NSIndexPath indexPathForRow:(NSInteger)r inSection:(NSInteger)i];
			return [self jumpableAt:ip] && [self jumpAt:ip];
		}
	}
	return NO;
}

// §2.1: the jump goes out (ENPlayback's generation command: Now Playing shows loading, as on Next), then the rows change at
// once. The tapped row becomes the Now Playing row, and the rows above it in its section leave with it: for a queued row
// the queued rows above it; for a "Next From" row the context rows above it, while the queue stays (it plays right after,
// as in Spotify); for an autoplay row the autoplay rows above it and "Next From" too (the engine's position passes them).
// The screen stays busy (edits, swipes, holds, taps and loads wait) until a GET sent after the jump's answer is shown, the
// jump fails, or ENQueueJumpWait s pass. NO: nothing was sent (a Jam guest, no uid).
- (BOOL)jumpAt:(NSIndexPath *)ip {
	ENQueueSection *src = [self sectionAt:ip.section];
	ENTrack *row = [self rowAt:ip];
	if (!src || !row) return NO;
	NSUInteger epoch = ++_jumpEpoch;           // a GET out now may answer from before the jump: dropped
	__weak ENQueueViewController *w = self;
	if (![[ENPlayback shared] jumpToRow:row done:^(NSError *e) { [w jumpAnswered:e epoch:epoch]; }]) return NO;
	_jumping = YES;
	_jumpOut = YES;
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(jumpTimedOut) object:nil];
	[self performSelector:@selector(jumpTimedOut) withObject:nil afterDelay:ENQueueJumpWait];
	ENQueueSection *now = [ENQueueSection new];
	now.title = ENL(@"Now Playing");
	now.rows = @[ row ];
	now.kind = ENQueueSectionNow;
	NSMutableArray *secs = [NSMutableArray arrayWithObject:now];
	for (ENQueueSection *s in _sections) {
		if (s.kind == ENQueueSectionNow) continue;
		if (s.kind == ENQueueSectionContext && src.kind == ENQueueSectionAutoplay) continue;
		if (s == src) {
			NSUInteger from = (NSUInteger)ip.row + 1;
			if (from >= s.rows.count) continue;
			s.rows = [s.rows subarrayWithRange:NSMakeRange(from, s.rows.count - from)];
		}
		[secs addObject:s];
	}
	_sections = [secs copy];
	[self setEmptyTitle:nil message:nil];
	[self.tableView reloadData];
	return YES;
}

// The jump's answer. Success: a GET goes out now (one already out answers from before it: dropped, then sent again) and
// its answer, the refilled list, ends the busy state. Failure: a banner with the bridge's text ("Up Next changed, so it was
// refreshed." for queue_changed), the rows come back and a fresh load follows; the music goes on (ENPlayback).
- (void)jumpAnswered:(NSError *)e epoch:(NSUInteger)epoch {
	if (epoch != _jumpEpoch || !_jumpOut) return;     // timed out meanwhile: that path has reloaded
	_jumpOut = NO;
	_jumpEpoch++;
	if (e) {
		NSString *text = [[ENCatalog codeOfError:e] isEqualToString:@"queue_changed"] ? ENL(@"Up Next changed, so it was refreshed.")
			: [ENCatalog messageForError:e];
		_editBanner = [text copy];
		[self showBanner:text];
		[self endJump];
		[self showQueue:_queue];
	} else if (!self.visible) {
		[self endJump];                            // the next viewWillAppear loads
		return;
	}
	_again = YES;
	[self runDeferredLoad];
}

// no answer, or no refilled list, in ENQueueJumpWait s: the rows the gateway last sent come back, then a fresh load
- (void)jumpTimedOut {
	if (!_jumping) return;
	_jumpEpoch++;
	[self endJump];
	[self showQueue:_queue];
	_again = YES;
	[self runDeferredLoad];
}

- (void)endJump {
	_jumping = NO;
	_jumpOut = NO;
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(jumpTimedOut) object:nil];
	[self updateEditHeaders];                  // Edit is back
}

// Swipe right (ENListCell): Play Next on a row -topableAt: allows, else today's rule (Add to Queue / Add to Jam: Now
// Playing, an older bridge or engine, a guest). Nothing while a jump is out or a Remove button is up.
- (BOOL)listCellSwipeAllowed:(ENListCell *)cell {
	if (_jumping || _swiping) return NO;
	NSIndexPath *ip = [self.tableView indexPathForCell:cell];
	if (ip && [self topableAt:ip]) return YES;
	ENJam *jam = [ENJam shared];
	return !jam.active || [jam can:@"add"];
}

- (NSString *)listCellSwipeTitle:(ENListCell *)cell {
	NSIndexPath *ip = [self.tableView indexPathForCell:cell];
	if (ip && [self topableAt:ip]) return ENL(@"Play Next");
	return [super listCellSwipeTitle:cell];
}

- (void)listCellDidSwipeToQueue:(ENListCell *)cell {
	if (_jumping) return;
	NSIndexPath *ip = [self.tableView indexPathForCell:cell];
	ENTrack *t = [self rowAt:ip];
	if (!t || cell.item != t) return;          // the rows changed under the swipe: nothing is sent
	if ([self topableAt:ip]) [self topRowAt:ip];
	else [super listCellDidSwipeToQueue:cell];
}

// §2.1 Play Next: the row moves to the top of the queue section at once (a "Next From" or autoplay row leaves its section,
// with the section when it was its last row; the queue section is created after Now Playing when absent, titled as
// -showQueue: titles it, with the Jam header in a Jam), then one `top` edit goes out. A queued row already first: nothing.
- (void)topRowAt:(NSIndexPath *)ip {
	ENQueueSection *src = [self sectionAt:ip.section];
	ENTrack *row = [self rowAt:ip];
	if (!src || !row) return;
	BOOL queued = src.kind == ENQueueSectionQueue;
	if (queued && ip.row == 0) return;
	UITableView *tv = self.tableView;
	if (queued) {
		NSMutableArray *rows = [src.rows mutableCopy];
		[rows removeObjectAtIndex:(NSUInteger)ip.row];
		[rows insertObject:row atIndex:0];
		src.rows = rows;
		[tv moveRowAtIndexPath:ip toIndexPath:[NSIndexPath indexPathForRow:0 inSection:ip.section]];
	} else {
		NSMutableArray *secs = [_sections mutableCopy];
		NSMutableArray *rows = [src.rows mutableCopy];
		[rows removeObjectAtIndex:(NSUInteger)ip.row];
		BOOL dropSource = rows.count == 0;
		if (dropSource) [secs removeObject:src];
		else src.rows = rows;
		ENQueueSection *q = nil;
		for (ENQueueSection *s in secs) if (s.kind == ENQueueSectionQueue) q = s;
		BOOL newSection = q == nil;
		if (q) {
			q.rows = [@[ row ] arrayByAddingObjectsFromArray:q.rows];
		} else {
			q = [ENQueueSection new];
			q.title = _queue.jam ? ENL(@"Jam queue: everyone can add") : ENL(@"Next in Queue");
			q.jamHeader = _queue.jam;
			q.kind = ENQueueSectionQueue;
			q.rows = @[ row ];
			NSUInteger at = secs.count && ((ENQueueSection *)secs[0]).kind == ENQueueSectionNow ? 1 : 0;
			[secs insertObject:q atIndex:at];
		}
		NSUInteger qi = [secs indexOfObject:q];
		_sections = [secs copy];
		[tv beginUpdates];
		if (dropSource) [tv deleteSections:[NSIndexSet indexSetWithIndex:(NSUInteger)ip.section] withRowAnimation:UITableViewRowAnimationFade];
		else [tv deleteRowsAtIndexPaths:@[ ip ] withRowAnimation:UITableViewRowAnimationFade];
		if (newSection) [tv insertSections:[NSIndexSet indexSetWithIndex:qi] withRowAnimation:UITableViewRowAnimationTop];
		else [tv insertRowsAtIndexPaths:@[ [NSIndexPath indexPathForRow:0 inSection:(NSInteger)qi] ] withRowAnimation:UITableViewRowAnimationTop];
		[tv endUpdates];
	}
	[_editor top:row context:!queued shown:[self shownEditKeys]];
	[self removalSettledLater];                // Edit / Done may move to the new queue section's header
}

#pragma mark - table

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return (NSInteger)_sections.count; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return (NSInteger)[self sectionAt:section].rows.count;
}

// (3b) every header in +queue (dark in both themes); the Jam queue's keeps its green image; the edit header gets Edit / Done
- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	ENQueueSection *s = [self sectionAt:section];
	if (!s) return nil;
	UIView<ENSectionHeader> *v = [self sectionHeaderWithTitle:s.title];
	v.theme = [ENTheme queue];
	if (s.jamHeader) v.backgroundImage = v.theme.jamQueueHeaderImage;
	[self skinEditHeader:v section:section];
	return v;
}

// (3b) +queue rows with their length; a queued row says QUEUE and an autoplay row AUTOPLAY, unless a Jam member's avatar
// ("added by") takes that place (mockup: `by ? avatar : tag`); Now Playing and Next From rows have no tag
- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	ENTheme *q = [ENTheme queue];
	if (cell.theme != q) cell.theme = q;       // (fixed from then on: prepareForReuse keeps it)
	ENQueueSection *s = [self sectionAt:ip.section];
	ENTrack *t = (NSUInteger)ip.row < s.rows.count ? s.rows[(NSUInteger)ip.row] : nil;
	cell.showsReorderControl = t && [self editableAt:ip];
	if (!t) return cell;
	[cell showTrack:t art:ENCellArtCover playing:(s.kind == ENQueueSectionNow && t.playable)];
	cell.showsDuration = YES;
	ENJamMember *m = t.byMemberID ? [[ENJam shared] memberWithID:t.byMemberID] : nil;
	if (m && t.playable) {
		NSString *who = m.isMe ? ENL(@"you") : m.name;
		cell.subtitle = t.artists.length ? [NSString stringWithFormat:ENL(@"%@ · added by %@"), t.artists, who] : [NSString stringWithFormat:ENL(@"added by %@"), who];
		[cell setAvatarToken:m.imageToken name:m.name memberID:m.avatarKey];     // (R2a: masked while Anonymous Mode is on)
	} else if (s.kind == ENQueueSectionQueue) {
		cell.sourceTag = ENCellSourceQueue;
	} else if (s.kind == ENQueueSectionAutoplay) {
		cell.sourceTag = ENCellSourceAutoplay;
	}
	return cell;
}

- (BOOL)tableView:(UITableView *)tableView canEditRowAtIndexPath:(NSIndexPath *)ip {
	return !_jumping && [self editableAt:ip];  // also what offers swipe-to-remove outside edit mode (none while a jump is out)
}

- (BOOL)tableView:(UITableView *)tableView canMoveRowAtIndexPath:(NSIndexPath *)ip {
	return [self editableAt:ip];
}

- (UITableViewCellEditingStyle)tableView:(UITableView *)tableView editingStyleForRowAtIndexPath:(NSIndexPath *)ip {
	return [self editableAt:ip] ? UITableViewCellEditingStyleDelete : UITableViewCellEditingStyleNone;
}

- (BOOL)tableView:(UITableView *)tableView shouldIndentWhileEditingRowAtIndexPath:(NSIndexPath *)ip {
	return [self editableAt:ip];
}

- (NSString *)tableView:(UITableView *)tableView titleForDeleteConfirmationButtonForRowAtIndexPath:(NSIndexPath *)ip {
	return ENL(@"Remove");
}

// a swipe's Remove button (only for a swipe; edit mode itself goes through -setEditing:animated:)
- (void)tableView:(UITableView *)tableView willBeginEditingRowAtIndexPath:(NSIndexPath *)ip {
	_swiping = YES;
	_editingGen = _shownGen;                   // the rows its Remove must still be on
}

- (void)tableView:(UITableView *)tableView didEndEditingRowAtIndexPath:(NSIndexPath *)ip {
	_swiping = NO;
	__weak ENQueueViewController *w = self;
	dispatch_async(dispatch_get_main_queue(), ^{ [w editsSettled]; });     // not from inside the table's own callback
}

// A rollback was waiting for a drop (-rollBackAfterDrop): this callback refuses its edit, and the rows go back on the next
// turn, outside the table's own callback.
- (BOOL)refuseForRollback {
	_dragging = NO;
	if (!_rollbackDue) return NO;
	dispatch_async(dispatch_get_main_queue(), ^{ [self rollBackIfDue]; });
	return YES;
}

// Remove: the row leaves its section at once (with its header when it was the last), then the request goes out.
- (void)tableView:(UITableView *)tableView commitEditingStyle:(UITableViewCellEditingStyle)style forRowAtIndexPath:(NSIndexPath *)ip {
	if ([self refuseForRollback]) return;
	if (_editingGen != _shownGen) {            // the rows were replaced since the swipe or edit mode began: nothing is sent
		[self abandonEditsLater];
		return;
	}
	if (style != UITableViewCellEditingStyleDelete || ![self editableAt:ip]) return;
	ENQueueSection *s = [self sectionAt:ip.section];
	NSMutableArray *rows = [s.rows mutableCopy];
	ENTrack *row = rows[(NSUInteger)ip.row];
	[rows removeObjectAtIndex:(NSUInteger)ip.row];
	if (rows.count) {
		s.rows = rows;
		[tableView deleteRowsAtIndexPaths:@[ ip ] withRowAnimation:UITableViewRowAnimationFade];
	} else {
		NSMutableArray *secs = [_sections mutableCopy];
		[secs removeObjectAtIndex:(NSUInteger)ip.section];
		_sections = [secs copy];
		[tableView deleteSections:[NSIndexSet indexSetWithIndex:(NSUInteger)ip.section] withRowAnimation:UITableViewRowAnimationFade];
	}
	[self enqueueEdit:row before:nil move:NO context:(s.kind == ENQueueSectionContext)];
	[self removalSettledLater];                // the last editable row may have gone; Done may move to another header
}

// Reorder stays inside the row's own section: a proposal above it -> its first row, below it -> its last row. Called while
// a row is dragged, so it also marks the drag (a rollback waits for its drop).
- (NSIndexPath *)tableView:(UITableView *)tableView targetIndexPathForMoveFromRowAtIndexPath:(NSIndexPath *)from
       toProposedIndexPath:(NSIndexPath *)to {
	_dragging = YES;
	if (to.section == from.section) return to;
	NSInteger last = MAX((NSInteger)[self sectionAt:from.section].rows.count - 1, (NSInteger)0);
	return [NSIndexPath indexPathForRow:(to.section < from.section ? 0 : last) inSection:from.section];
}

// The table already shows the move: the section's rows follow it, then the request goes out with `before` = the row now
// after it in that section (nil at the end: ENQueueEditor then names the first row past the shown ones, if any). A drop that may not belong to the rows the model has (edit mode ended or the
// rows were replaced since the drag began, the row no longer editable, another section, an index out of range) sends
// nothing and the table is put right.
- (void)tableView:(UITableView *)tableView moveRowAtIndexPath:(NSIndexPath *)from toIndexPath:(NSIndexPath *)to {
	if ([self refuseForRollback]) return;
	if (from.section == to.section && from.row == to.row) return;
	ENQueueSection *s = [self sectionAt:from.section];
	NSUInteger n = s.rows.count;
	if (!self.editing || _editingGen != _shownGen || ![self editableAt:from] || from.section != to.section || to.row < 0
		|| (NSUInteger)to.row >= n) {
		[self abandonEditsLater];
		return;
	}
	NSMutableArray *rows = [s.rows mutableCopy];
	ENTrack *row = rows[(NSUInteger)from.row];
	[rows removeObjectAtIndex:(NSUInteger)from.row];
	[rows insertObject:row atIndex:(NSUInteger)to.row];
	s.rows = rows;
	ENTrack *before = (NSUInteger)to.row + 1 < rows.count ? rows[(NSUInteger)to.row + 1] : nil;
	[self enqueueEdit:row before:before move:YES context:(s.kind == ENQueueSectionContext)];
}

// Only Now Playing is marked: an upcoming row of the same song isn't the one being heard. A song change also brings a
// `queue` event (the engine republishes its upcoming list), which reloads the screen.
- (void)playbackSongChanged {}

@end

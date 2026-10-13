#import "ENListViewController.h"
#import "ENL.h"
#import "ENTheme.h"
#import "ENModel.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENTabBarController.h"
#import "ENTrackActions.h"
#import "ENDiag.h"
#import "ENJam.h"

static NSString *const ENSectionHeaderID = @"ENSectionHeader";

static BOOL ENSameString(NSString *a, NSString *b) { return a == b || [a isEqualToString:b]; }

#pragma mark - section header

// (1.1) the look both header classes share (ENSectionHeaderView on iOS 6, ENLegacySectionHeaderView on iOS 5), in one place
// so they can't drift: the background image's choice, the label's and the action's skin, the action's set-up, the layout
static UIImage *ENHeaderImage(UIImage *override, BOOL strong, ENTheme *th) {
	return override ?: (strong ? th.sectionHeaderStrongBackground : th.sectionHeaderBackground);
}

static void ENSkinHeaderLabel(UILabel *label, ENTheme *th) {
	label.font = th.headerFont;
	label.textColor = th.headerText;
	label.shadowColor = th.headerTextShadow;
	label.shadowOffset = th.headerTextShadowOffset;
}

static void ENSkinHeaderAction(UIButton *action, ENTheme *th) {
	action.titleLabel.font = th.headerFont;
	action.titleLabel.shadowOffset = th.headerTextShadowOffset;
	[action setTitleColor:th.headerText forState:UIControlStateNormal];
	[action setTitleColor:th.headerActionHighlighted forState:UIControlStateHighlighted];
	[action setTitleShadowColor:th.headerTextShadow forState:UIControlStateNormal];
}

// -setActionTitle:target:action: of either class: returns the action button (made, skinned and added to `container` on
// first use)
static UIButton *ENSetHeaderAction(UIButton *action, UIView *header, UIView *container, ENTheme *th, NSString *title, id target, SEL sel) {
	if (!title) {
		action.hidden = YES;
		[action removeTarget:nil action:NULL forControlEvents:UIControlEventAllEvents];
		return action;
	}
	if (!action) {
		action = [UIButton buttonWithType:UIButtonTypeCustom];
		action.contentHorizontalAlignment = UIControlContentHorizontalAlignmentRight;
		ENSkinHeaderAction(action, th);
		[container addSubview:action];
	}
	[action removeTarget:nil action:NULL forControlEvents:UIControlEventAllEvents];
	[action setTitle:title forState:UIControlStateNormal];
	[action addTarget:target action:sel forControlEvents:UIControlEventTouchUpInside];
	action.hidden = NO;
	[header setNeedsLayout];
	return action;
}

static void ENLayoutHeader(CGRect b, UILabel *label, UIButton *action) {
	BOOL act = action && !action.hidden;
	label.frame = CGRectMake(12, 0, b.size.width - 24 - (act ? 70 : 0), b.size.height);
	if (act) action.frame = CGRectMake(b.size.width - 82, 0, 70, b.size.height);
}

@interface ENSectionHeaderView ()
- (void)prepareWithTitle:(NSString *)title strong:(BOOL)strong;
@end

@interface ENLegacySectionHeaderView ()
- (void)prepareWithTitle:(NSString *)title strong:(BOOL)strong;
@end

@implementation ENSectionHeaderView {
	UILabel *_label;
	UIButton *_action;
	ENTheme *_theme;           // the palette in use (_fixedTheme, else +current when last re-skinned)
	ENTheme *_fixedTheme;      // `theme` as set (nil = follow +current)
}

- (id)initWithReuseIdentifier:(NSString *)rid {
	if ((self = [super initWithReuseIdentifier:rid])) {
		_label = [[UILabel alloc] initWithFrame:CGRectMake(12, 0, 296, 22)];
		_label.backgroundColor = [UIColor clearColor];
		[self.contentView addSubview:_label];
		[self reloadTheme];
	}
	return self;
}

- (void)setTitle:(NSString *)title {
	_title = [title copy];
	_label.text = title;
}

- (ENTheme *)theme { return _theme; }

- (void)setTheme:(ENTheme *)theme {
	_fixedTheme = theme;
	[self reloadTheme];
}

- (void)setStrong:(BOOL)strong {
	_strong = strong;
	[self applyBackground];
}

- (void)setBackgroundImage:(UIImage *)backgroundImage {
	_backgroundImage = backgroundImage;
	[self applyBackground];
}

// the base's dequeue: a fresh title on the default look (no override image, no fixed palette), then one re-skin
- (void)prepareWithTitle:(NSString *)title strong:(BOOL)strong {
	self.title = title;
	_backgroundImage = nil;
	_fixedTheme = nil;
	_strong = strong;
	[self setActionTitle:nil target:nil action:NULL];
	[self reloadTheme];
}

- (void)reloadTheme {
	ENTheme *th = _fixedTheme ?: [ENTheme current];
	_theme = th;
	[self applyBackground];
	ENSkinHeaderLabel(_label, th);
	if (_action) ENSkinHeaderAction(_action, th);
}

- (void)applyBackground {
	UIImage *img = ENHeaderImage(_backgroundImage, _strong, _theme);
	UIImageView *iv = [self.backgroundView isKindOfClass:[UIImageView class]] ? (UIImageView *)self.backgroundView : nil;
	if (!iv) self.backgroundView = [[UIImageView alloc] initWithImage:img];
	else if (iv.image != img) iv.image = img;
}

- (void)setActionTitle:(NSString *)title target:(id)target action:(SEL)action {
	_action = ENSetHeaderAction(_action, self, self.contentView, _theme, title, target, action);
}

- (void)layoutSubviews {
	[super layoutSubviews];
	ENLayoutHeader(self.contentView.bounds, _label, _action);
}

@end

// (1.1, iOS 5) ENSectionHeaderView's twin on a plain UIView: the image view stands in for backgroundView, the view itself for
// contentView (both cover the header there); everything else is the shared code above
@implementation ENLegacySectionHeaderView {
	UIImageView *_background;
	UILabel *_label;
	UIButton *_action;
	ENTheme *_theme;
	ENTheme *_fixedTheme;
}

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		_background = [[UIImageView alloc] initWithFrame:self.bounds];
		_background.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
		[self addSubview:_background];
		_label = [[UILabel alloc] initWithFrame:CGRectMake(12, 0, 296, 22)];
		_label.backgroundColor = [UIColor clearColor];
		[self addSubview:_label];
		[self reloadTheme];
	}
	return self;
}

- (void)setTitle:(NSString *)title {
	_title = [title copy];
	_label.text = title;
}

- (ENTheme *)theme { return _theme; }

- (void)setTheme:(ENTheme *)theme {
	_fixedTheme = theme;
	[self reloadTheme];
}

- (void)setStrong:(BOOL)strong {
	_strong = strong;
	[self applyBackground];
}

- (void)setBackgroundImage:(UIImage *)backgroundImage {
	_backgroundImage = backgroundImage;
	[self applyBackground];
}

- (void)prepareWithTitle:(NSString *)title strong:(BOOL)strong {
	self.title = title;
	_backgroundImage = nil;
	_fixedTheme = nil;
	_strong = strong;
	[self setActionTitle:nil target:nil action:NULL];
	[self reloadTheme];
}

- (void)reloadTheme {
	ENTheme *th = _fixedTheme ?: [ENTheme current];
	_theme = th;
	[self applyBackground];
	ENSkinHeaderLabel(_label, th);
	if (_action) ENSkinHeaderAction(_action, th);
}

- (void)applyBackground {
	UIImage *img = ENHeaderImage(_backgroundImage, _strong, _theme);
	if (_background.image != img) _background.image = img;
}

- (void)setActionTitle:(NSString *)title target:(id)target action:(SEL)action {
	_action = ENSetHeaderAction(_action, self, self, _theme, title, target, action);
}

- (void)layoutSubviews {
	[super layoutSubviews];
	ENLayoutHeader(self.bounds, _label, _action);
}

@end

#pragma mark - section header calls (1.1: iOS 5)

static BOOL ENHasHeaderFooterViews(void) {
	static int has = -1;
	if (has < 0) has = NSClassFromString(@"UITableViewHeaderFooterView")
		&& [UITableView instancesRespondToSelector:@selector(dequeueReusableHeaderFooterViewWithIdentifier:)] ? 1 : 0;
	return has == 1;
}

void ENRegisterSectionHeader(UITableView *tv, NSString *rid) {
	if (ENHasHeaderFooterViews()) [tv registerClass:[ENSectionHeaderView class] forHeaderFooterViewReuseIdentifier:rid];
}

UIView<ENSectionHeader> *ENDequeueSectionHeader(UITableView *tv, NSString *rid) {
	if (ENHasHeaderFooterViews()) {
		ENSectionHeaderView *v = [tv dequeueReusableHeaderFooterViewWithIdentifier:rid];
		if (!v) v = [[ENSectionHeaderView alloc] initWithReuseIdentifier:rid];
		return v;
	}
	CGFloat h = tv.sectionHeaderHeight > 0 ? tv.sectionHeaderHeight : 22;
	return [[ENLegacySectionHeaderView alloc] initWithFrame:CGRectMake(0, 0, tv.bounds.size.width, h)];
}

// iOS 5: the table's own subviews (and one level under them, in case a header is wrapped), never into the cells
static ENLegacySectionHeaderView *ENLegacyHeaderIn(UIView *v, CGRect sectionRect, UITableView *tv, NSUInteger depth) {
	for (UIView *s in v.subviews) {
		if ([s isKindOfClass:[UITableViewCell class]]) continue;
		if ([s isKindOfClass:[ENLegacySectionHeaderView class]]) {
			if (s.hidden) continue;
			CGFloat mid = CGRectGetMidY([s.superview convertRect:s.frame toView:tv]);
			if (mid >= CGRectGetMinY(sectionRect) && mid < CGRectGetMaxY(sectionRect)) return (ENLegacySectionHeaderView *)s;
			continue;
		}
		if (depth < 1) {
			ENLegacySectionHeaderView *found = ENLegacyHeaderIn(s, sectionRect, tv, depth + 1);
			if (found) return found;
		}
	}
	return nil;
}

UIView<ENSectionHeader> *ENSectionHeaderForSection(UITableView *tv, NSInteger section) {
	if (ENHasHeaderFooterViews()) {
		UITableViewHeaderFooterView *v = [tv headerViewForSection:section];
		return [v isKindOfClass:[ENSectionHeaderView class]] ? (ENSectionHeaderView *)v : nil;
	}
	if (section < 0 || section >= [tv numberOfSections]) return nil;
	return ENLegacyHeaderIn(tv, [tv rectForSection:section], tv, 0);
}

#pragma mark - list base

@implementation ENListViewController {
	BOOL _setUp, _modelsDropped, _resetPending, _pollWanted, _metering;
	BOOL _themeDirty;              // (A3) the theme or text size changed while hidden: -themeDidChange in viewWillAppear
	NSTimer *_pollTimer, *_refreshTimer;
	NSDate *_refreshStarted;
	NSString *_lastPlayingURI;
	UIButton *_banner;
	UIActivityIndicatorView *_bannerSpin;
	UIActivityIndicatorView *_busy;
	UIView *_emptyView;            // (A3) the empty state: a title over a message
	UILabel *_emptyTitleLabel, *_emptyBodyLabel;
	UIView *_footer;
	UILabel *_footerLabel;
	UIActivityIndicatorView *_footerSpin;
	NSString *_hintTitle, *_hintMessage;   // (3c, C1) -setFooterTitle:message: (nil = none)
	UIView *_hint;                         // its footer view: a title over a message, as the empty state
	UILabel *_hintTitleLabel, *_hintBodyLabel;
}

- (void)setUpDefaults {
	if (_setUp) return;
	_setUp = YES;
	_refreshable = YES;
	_meterName = [NSStringFromClass([self class]) copy];
}

- (id)initWithStyle:(UITableViewStyle)style {
	if ((self = [super initWithStyle:style])) [self setUpDefaults];
	return self;
}

- (id)initWithNibName:(NSString *)nib bundle:(NSBundle *)bundle {
	if ((self = [super initWithNibName:nib bundle:bundle])) [self setUpDefaults];
	return self;
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)viewDidLoad {
	[super viewDidLoad];
	ENTheme *th = [ENTheme current];
	UITableView *tv = self.tableView;
	tv.rowHeight = th.rowHeight;                // (A3) the Text size setting: 44 / 48 / 54
	tv.sectionHeaderHeight = 22;
	tv.separatorStyle = UITableViewCellSeparatorStyleNone;
	tv.backgroundView = nil;
	tv.backgroundColor = th.listBackground;
	tv.indicatorStyle = th.indicatorStyle;
	tv.opaque = YES;
	ENRegisterCellClass(tv, [ENListCell class], [ENListCell reuseIdentifier]);      // (1.1: iOS 5 too, ENCompat)
	ENRegisterSectionHeader(tv, ENSectionHeaderID);
	if (_refreshable) ENRefreshInstall(self, th.refreshTint, self, @selector(refreshPulled));     // (iOS 5: ENCompat's own)
	[self applyFooter];

	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(catalogChanged:) name:ENCatalogChangedNotification object:nil];
	[nc addObserver:self selector:@selector(playbackNote:) name:ENPlaybackChangedNotification object:nil];
	[nc addObserver:self selector:@selector(miniLayout:) name:ENMiniPlayerLayoutNotification object:nil];
	[nc addObserver:self selector:@selector(appActive:) name:UIApplicationDidBecomeActiveNotification object:nil];
	[nc addObserver:self selector:@selector(appBackground:) name:UIApplicationDidEnterBackgroundNotification object:nil];
	[nc addObserver:self selector:@selector(themeNote:) name:ENThemeDidChangeNotification object:nil];
	_lastPlayingURI = [[ENPlayback shared] playingURI];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	_visible = YES;
	if (_themeDirty) [self themeDidChange];
	[self applyMiniInset:[ENTabBarController shared].miniPlayerHeight];
	[self checkPlayingSong];
	if (_modelsDropped || _resetPending) {
		_modelsDropped = _resetPending = NO;
		[self reload:NO];
	}
}

- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	[self resumePoll];
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	_visible = NO;
	[_pollTimer invalidate];       // _pollWanted stays: one -poll when it shows again
	_pollTimer = nil;
	[self finishRefreshing];
	[self endMeter];
}

- (void)didReceiveMemoryWarning {
	[super didReceiveMemoryWarning];
	if (self.isViewLoaded && !self.view.window) {
		[self dropModels];
		_modelsDropped = YES;
	}
}

- (NSUInteger)supportedInterfaceOrientations { return UIInterfaceOrientationMaskPortrait; }

// (0.10, Drop 3a; DESIGN-5 §1.3 nav title, NAV7) every list title goes through -applyTitle:toItem:small:NO: a title over
// 172 pt in the 20 pt bar font (a long playlist, album or artist name) shows at 17 pt instead of being cut off, and a title
// over 13 characters gives the next screen a "Back" button. A foreign titleView (Search's field) is left alone; a screen
// that wants the small title calls -applyTitle:… small:YES after setting self.title.
- (void)setTitle:(NSString *)title {
	[super setTitle:title];
	[[ENTheme current] applyTitle:title toItem:self.navigationItem small:NO];
}

#pragma mark - for subclasses

- (void)reload:(BOOL)fresh {}
- (void)poll {}
- (void)dropModels {}
- (NSUInteger)menuOptionsForTrack:(ENTrack *)track { return ENTrackMenuDefault; }
- (BOOL)refreshAnsweredSince:(NSDate *)start { return ![ENCatalog shared].loading; }

// Only the speaker / green title moves: no row reloads (they would cancel and re-decode every visible cover, and close an
// open Liked "Remove" button). Lists without song rows (Playlists, Library) skip every cell at the class check.
- (void)playbackSongChanged {
	if (!self.isViewLoaded) return;
	ENPlayback *pb = [ENPlayback shared];
	for (UITableViewCell *c in self.tableView.visibleCells) {
		if (![c isKindOfClass:[ENListCell class]]) continue;
		ENListCell *cell = (ENListCell *)c;
		if (![cell.item isKindOfClass:[ENTrack class]]) continue;
		ENTrack *t = cell.item;
		cell.playing = t.playable && [pb isPlayingRow:t];       // as -showTrack:art:playing: decides it
	}
}

- (void)catalogChanged:(NSNotification *)note {
	if (![note.userInfo[ENCatalogKindKey] isEqualToString:ENCatalogKindReset]) return;
	if (_visible) [self reload:NO];
	else _resetPending = YES;
}

- (ENTrack *)trackAtIndexPath:(NSIndexPath *)indexPath {
	UITableViewCell *c = [self.tableView cellForRowAtIndexPath:indexPath];
	id item = [c isKindOfClass:[ENListCell class]] ? ((ENListCell *)c).item : nil;
	return [item isKindOfClass:[ENTrack class]] ? item : nil;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section { return 0; }

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
	return ENDequeueCell(tableView, [ENListCell reuseIdentifier], indexPath);
}

// (1.1, iOS 5) iOS 5 never asks a subclass's tableView:shouldHighlightRowAtIndexPath: (iOS 6 only): a row it refuses isn't
// selected there either (on iOS 6 such a row never gets here). ENListCell asks -listCellShouldHighlight: for the highlight.
- (NSIndexPath *)tableView:(UITableView *)tableView willSelectRowAtIndexPath:(NSIndexPath *)indexPath {
	if (!ENSystemIs6() && !ENTableRowHighlightable(self, tableView, indexPath)) return nil;
	return indexPath;
}

- (BOOL)listCellShouldHighlight:(ENListCell *)cell {
	if (!self.isViewLoaded) return YES;
	UITableView *tv = self.tableView;
	return ENTableRowHighlightable(self, tv, [tv indexPathForCell:cell]);
}

#pragma mark - notifications

// Hidden, or the app in the background / locked (viewWillDisappear: isn't called then): nothing now; viewWillAppear: and
// DidBecomeActive compare again.
- (void)playbackNote:(NSNotification *)n {
	if (!_visible || [UIApplication sharedApplication].applicationState != UIApplicationStateActive) return;
	[self checkPlayingSong];
}

- (void)checkPlayingSong {
	NSString *now = [[ENPlayback shared] playingURI];
	if (ENSameString(now, _lastPlayingURI)) return;
	_lastPlayingURI = now;
	[self playbackSongChanged];
}

- (void)miniLayout:(NSNotification *)n {
	[self applyMiniInset:[n.userInfo[ENMiniPlayerHeightKey] floatValue]];
}

// only .bottom: UIRefreshControl owns .top while it refreshes
- (void)applyMiniInset:(CGFloat)h {
	if (!self.isViewLoaded) return;
	if (_ignoresMiniPlayer) h = 0;
	UITableView *tv = self.tableView;
	UIEdgeInsets in = tv.contentInset;
	if (in.bottom != h) { in.bottom = h; tv.contentInset = in; }
	UIEdgeInsets si = tv.scrollIndicatorInsets;
	if (si.bottom != h) { si.bottom = h; tv.scrollIndicatorInsets = si; }
}

- (void)appActive:(NSNotification *)n {
	if (_visible) [self checkPlayingSong];
	[self resumePoll];
}

- (void)appBackground:(NSNotification *)n {
	[_pollTimer invalidate];
	_pollTimer = nil;
}

#pragma mark - theme (A3, DESIGN-5 §1.2)

// A palette flip or a text size change: re-skin now while visible, else in the next viewWillAppear (nothing hidden redraws)
- (void)themeNote:(NSNotification *)n {
	if (_visible) [self themeDidChange];
	else _themeDirty = YES;
}

- (void)themeDidChange {
	_themeDirty = NO;
	if (!self.isViewLoaded) return;
	ENTheme *th = [ENTheme current];
	UITableView *tv = self.tableView;
	tv.backgroundColor = th.listBackground;
	tv.indicatorStyle = th.indicatorStyle;
	ENRefreshSetTint(self, th.refreshTint);
	_busy.activityIndicatorViewStyle = th.spinnerStyle;
	[self skinFooter];
	[self skinHint];
	[self skinEmpty];
	[self layoutOverlays];
	for (UITableViewCell *c in tv.visibleCells)
		if ([c isKindOfClass:[ENListCell class]]) [(ENListCell *)c reloadTheme];
	NSInteger sections = [tv numberOfSections];
	for (NSInteger s = 0; s < sections; s++) [ENSectionHeaderForSection(tv, s) reloadTheme];     // (1.1: iOS 5's too)
	[self reloadForRowHeight:th.rowHeight];
}

// reloadData after a re-skin (LIST11): the selected rows stay selected, and when the row height changed (the text size) the
// row at the top stays at the top instead of the offset landing on other rows
- (void)reloadForRowHeight:(CGFloat)rowHeight {
	UITableView *tv = self.tableView;
	NSArray *selected = tv.indexPathsForSelectedRows;
	CGFloat oldHeight = tv.rowHeight, top = tv.contentOffset.y + tv.contentInset.top, into = 0;
	NSIndexPath *anchor = nil;
	if (oldHeight != rowHeight) {
		NSArray *visible = tv.indexPathsForVisibleRows;
		if (visible.count && top > 0 && oldHeight > 0) {
			NSIndexPath *first = visible[0];
			into = (top - [tv rectForRowAtIndexPath:first].origin.y) / oldHeight;      // how far into that row, as a fraction
			if (into >= 0) anchor = first;           // (a table header still showing at the top: the offset can stay)
		}
		tv.rowHeight = rowHeight;
	}
	[tv reloadData];
	NSInteger sections = [tv numberOfSections];
	for (NSIndexPath *ip in selected)
		if (ip.section < sections && ip.row < [tv numberOfRowsInSection:ip.section])
			[tv selectRowAtIndexPath:ip animated:NO scrollPosition:UITableViewScrollPositionNone];
	if (anchor && anchor.section < sections && anchor.row < [tv numberOfRowsInSection:anchor.section]) {
		[tv layoutIfNeeded];
		CGFloat minY = -tv.contentInset.top;
		CGFloat maxY = MAX(tv.contentSize.height + tv.contentInset.bottom - tv.bounds.size.height, minY);
		CGFloat y = [tv rectForRowAtIndexPath:anchor].origin.y + floorf(into * rowHeight) - tv.contentInset.top;
		tv.contentOffset = CGPointMake(tv.contentOffset.x, MIN(MAX(y, minY), maxY));
	}
}

// the swipe strip's label (ENListCellDelegate): what the swipe does, named as the ••• sheet names it
- (NSString *)listCellSwipeTitle:(ENListCell *)cell {
	return [ENJam shared].active ? ENL(@"Add to Jam") : ENL(@"Add to Queue");
}

#pragma mark - polling

- (void)schedulePoll:(NSTimeInterval)delay {
	_pollWanted = YES;
	[_pollTimer invalidate];
	_pollTimer = nil;
	if (!_visible || [UIApplication sharedApplication].applicationState != UIApplicationStateActive) return;
	_pollTimer = [NSTimer timerWithTimeInterval:MAX(delay, 0.5) target:self selector:@selector(pollFired) userInfo:nil repeats:NO];
	[[NSRunLoop mainRunLoop] addTimer:_pollTimer forMode:NSRunLoopCommonModes];
}

- (void)pollFired {
	_pollTimer = nil;
	_pollWanted = NO;
	if (_visible) [self poll];
}

- (void)resumePoll {
	if (!_pollWanted || _pollTimer || !_visible) return;
	if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) return;
	_pollWanted = NO;
	[self poll];
}

- (void)cancelPoll {
	_pollWanted = NO;
	[_pollTimer invalidate];
	_pollTimer = nil;
}

#pragma mark - pull to refresh

- (void)refreshPulled {
	_refreshStarted = [NSDate date];
	[self reload:YES];
	// A load that ends in a 304 calls nothing back, so also end the spinner once -refreshAnsweredSince: says so.
	[_refreshTimer invalidate];
	_refreshTimer = [NSTimer timerWithTimeInterval:0.25 target:self selector:@selector(refreshTick) userInfo:nil repeats:YES];
	[[NSRunLoop mainRunLoop] addTimer:_refreshTimer forMode:NSRunLoopCommonModes];
}

- (void)refreshTick {
	NSTimeInterval t = -[_refreshStarted timeIntervalSinceNow];
	if (!ENRefreshIsRefreshing(self) || (t > 0.6 && [self refreshAnsweredSince:_refreshStarted]) || t > 30) [self finishRefreshing];
}

- (void)finishRefreshing {
	[_refreshTimer invalidate];
	_refreshTimer = nil;
	ENRefreshEnd(self);
}

#pragma mark - banner, spinner, empty text, footer

- (void)showError:(NSError *)error {
	[self showBanner:[ENCatalog messageForError:error]];
}

- (void)showBanner:(NSString *)text {
	[self showBanner:text busy:NO];
}

// (A3) ENTheme's banner (§1.3, the same in both themes, mockup .banner): opaque yellow bannerImage, bold 12.5 text left-aligned
// 10 pt in, optionally led by a 16 pt grey spinner 7 pt before it; it slides down from under the bar when it appears.
- (void)showBanner:(NSString *)text busy:(BOOL)busy {
	if (!text.length) { [self hideBanner]; return; }
	ENTheme *th = [ENTheme current];
	UIFont *f = th.bannerFont;
	if (!_banner) {
		_banner = [UIButton buttonWithType:UIButtonTypeCustom];
		[_banner setBackgroundImage:th.bannerImage forState:UIControlStateNormal];
		_banner.adjustsImageWhenHighlighted = NO;
		_banner.titleLabel.font = f;
		_banner.titleLabel.numberOfLines = 3;
		_banner.titleLabel.textAlignment = NSTextAlignmentLeft;
		_banner.titleLabel.shadowOffset = CGSizeMake(0, 1);
		_banner.contentHorizontalAlignment = UIControlContentHorizontalAlignmentLeft;
		[_banner setTitleColor:th.bannerText forState:UIControlStateNormal];
		[_banner setTitleShadowColor:th.bannerTextShadow forState:UIControlStateNormal];
		_banner.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		[_banner addTarget:self action:@selector(hideBanner) forControlEvents:UIControlEventTouchUpInside];
		_bannerSpin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleGray];
		_bannerSpin.transform = CGAffineTransformMakeScale(0.8f, 0.8f);         // 20 pt -> 16 pt
		_bannerSpin.hidesWhenStopped = YES;
		_bannerSpin.userInteractionEnabled = NO;
		[_banner addSubview:_bannerSpin];
	}
	[_banner setTitle:text forState:UIControlStateNormal];
	UITableView *tv = self.tableView;
	CGFloat w = tv.bounds.size.width, lead = busy ? 16 + 7 : 0;
	CGFloat textH = [text sizeWithFont:f constrainedToSize:CGSizeMake(w - 20 - lead, 60) lineBreakMode:NSLineBreakByWordWrapping].height;
	CGFloat bh = MAX(30, ceilf(textH) + 12);
	_banner.contentEdgeInsets = UIEdgeInsetsMake(4, 10 + lead, 4, 10);
	_banner.bounds = CGRectMake(0, 0, w, bh);
	_bannerSpin.center = CGPointMake(10 + 8, floorf(bh / 2));
	if (busy) [_bannerSpin startAnimating];
	else [_bannerSpin stopAnimating];
	BOOL appearing = _banner.superview != tv;
	if (appearing) [tv addSubview:_banner];
	[self positionBanner];
	if (appearing) {               // (§2.4 #4) slides down from under the bar (the table clips it until then), .3 s
		_banner.transform = CGAffineTransformMakeTranslation(0, -bh);
		UIButton *b = _banner;
		[UIView animateWithDuration:0.3 delay:0 options:UIViewAnimationOptionCurveEaseOut | UIViewAnimationOptionAllowUserInteraction
		                 animations:^{ b.transform = CGAffineTransformIdentity; } completion:nil];
	}
}

- (void)hideBanner {
	_banner.transform = CGAffineTransformIdentity;
	[_bannerSpin stopAnimating];
	[_banner removeFromSuperview];
}

- (void)hideBannerIfShowing:(NSString *)text {
	if (_banner.superview && [[_banner titleForState:UIControlStateNormal] isEqualToString:text]) [self hideBanner];
}

// The banner floats over the top of the visible rows (it never pushes them); while the list is pulled down it stays on
// the content's top edge so the refresh control shows above it. (Placed by its centre: its slide-in runs on the transform.)
- (void)positionBanner {
	UITableView *tv = self.tableView;
	CGSize size = _banner.bounds.size;
	CGFloat y = MAX(tv.contentOffset.y + tv.contentInset.top, 0);
	_banner.center = CGPointMake(size.width / 2, y + size.height / 2);
	[tv bringSubviewToFront:_banner];
}

- (void)setBusy:(BOOL)busy {
	if (!busy) {
		[_busy stopAnimating];
		[_busy removeFromSuperview];
		return;
	}
	if (!_busy) {
		_busy = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:[ENTheme current].spinnerStyle];
		_busy.hidesWhenStopped = YES;
		_busy.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin | UIViewAutoresizingFlexibleRightMargin;
	}
	if (_busy.superview != self.tableView) [self.tableView addSubview:_busy];
	[self layoutOverlays];
	[_busy startAnimating];
}

- (void)setEmptyText:(NSString *)text {
	[self setEmptyTitle:text message:nil];
}

- (void)setEmptyTitle:(NSString *)title message:(NSString *)message {
	if (!title.length && !message.length) { [_emptyView removeFromSuperview]; return; }
	if (!_emptyView) {
		_emptyView = [[UIView alloc] initWithFrame:CGRectZero];
		_emptyView.userInteractionEnabled = NO;
		_emptyView.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		_emptyTitleLabel = [[UILabel alloc] initWithFrame:CGRectZero];
		_emptyBodyLabel = [[UILabel alloc] initWithFrame:CGRectZero];
		for (UILabel *l in @[ _emptyTitleLabel, _emptyBodyLabel ]) {
			l.textAlignment = NSTextAlignmentCenter;
			l.numberOfLines = 0;
			l.lineBreakMode = NSLineBreakByWordWrapping;
			l.shadowOffset = CGSizeMake(0, 1);
			[_emptyView addSubview:l];
		}
		[self skinEmpty];
	}
	_emptyTitleLabel.text = title;
	_emptyBodyLabel.text = message;
	if (_emptyView.superview != self.tableView) [self.tableView addSubview:_emptyView];
	[self layoutOverlays];
}

// (3c, C1) what the empty state and the footer sit on: the list colour (opaque), or a subclass's clear (Home)
- (UIColor *)listOverlayColor {
	return [ENTheme current].listBackground;
}

// the empty state's colours (mockup .empty / .theme-dark .empty: Light's white shadow, none in Dark)
- (void)skinEmpty {
	if (!_emptyView) return;
	ENTheme *th = [ENTheme current];
	UIColor *bg = [self listOverlayColor] ?: th.listBackground;
	_emptyView.backgroundColor = bg;
	for (UILabel *l in @[ _emptyTitleLabel, _emptyBodyLabel ]) {
		l.backgroundColor = bg;
		l.shadowColor = th.emptyTextShadow;
	}
	_emptyTitleLabel.font = th.emptyTitleFont;
	_emptyTitleLabel.textColor = th.emptyTitle;
	_emptyBodyLabel.font = th.emptyBodyFont;
	_emptyBodyLabel.textColor = th.emptyBody;
}

// spinner and empty state sit under the table header (a list's 136 pt header, Search has none); the empty state as the
// mockup's .empty: 50 pt down, 30 pt in from each side, the title 6 pt over the message
- (void)layoutOverlays {
	UITableView *tv = self.tableView;
	CGFloat top = tv.tableHeaderView.frame.size.height, w = tv.bounds.size.width;
	if (_busy) _busy.center = CGPointMake(floorf(w / 2), top + 44);
	if (_emptyView) {
		CGFloat lw = w - 60, y = 0;
		NSString *t = _emptyTitleLabel.text, *m = _emptyBodyLabel.text;
		CGSize fit = CGSizeMake(lw, 400);
		CGFloat titleH = t.length ? ceilf([t sizeWithFont:_emptyTitleLabel.font constrainedToSize:fit lineBreakMode:NSLineBreakByWordWrapping].height) : 0;
		CGFloat bodyH = m.length ? ceilf([m sizeWithFont:_emptyBodyLabel.font constrainedToSize:fit lineBreakMode:NSLineBreakByWordWrapping].height) : 0;
		_emptyTitleLabel.frame = CGRectMake(0, 0, lw, titleH);
		if (titleH && bodyH) y = titleH + 6;
		_emptyBodyLabel.frame = CGRectMake(0, y, lw, bodyH);
		_emptyView.frame = CGRectMake(30, top + 50, lw, y + bodyH);
	}
}

- (void)setFooterText:(NSString *)footerText {
	_footerText = [footerText copy];
	if (self.isViewLoaded) [self applyFooter];
}

- (void)setFooterBusy:(BOOL)footerBusy {
	_footerBusy = footerBusy;
	if (self.isViewLoaded) [self applyFooter];
}

- (void)applyFooter {
	UITableView *tv = self.tableView;
	if (!_footerText.length && !_footerBusy) {
		[_footerSpin stopAnimating];
		UIView *hint = [self hintFooter];       // (3c) the hint footer when one is set (else none, as before); set again
		if (hint) tv.tableFooterView = hint;    // each time, so the table takes a new height
		else if (tv.tableFooterView) tv.tableFooterView = nil;
		return;
	}
	ENTheme *th = [ENTheme current];
	CGFloat w = tv.bounds.size.width;
	if (!_footer) {
		_footer = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, 54)];
		_footerLabel = [[UILabel alloc] initWithFrame:CGRectZero];
		_footerLabel.shadowOffset = CGSizeMake(0, 1);
		[_footer addSubview:_footerLabel];
		_footerSpin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:th.spinnerStyle];
		_footerSpin.hidesWhenStopped = YES;
		[_footer addSubview:_footerSpin];
		[self skinFooter];
	}
	NSString *text = _footerText ?: @"";
	_footerLabel.text = text;
	CGFloat tw = MIN(ceilf([text sizeWithFont:th.footerFont].width), w - 60);
	CGFloat sw = _footerBusy ? 26 : 0, x = floorf((w - tw - sw) / 2);
	_footerSpin.center = CGPointMake(x + 10, 27);
	_footerLabel.frame = CGRectMake(x + sw, 17, tw, 20);
	if (_footerBusy) [_footerSpin startAnimating];
	else [_footerSpin stopAnimating];
	if (tv.tableFooterView != _footer) tv.tableFooterView = _footer;
}

// (3c, C1) the empty state's look under the last row (see the header); footerText / footerBusy win while either is set
- (void)setFooterTitle:(NSString *)title message:(NSString *)message {
	_hintTitle = title.length ? [title copy] : nil;
	_hintMessage = message.length ? [message copy] : nil;
	if (self.isViewLoaded) [self applyFooter];
}

// the hint footer for the current texts at the table's width (nil without texts): the mockup's .empty with its top padding
// cut to 30 pt (Search's hint), 50 pt under it, 30 pt sides, the title 6 pt over the message
- (UIView *)hintFooter {
	if (!_hintTitle && !_hintMessage) return nil;
	if (!_hint) {
		_hint = [[UIView alloc] initWithFrame:CGRectZero];
		_hint.userInteractionEnabled = NO;
		_hintTitleLabel = [[UILabel alloc] initWithFrame:CGRectZero];
		_hintBodyLabel = [[UILabel alloc] initWithFrame:CGRectZero];
		for (UILabel *l in @[ _hintTitleLabel, _hintBodyLabel ]) {
			l.textAlignment = NSTextAlignmentCenter;
			l.numberOfLines = 0;
			l.lineBreakMode = NSLineBreakByWordWrapping;
			l.shadowOffset = CGSizeMake(0, 1);
			[_hint addSubview:l];
		}
		[self skinHint];
	}
	_hintTitleLabel.text = _hintTitle;
	_hintBodyLabel.text = _hintMessage;
	CGFloat w = self.tableView.bounds.size.width, lw = w - 60;
	CGSize fit = CGSizeMake(lw, 400);
	NSLineBreakMode wrap = NSLineBreakByWordWrapping;
	CGFloat titleH = _hintTitle ? ceilf([_hintTitle sizeWithFont:_hintTitleLabel.font constrainedToSize:fit lineBreakMode:wrap].height) : 0;
	CGFloat bodyH = _hintMessage ? ceilf([_hintMessage sizeWithFont:_hintBodyLabel.font constrainedToSize:fit lineBreakMode:wrap].height) : 0;
	CGFloat bodyY = 30 + titleH + (titleH && bodyH ? 6 : 0);
	_hintTitleLabel.frame = CGRectMake(30, 30, lw, titleH);
	_hintBodyLabel.frame = CGRectMake(30, bodyY, lw, bodyH);
	_hint.frame = CGRectMake(0, 0, w, bodyY + bodyH + 50);
	return _hint;
}

// the hint footer's colours: the empty state's (emptyTitle / emptyBody, Light's white shadow) on listOverlayColor
- (void)skinHint {
	if (!_hint) return;
	ENTheme *th = [ENTheme current];
	UIColor *bg = [self listOverlayColor] ?: th.listBackground;
	_hint.backgroundColor = bg;
	for (UILabel *l in @[ _hintTitleLabel, _hintBodyLabel ]) {
		l.backgroundColor = bg;
		l.shadowColor = th.emptyTextShadow;
	}
	_hintTitleLabel.font = th.emptyTitleFont;
	_hintTitleLabel.textColor = th.emptyTitle;
	_hintBodyLabel.font = th.emptyBodyFont;
	_hintBodyLabel.textColor = th.emptyBody;
}

// the footer's colours (footerText; Light's white shadow, none in Dark) and its spinner's style
- (void)skinFooter {
	if (!_footer) return;
	ENTheme *th = [ENTheme current];
	UIColor *bg = [self listOverlayColor] ?: th.listBackground;
	_footer.backgroundColor = bg;
	_footerLabel.font = th.footerFont;
	_footerLabel.textColor = th.footerText;
	_footerLabel.backgroundColor = bg;
	_footerLabel.shadowColor = th.footerTextShadow;
	_footerSpin.activityIndicatorViewStyle = th.spinnerStyle;
}

#pragma mark - helpers

- (void)scrollToTop {
	if (!self.isViewLoaded) return;
	UITableView *tv = self.tableView;
	[tv setContentOffset:CGPointMake(0, -tv.contentInset.top) animated:YES];
}

- (void)reloadVisibleRows {
	if (!self.isViewLoaded) return;
	NSArray *ips = [self.tableView indexPathsForVisibleRows];
	if (ips.count) [self.tableView reloadRowsAtIndexPaths:ips withRowAnimation:UITableViewRowAnimationNone];
}

- (UIView<ENSectionHeader> *)sectionHeaderWithTitle:(NSString *)title {
	return [self sectionHeaderWithTitle:title strong:NO];
}

- (UIView<ENSectionHeader> *)strongSectionHeaderWithTitle:(NSString *)title {
	return [self sectionHeaderWithTitle:title strong:YES];
}

// every dequeue resets the header (no override image, no fixed palette, no action) and re-skins it from +current (1.1: on
// iOS 5 a new ENLegacySectionHeaderView each time)
- (UIView<ENSectionHeader> *)sectionHeaderWithTitle:(NSString *)title strong:(BOOL)strong {
	UIView<ENSectionHeader> *v = ENDequeueSectionHeader(self.tableView, ENSectionHeaderID);
	[(id)v prepareWithTitle:title strong:strong];
	return v;
}

#pragma mark - ••• and the scroll meter

// swipe right on a song row: queue it (in a Jam, Add to Jam), with the usual HUD
- (void)listCellDidSwipeToQueue:(ENListCell *)cell {
	NSIndexPath *ip = [self.tableView indexPathForCell:cell];
	ENTrack *t = ip ? [self trackAtIndexPath:ip] : nil;
	if (t.playable) [ENTrackActions addToQueue:t];
}

- (void)listCellDidTapMore:(ENListCell *)cell {
	NSIndexPath *ip = [self.tableView indexPathForCell:cell];
	ENTrack *t = ip ? [self trackAtIndexPath:ip] : nil;
	if (!t.playable) return;
	__weak ENListViewController *w = self;
	[ENTrackActions showMenuForTrack:t from:self options:[self menuOptionsForTrack:t] busy:^(BOOL on) {
		ENListViewController *s = w;
		if (!s || !s.isViewLoaded) return;
		for (UITableViewCell *c in s.tableView.visibleCells)       // the cell may have been reused meanwhile
			if ([c isKindOfClass:[ENListCell class]] && ((ENListCell *)c).item == t) ((ENListCell *)c).moreBusy = on;
	}];
}

- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView {
	if (_metering) return;
	_metering = YES;
	[ENDiag scrollBegan:self.meterName ?: @"list"];
}

- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView willDecelerate:(BOOL)decelerate {
	ENRefreshDragEnded(self);          // (1.1) iOS 5's pull to refresh (nothing on iOS 6)
	if (!decelerate) [self endMeter];
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView { [self endMeter]; }

- (void)scrollViewDidScroll:(UIScrollView *)scrollView {
	ENRefreshScrolled(self);           // (1.1) iOS 5's pull to refresh (nothing on iOS 6)
	if (_banner.superview) [self positionBanner];
}

- (void)endMeter {
	if (!_metering) return;
	_metering = NO;
	[ENDiag scrollEnded];
}

@end

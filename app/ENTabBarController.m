#import "ENTabBarController.h"
#import "ENMiniPlayer.h"
#import "ENNowPlayingViewController.h"
#import "ENHomeViewController.h"
#import "ENSearchViewController.h"
#import "ENPlaylistsViewController.h"
#import "ENLibraryViewController.h"
#import "ENSettingsViewController.h"
#import "ENPlayback.h"
#import "ENCatalog.h"
#import "ENTheme.h"
#import "ENAppDelegate.h"
#import "ENJam.h"
#import "ENJamBar.h"
#import "ENJamActions.h"
#import "ENJamViewController.h"
#import "ENAnon.h"
#import "ENL.h"

NSString *const ENMiniPlayerLayoutNotification = @"ENMiniPlayerLayout";
NSString *const ENMiniPlayerHeightKey = @"height";

static const CGFloat ENMiniHeight = 46;
static const NSTimeInterval ENBarSlide = 0.25;       // 0.10: the mini player / Jam bar slide (ease-out, from where they are)
static __weak ENTabBarController *ENTabShared;

@implementation ENTabBarController {
	ENMiniPlayer *_mini;
	BOOL _miniShown, _started, _appeared, _appActive;
	ENJamBar *_jamBar;                 // 0.6: over the mini player while a Jam is on; 3b: or while another device plays (Connect)
	BOOL _barShown;
	CGFloat _overlay;                  // the height last posted with ENMiniPlayerLayoutNotification
	NSUInteger _slideGen;              // 0.10: bumped by every slide; only the newest one's end may hide a bar
}

+ (ENTabBarController *)shared { return ENTabShared; }

- (id)init {
	if ((self = [super initWithNibName:nil bundle:nil])) {
		ENTabShared = self;
		_appActive = [UIApplication sharedApplication].applicationState == UIApplicationStateActive;
		// 0.11 (Drop 3b, DESIGN-5 §2.2 B5): the grouped Settings screen; the Phase 2 screen is now its About → Diagnostics
		ENSettingsViewController *settings = [[ENSettingsViewController alloc] init];
		settings.title = ENL(@"Settings");
		self.viewControllers = @[
			[self navWithRoot:[[ENHomeViewController alloc] initWithStyle:UITableViewStylePlain] title:ENL(@"Home") tab:ENTabHome],
			[self navWithRoot:[[ENSearchViewController alloc] initWithStyle:UITableViewStylePlain] title:ENL(@"Search") tab:ENTabSearch],
			[self navWithRoot:[[ENPlaylistsViewController alloc] initWithStyle:UITableViewStylePlain] title:ENL(@"Playlists") tab:ENTabPlaylists],
			[self navWithRoot:[[ENLibraryViewController alloc] initWithStyle:UITableViewStylePlain] title:ENL(@"Library") tab:ENTabLibrary],
			[self navWithRoot:settings title:ENL(@"Settings") tab:ENTabSettings] ];
		self.selectedIndex = ENTabHome;
		self.delegate = self;
	}
	return self;
}

// 0.10: the finished icons (ENTheme's v3 PNGs: lime gloss on, grey-green off) and the label tokens; no plain image, so
// iOS never tints a mask and the old v2 icons are never drawn
- (UINavigationController *)navWithRoot:(UIViewController *)root title:(NSString *)title tab:(ENTab)tab {
	ENTheme *th = [ENTheme current];
	UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:root];
	UITabBarItem *item = [[UITabBarItem alloc] initWithTitle:title image:nil tag:tab];
	[item setFinishedSelectedImage:[th finishedTabIconAtIndex:tab selected:YES]
	   withFinishedUnselectedImage:[th finishedTabIconAtIndex:tab selected:NO]];
	NSDictionary *off = @{ UITextAttributeTextColor: th.tabLabelOff, UITextAttributeTextShadowColor: [UIColor clearColor],
	                       UITextAttributeFont: th.tabLabelFont };
	NSDictionary *on = @{ UITextAttributeTextColor: th.tabLabelOn, UITextAttributeTextShadowColor: [UIColor clearColor],
	                      UITextAttributeFont: th.tabLabelFont };
	[item setTitleTextAttributes:off forState:UIControlStateNormal];
	[item setTitleTextAttributes:on forState:UIControlStateHighlighted];     // the selected item on iOS 5/6
	[item setTitleTextAttributes:on forState:UIControlStateSelected];
	nav.tabBarItem = item;
	return nav;
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];
	[_mini setActive:NO];          // its timer would keep it alive
}

- (void)viewDidLoad {
	[super viewDidLoad];
	ENTheme *th = [ENTheme current];
	UITabBar *bar = self.tabBar;
	bar.backgroundImage = th.tabBarBackground;
	bar.selectionIndicatorImage = th.tabSelectionIndicator;

	_mini = [[ENMiniPlayer alloc] initWithFrame:[self miniFrame]];
	_mini.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleTopMargin;
	_mini.hidden = YES;
	__weak ENTabBarController *w = self;
	_mini.onTap = ^{ [w presentNowPlaying]; };
	[self.view addSubview:_mini];

	_jamBar = [[ENJamBar alloc] initWithFrame:[self barFrame]];
	_jamBar.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleTopMargin;
	_jamBar.hidden = YES;
	_jamBar.onTap = ^{ [w jamBarTapped]; };
	[self.view addSubview:_jamBar];

	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(playbackChanged) name:ENPlaybackChangedNotification object:nil];
	[nc addObserver:self selector:@selector(jamChanged) name:ENJamChangedNotification object:nil];
	[nc addObserver:self selector:@selector(jamChanged) name:ENAnonChangedNotification object:nil];    // (R2a) the bar's names
	[nc addObserver:self selector:@selector(reclaimFirstResponder) name:UIKeyboardDidHideNotification object:nil];
	[nc addObserver:self selector:@selector(appActive) name:UIApplicationDidBecomeActiveNotification object:nil];
	[nc addObserver:self selector:@selector(appInactive) name:UIApplicationWillResignActiveNotification object:nil];
	[nc addObserver:self selector:@selector(appInactive) name:UIApplicationDidEnterBackgroundNotification object:nil];
	[self raiseBars];
	[self jamChanged];                 // the mini player, and the Jam / Connect bar with its text
}

// 0.10: where the mini player stands for its state: shown, directly above the tab bar; hidden, behind the tab bar (it slides
// down under it: the mockup's z-order, tab bar over mini player)
- (CGRect)miniFrame {
	CGFloat top = CGRectGetMinY(self.tabBar.frame);
	return CGRectMake(0, top - (_miniShown ? ENMiniHeight : 0), CGRectGetWidth(self.view.bounds), ENMiniHeight);
}

// directly above the mini player, or above the tab bar while the mini player is hidden (4-inch: 435-453 / 481-499; 3.5-inch:
// 347-365 / 393-411: both follow the tab bar's real frame); 0.10: hidden, behind whichever of the two it sits on
- (CGRect)barFrame {
	CGFloat h = [ENJamBar height];
	CGFloat bottom = CGRectGetMinY(self.tabBar.frame) - (_miniShown ? ENMiniHeight : 0);
	return CGRectMake(0, bottom - (_barShown ? h : 0), CGRectGetWidth(self.view.bounds), h);
}

// 0.10: above the content, directly under the tab bar (content < Jam bar < mini player < tab bar), so each slides out
// behind the one below it. Should the tab bar not be this view's own subview: both at the front, as before 0.10.
- (void)raiseBars {
	UIView *v = self.view;
	UITabBar *tb = self.tabBar;
	if (!_mini || !_jamBar) return;
	if (tb.superview != v) {
		[v bringSubviewToFront:_jamBar];
		[v bringSubviewToFront:_mini];
		return;
	}
	NSArray *subs = v.subviews;
	NSUInteger t = [subs indexOfObjectIdenticalTo:tb];
	if (t != NSNotFound && t >= 2 && subs[t - 1] == _mini && subs[t - 2] == _jamBar) return;     // already in place
	[v insertSubview:_mini belowSubview:tb];
	[v insertSubview:_jamBar belowSubview:_mini];
}

- (void)viewDidLayoutSubviews {
	[super viewDidLayoutSubviews];
	CGRect f = [self miniFrame];
	if (!CGRectEqualToRect(_mini.frame, f)) _mini.frame = f;
	CGRect bf = [self barFrame];
	if (!CGRectEqualToRect(_jamBar.frame, bf)) _jamBar.frame = bf;
}

- (void)viewDidAppear:(BOOL)animated {
	// First appearance (the first frame is up): only now does anything touch the network (§5.7). Started before super, so
	// the Home root (which appears inside super's call) finds them running.
	if (!_started) {
		_started = YES;
		[[ENPlayback shared] start];
		[[ENCatalog shared] start];
		[ENJamActions startObserving];     // 0.6: guest taps and the Jam's event HUDs
	}
	[super viewDidAppear:animated];
	_appeared = YES;
	[self becomeFirstResponder];
	[self raiseBars];
	[self updateMini];
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	_appeared = NO;                  // Now Playing (full screen) covers the mini player
	[self updateMini];
}

- (NSUInteger)supportedInterfaceOrientations { return UIInterfaceOrientationMaskPortrait; }

#pragma mark - mini player

- (CGFloat)miniPlayerHeight { return (_miniShown ? ENMiniHeight : 0) + (_barShown ? [ENJamBar height] : 0); }
- (ENMiniPlayer *)miniPlayer { return _mini; }

- (void)playbackChanged { [self updateMini]; }

- (void)jamChanged {
	[self updateBarContent];
	[self updateMini];
}

// (3b, DESIGN-5 §2.2 B3) what the bar over the mini player says: the Jam while one is on (it wins), else "Listening on
// <device>" while another device plays (ENPlayback remoteDevice: Encore idle, Play takes it over). With neither, the last
// content stays for the slide out. The mode goes first: the Jam text is fitted to the room the people glyph leaves.
- (void)updateBarContent {
	ENJam *jam = [ENJam shared];
	if (jam.active) {
		_jamBar.mode = ENJamBarModeJam;
		_jamBar.text = [jam barTextFittingWidth:[_jamBar textWidth] font:[ENJamBar font]];
		return;
	}
	NSString *device = [ENPlayback shared].remoteDevice;
	if (!device.length) return;
	_jamBar.mode = ENJamBarModeConnect;
	_jamBar.text = [NSString stringWithFormat:ENL(@"Listening on %@"), device];     // tail-truncated by the bar
}

// Jam mode -> the Jam screen (as before 3b); Connect mode -> Now Playing (JB3; 0.11.1: no device page any more, so simply
// -presentNowPlaying)
- (void)jamBarTapped {
	if (_jamBar.mode == ENJamBarModeConnect) [self presentNowPlaying];
	else [self presentJam];
}

- (void)updateMini {
	if (!_mini) return;
	BOOL want = [ENPlayback shared].track != nil;
	// 0.6: the Jam bar, raised together with the mini player; 3b: also the Connect bar while another device plays (the same
	// view, 18 pt either way)
	BOOL jam = [ENJam shared].active;
	BOOL bar = jam || [ENPlayback shared].remoteDevice.length > 0;
	// the Connect text follows the device here (playback changes); the Jam's text is fitted on Jam changes only, as before
	if (bar && !jam) [self updateBarContent];  // (the bar redraws only when its text or glyph changes)
	[self raiseBars];
	if (want != _miniShown || bar != _barShown) {
		BOOL refresh = want && !_miniShown;
		_miniShown = want;
		_barShown = bar;
		if (refresh) [_mini refresh];
		[self slideBars];
	} else {
		CGRect f = [self miniFrame], bf = [self barFrame];      // (a slide in flight already has these as its targets)
		if (!CGRectEqualToRect(_mini.frame, f)) _mini.frame = f;
		if (!CGRectEqualToRect(_jamBar.frame, bf)) _jamBar.frame = bf;
	}
	[_mini setActive:_miniShown && _appeared && _appActive];
}

// 0.10 (DESIGN-5 §2.1 A2): the mini player and the Jam bar slide to the places their new state gives them (.25 s, ease-out,
// beginning from wherever they are, so a show and a hide in quick succession just turn round). ENMiniPlayerLayoutNotification
// is posted inside the animation, so the lists' bottom insets move with the bars. A bar coming out starts behind what it
// hides behind now (the tab bar; the Jam bar: the mini player where it stands) and has `hidden` cleared first; a bar going
// away gets `hidden` only when the newest slide has finished and still wants it gone. Off screen (Now Playing up): no
// animation, the same end state.
- (void)slideBars {
	CGFloat tabTop = CGRectGetMinY(self.tabBar.frame);
	CGFloat miniTop = _mini.hidden ? tabTop : CGRectGetMinY(_mini.frame);     // before this slide moves it
	if (_miniShown && _mini.hidden) {
		CGRect f = [self miniFrame];
		f.origin.y = tabTop;
		_mini.frame = f;
		_mini.hidden = NO;
	}
	if (_barShown && _jamBar.hidden) {
		CGRect f = [self barFrame];
		f.origin.y = miniTop;
		_jamBar.frame = f;
		_jamBar.hidden = NO;
	}
	NSUInteger gen = ++_slideGen;
	CGFloat h = self.miniPlayerHeight;
	BOOL post = h != _overlay;
	_overlay = h;
	__weak ENTabBarController *w = self;
	void (^move)(void) = ^{
		ENTabBarController *s = w;
		if (!s) return;
		s->_mini.frame = [s miniFrame];
		s->_jamBar.frame = [s barFrame];
		if (post) [[NSNotificationCenter defaultCenter] postNotificationName:ENMiniPlayerLayoutNotification object:s
		                                                            userInfo:@{ ENMiniPlayerHeightKey: @(h) }];
	};
	void (^end)(BOOL) = ^(BOOL finished) {
		ENTabBarController *s = w;
		if (!s || gen != s->_slideGen) return;      // a newer slide owns the bars now
		if (!s->_miniShown) s->_mini.hidden = YES;
		if (!s->_barShown) s->_jamBar.hidden = YES;
	};
	if (!self.view.window) {
		move();
		end(YES);
		return;
	}
	[UIView animateWithDuration:ENBarSlide delay:0 options:UIViewAnimationOptionCurveEaseOut | UIViewAnimationOptionBeginFromCurrentState
	                 animations:move completion:end];
}

- (void)appActive {
	_appActive = YES;
	[self updateMini];
}

- (void)appInactive {
	_appActive = NO;
	[self updateMini];
}

#pragma mark - navigation

- (UINavigationController *)currentNavigationController {
	id vc = self.selectedViewController;
	return [vc isKindOfClass:[UINavigationController class]] ? vc : nil;
}

- (void)selectTab:(ENTab)tab {
	if ((NSUInteger)tab < self.viewControllers.count) self.selectedIndex = tab;
}

- (void)showViewController:(UIViewController *)vc {
	if (!vc) return;
	if (self.presentedViewController) {
		__weak ENTabBarController *w = self;
		[self dismissViewControllerAnimated:YES completion:^{ [w.currentNavigationController pushViewController:vc animated:YES]; }];
	} else {
		[self.currentNavigationController pushViewController:vc animated:YES];
	}
}

- (void)presentNowPlaying {
	if (self.presentedViewController || ![ENPlayback shared].track) return;
	[self presentViewController:[[ENNowPlayingViewController alloc] init] animated:YES completion:nil];
}

- (void)presentJam {
	UIViewController *top = self;
	while (top.presentedViewController) top = top.presentedViewController;
	if ([top isKindOfClass:[UINavigationController class]]) {
		NSArray *stack = ((UINavigationController *)top).viewControllers;
		if (stack.count && [stack[0] isKindOfClass:[ENJamViewController class]]) return;     // already up
	}
	if (top.isBeingDismissed || top.isBeingPresented) return;
	UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:[[ENJamViewController alloc] init]];
	[top presentViewController:nav animated:YES completion:nil];
}

// Re-tapping the selected tab: UIKit pops to the root; at the root already, scroll it to the top.
- (BOOL)tabBarController:(UITabBarController *)tbc shouldSelectViewController:(UIViewController *)vc {
	if (vc == self.selectedViewController && [vc isKindOfClass:[UINavigationController class]]) {
		NSArray *stack = ((UINavigationController *)vc).viewControllers;
		id root = stack.count == 1 ? stack[0] : nil;
		if ([root respondsToSelector:@selector(scrollToTop)]) [root scrollToTop];
	}
	return YES;
}

- (void)tabBarController:(UITabBarController *)tbc didSelectViewController:(UIViewController *)vc {
	[self raiseBars];
}

#pragma mark - remote controls (lock screen, AirPods)

- (BOOL)canBecomeFirstResponder { return YES; }

- (void)remoteControlReceivedWithEvent:(UIEvent *)event {
	[[ENPlayback shared] handleRemoteEvent:event];
}

- (void)reclaimFirstResponder {
	if (self.isViewLoaded && self.view.window) [self becomeFirstResponder];
}

@end

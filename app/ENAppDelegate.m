#import "ENAppDelegate.h"
#import "ENGateway.h"
#import "ENPlayback.h"
#import "ENCatalog.h"
#import "ENSetupViewController.h"
#import "ENTabBarController.h"
#import "ENTheme.h"
#import "ENDiag.h"
#import "ENJam.h"
#import "ENJamActions.h"
#import "ENCompat.h"

// (0.10: ENColor's body moved to ENTheme.m, so every literal colour lives there; it is still declared in ENAppDelegate.h.)

@implementation ENAppDelegate

- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)opts {
	[ENCatalog prepareAtLaunch];         // first: the zero-size URL cache and the cache folders (no network)
	// 0.10 (DESIGN-5 §1.1): before any UI, the Appearance and Text size settings, the green chrome (UIAppearance: bars, bar /
	// back / Done buttons, search Cancel, switches, tab labels) and the Automatic clock. It replaces 0.5's tint and title lines.
	[ENTheme start];
	self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
	self.window.backgroundColor = [ENTheme current].windowBackground;
	// Setup until paired; also when no Home address is saved (there is no built-in one), so the app never starts its tabs
	// without an address to reach
	ENGateway *gw = [ENGateway shared];
	if (gw.paired && gw.homeURL.length) [self showMain];
	else [self showSetup];
	[self.window makeKeyAndVisible];
	[app beginReceivingRemoteControlEvents];
	NSURL *url = opts[UIApplicationLaunchOptionsURLKey];
	if (url) [self handleURL:url];
	return YES;
}

// The tabs, Home selected (0.7). ENPlayback and ENCatalog start in ENTabBarController's first viewDidAppear, after the
// first frame (nothing touches the network before it, DESIGN-3 §5.7).
// 0.10: UIStatusBarStyleDefault here, so iOS 6 tints the status bar from the green nav bar (the status-bar spike, DESIGN-5
// §4.4 D3a-2: green, black or grey decides whether it stays); Setup keeps the plist's BlackOpaque. (1.1) iOS 5: BlackOpaque
// (+mainStatusBarStyle).
// 1.0 (Drop 3c, DESIGN-5 §2.3 C5): after pairing, and only then (Setup was the root; at launch there is none), the tab
// controller's view zooms in as the mockup's launch (@keyframes launch: scale .15 -> 1 and opacity 0 -> 1, .38 s ease-out)
// over the window's dark background. Core Animation only (the layer's own values stay 1, so nothing is left scaled).
+ (UIStatusBarStyle)mainStatusBarStyle {
	return ENSystemIs6() ? UIStatusBarStyleDefault : UIStatusBarStyleBlackOpaque;
}

- (void)showMain {
	BOOL afterPairing = [self showingSetup];
	[[UIApplication sharedApplication] setStatusBarStyle:[ENAppDelegate mainStatusBarStyle] animated:NO];
	ENTabBarController *tabs = [[ENTabBarController alloc] init];
	self.window.rootViewController = tabs;
	if (afterPairing) [ENAppDelegate playLaunchAnimationOn:tabs.view.layer];
}

// Settings → Language (ENLang): a fresh tab controller, so every screen is built in the new language. Playback, the catalog
// and the Jam keep running (the new controller doesn't start them again); the old one goes away with its observers.
- (void)reloadInterface {
	if ([self showingSetup]) return;
	ENTabBarController *tabs = [[ENTabBarController alloc] initAfterLanguageChange];
	self.window.rootViewController = tabs;
	[tabs selectTab:ENTabSettings];
}

// the root is Setup's navigation controller (showSetup)
- (BOOL)showingSetup {
	UIViewController *root = self.window.rootViewController;
	if ([root isKindOfClass:[UINavigationController class]]) {
		NSArray *vcs = ((UINavigationController *)root).viewControllers;
		root = vcs.count ? vcs[0] : nil;
	}
	return [root isKindOfClass:[ENSetupViewController class]];
}

+ (void)playLaunchAnimationOn:(CALayer *)layer {
	CAMediaTimingFunction *easeOut = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
	CABasicAnimation *scale = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
	scale.fromValue = @0.15f;
	scale.toValue = @1.0f;
	CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
	fade.fromValue = @0.0f;
	fade.toValue = @1.0f;
	for (CABasicAnimation *a in @[ scale, fade ]) {
		a.duration = 0.38;
		a.timingFunction = easeOut;
		a.fillMode = kCAFillModeBackwards;     // the first frame is already small and clear
		[layer addAnimation:a forKey:[@"encore.launch." stringByAppendingString:a.keyPath]];
	}
}

- (void)showSetup {
	[[UIApplication sharedApplication] setStatusBarStyle:UIStatusBarStyleBlackOpaque animated:NO];
	self.window.rootViewController = [[UINavigationController alloc] initWithRootViewController:[[ENSetupViewController alloc] init]];
}

- (void)applicationDidBecomeActive:(UIApplication *)app {
	ENLog(@"app active");
	[[ENPlayback shared] appDidBecomeActive];
	[ENJamActions offerClipboardJam];      // 0.6: a Jam link copied elsewhere -> "Jam Link Copied" (no request)
}

- (void)applicationDidEnterBackground:(UIApplication *)app {
	ENLog(@"app in background (%@)", [ENPlayback shared].playing ? @"playing" : @"not playing");
	[ENDiag flushSoon];
}

- (void)applicationDidReceiveMemoryWarning:(UIApplication *)app {
	ENLog(@"memory warning (%.1f MB resident)", [ENDiag residentMB]);
}

- (void)applicationWillTerminate:(UIApplication *)app {
	ENLog(@"app terminating");
}

- (void)remoteControlReceivedWithEvent:(UIEvent *)event {
	[[ENPlayback shared] handleRemoteEvent:event];
}

// encore://play?uri=spotify:track:...   (EncoreLinks will use this later)
// 0.6: encore://open?u=<percent-encoded original link> (the EncoreLinks form, PLAN §4.1): a Jam link -> "Join This Jam?"
// (ENJamActions); anything else is played. The link itself is never logged.
- (BOOL)handleURL:(NSURL *)url {
	if (![[url.scheme lowercaseString] isEqualToString:@"encore"] || ![ENGateway shared].paired || [self showingSetup]) return NO;
	BOOL open = [[url.host lowercaseString] isEqualToString:@"open"];
	for (NSString *pair in [url.query componentsSeparatedByString:@"&"]) {
		NSRange eq = [pair rangeOfString:@"="];      // the value may hold an unencoded "=" (?si=...)
		if (eq.location == NSNotFound) continue;
		NSString *k = [pair substringToIndex:eq.location];
		if (!([k isEqualToString:@"uri"] || [k isEqualToString:@"link"] || (open && [k isEqualToString:@"u"]))) continue;
		NSString *v = [[pair substringFromIndex:eq.location + 1] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
		if (!v.length) continue;
		if ([ENJam isJamLink:v]) {
			ENLog(@"url: a Jam link");
			[ENJamActions offerJoinLink:v];
			return YES;
		}
		return [[ENPlayback shared] playLink:v];
	}
	return NO;
}

- (BOOL)application:(UIApplication *)app openURL:(NSURL *)url sourceApplication:(NSString *)src annotation:(id)ann {
	return [self handleURL:url];
}

@end

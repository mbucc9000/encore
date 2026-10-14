#import "ENUpdateNotice.h"
#import "ENL.h"
#import "ENSheets.h"
#import "ENDiag.h"
#import "ENUtil.h"
#import "ENGateway.h"
#import "ENAppDelegate.h"
#import "ENTabBarController.h"
#import "ENJam.h"

// See ENUpdateNotice.h.

static NSString *const ENUpdateSeenKey = @"updateNoticeSeen";      // NSUserDefaults: the last version whose alert was dismissed
static NSString *const ENCydiaPackageURL = @"cydia://package/com.mbucc9000.encore";
static const NSTimeInterval ENUpdateRetryDelay = 0.8;              // after another alert or a modal went away, or becoming active

// "X.Y.Z", each part 1-4 ASCII digits (the bridge sends only final release versions; anything else is ignored)
static BOOL ENIsReleaseVersion(NSString *v) {
	NSArray *parts = [v componentsSeparatedByString:@"."];
	if (parts.count != 3) return NO;
	NSCharacterSet *nonDigit = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789"] invertedSet];
	for (NSString *p in parts) {
		if (p.length < 1 || p.length > 4 || [p rangeOfCharacterFromSet:nonDigit].location != NSNotFound) return NO;
	}
	return YES;
}

// numerically, part by part (1.10.0 > 1.9.0); a missing part is 0, a part counts by its leading digits ("0-dev" -> 0)
static NSComparisonResult ENCompareVersions(NSString *a, NSString *b) {
	NSArray *x = [a componentsSeparatedByString:@"."], *y = [b componentsSeparatedByString:@"."];
	NSUInteger n = MAX(x.count, y.count);
	for (NSUInteger i = 0; i < n; i++) {
		NSInteger p = i < x.count ? [(NSString *)x[i] integerValue] : 0;
		NSInteger q = i < y.count ? [(NSString *)y[i] integerValue] : 0;
		if (p != q) return p < q ? NSOrderedAscending : NSOrderedDescending;
	}
	return NSOrderedSame;
}

static BOOL ENSameVersionText(NSString *a, NSString *b) { return a == b || [a isEqualToString:b]; }

@implementation ENUpdateNotice {
	UIAlertView *_alert;             // this notice's alert while it is up (its delegate: this object, which lives as long as the app)
	NSString *_alertVersion;         // the version it announces
	BOOL _waiting;                   // the automatic alert is due, but the main screen wasn't free
}

+ (instancetype)shared {
	static ENUpdateNotice *n;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ n = [[ENUpdateNotice alloc] init]; });
	return n;
}

- (instancetype)init {
	if ((self = [super init])) {
		NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
		[nc addObserver:self selector:@selector(appActive) name:UIApplicationDidBecomeActiveNotification object:nil];
		[nc addObserver:self selector:@selector(windowBecameKey:) name:UIWindowDidBecomeKeyNotification object:nil];
		[nc addObserver:self selector:@selector(mainScreenAppeared) name:ENJamChangedNotification object:nil];   // ENJam's first state
	}
	return self;
}

#pragma mark - the bridge's answer

- (void)takeStatus:(id)update bridgeVersion:(NSString *)bridgeVersion {
	NSDictionary *u = ENJDict(update);
	NSString *latest = ENJStr(u[@"latest"]);
	if (latest && !ENIsReleaseVersion(latest)) latest = nil;
	BOOL bridgeOlder = latest && ENJFlag(u[@"bridge"]);
	// a bridge already on a newer final release (updated first: its own view has nothing newer then) is the app's update
	NSString *bv = ENJStr(bridgeVersion);
	if (bv && ENIsReleaseVersion(bv) && (!latest || ENCompareVersions(bv, latest) != NSOrderedAscending)) {
		latest = bv;
		bridgeOlder = NO;
	}
	id mine = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
	BOOL appOlder = latest && ENJStr(mine) && ENCompareVersions(mine, latest) == NSOrderedAscending;
	if (!appOlder && !bridgeOlder) latest = nil;
	BOOL changed = !ENSameVersionText(latest, _latest) || appOlder != _appOlder || bridgeOlder != _bridgeOlder;
	_latest = [latest copy];
	_appOlder = appOlder;
	_bridgeOlder = bridgeOlder;
	if (changed) {
		if (latest) ENLog(@"update: %@ is available (%@ older)", latest, appOlder && bridgeOlder ? @"app and bridge" : appOlder ? @"app" : @"bridge");
		else ENLog(@"update: none");
	}
	[self chance];
}

#pragma mark - when the automatic alert may show

// the automatic alert, when one is due (an update applies, newer than the last one dismissed) and the main screen is free
- (void)chance {
	_waiting = NO;
	if (!_latest || _alert) return;
	NSString *seen = ENJStr([[NSUserDefaults standardUserDefaults] objectForKey:ENUpdateSeenKey]);
	if (seen && ENCompareVersions(seen, _latest) != NSOrderedAscending) return;
	if (![self mainScreenFree]) {
		_waiting = YES;
		return;
	}
	ENLog(@"update: showing the notice for %@", _latest);
	[self present];
}

- (void)chanceSoon {
	if (!_waiting) return;
	__weak ENUpdateNotice *weakSelf = self;
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(ENUpdateRetryDelay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		ENUpdateNotice *s = weakSelf;
		if (s && s->_waiting) [s chance];
	});
}

// Active and paired; the tabs are the window's root (not Setup / pairing), on screen, with nothing presented over them; no
// other alert or sheet up (each has its own key window while it shows: the same test as the Jam clipboard prompt's).
// On a cold launch the Jam clipboard prompt waits for ENJam's first state (it follows this status answer) and drops
// itself when another alert is up: so not before that state (ENJamChangedNotification brings the next chance).
- (BOOL)mainScreenFree {
	UIApplication *app = [UIApplication sharedApplication];
	if (app.applicationState != UIApplicationStateActive || ![ENGateway shared].paired) return NO;
	ENJam *jam = [ENJam shared];
	if (jam.available && !jam.loaded) return NO;
	id<UIApplicationDelegate> d = app.delegate;
	UIWindow *main = [d isKindOfClass:[ENAppDelegate class]] ? ((ENAppDelegate *)d).window : nil;
	ENTabBarController *tabs = [ENTabBarController shared];
	if (!main || !tabs || main.rootViewController != tabs || !tabs.isViewLoaded || !tabs.view.window) return NO;
	if (tabs.presentedViewController) return NO;
	UIWindow *key = app.keyWindow;
	return !key || key == main;
}

// (the delegate's applicationDidBecomeActive: may put up the Jam clipboard prompt: after it, through the key-window test)
- (void)appActive {
	if (_latest && !_alert) _waiting = YES;
	[self chanceSoon];
}

- (void)windowBecameKey:(NSNotification *)n {
	id<UIApplicationDelegate> d = [UIApplication sharedApplication].delegate;
	if ([d isKindOfClass:[ENAppDelegate class]] && n.object == ((ENAppDelegate *)d).window) [self chanceSoon];
}

- (void)mainScreenAppeared {
	[self chanceSoon];
}

#pragma mark - the alert

- (void)showAlert {
	if (_latest && !_alert) [self present];
}

- (void)present {
	NSString *v = _latest;
	if (!v || _alert) return;
	NSString *title, *message, *cancel, *other = nil;
	// the bridge sentence names no button (Windows: Update now with the installer, Download… with the portable zip)
	NSString *bridgeText = ENL(@"Update Encore Bridge on its computer: on Windows, use the Encore Bridge icon; on Docker, the admin page shows how.");
	if (_appOlder) {
		title = [NSString stringWithFormat:ENL(@"Encore %@ is available"), v];
		// both older: the bridge first (the guide's order; an app newer than its bridge misses features)
		message = _bridgeOlder ? [NSString stringWithFormat:@"%@\n\n%@", bridgeText, ENL(@"Then update Encore in Cydia: Changes, then Refresh.")]
		                       : ENL(@"Update in Cydia: Changes, then Refresh.");
		cancel = ENL(@"Later");
		if ([[UIApplication sharedApplication] canOpenURL:[NSURL URLWithString:ENCydiaPackageURL]]) other = ENL(@"Open Cydia");
	} else {
		title = [NSString stringWithFormat:ENL(@"Encore Bridge %@ is available"), v];
		message = bridgeText;
		cancel = ENL(@"OK");
	}
	ENAlertView *a = [[ENAlertView alloc] initWithTitle:title message:message delegate:self cancelButtonTitle:cancel
	                                  otherButtonTitles:other, nil];
	_alert = a;
	_alertVersion = [v copy];
	[a show];
}

// didDismiss: the alert's last delegate call. Any button counts as seen for that version; Open Cydia opens Encore's page.
- (void)alertView:(UIAlertView *)a didDismissWithButtonIndex:(NSInteger)i {
	a.delegate = nil;
	if (a != _alert) return;
	_alert = nil;
	NSString *v = _alertVersion;
	_alertVersion = nil;
	if (v) {
		NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
		NSString *seen = ENJStr([ud objectForKey:ENUpdateSeenKey]);
		if (!seen || ENCompareVersions(seen, v) == NSOrderedAscending) [ud setObject:v forKey:ENUpdateSeenKey];
	}
	if (i != a.cancelButtonIndex && i == a.firstOtherButtonIndex) {
		ENLog(@"update: opening Cydia");
		[[UIApplication sharedApplication] openURL:[NSURL URLWithString:ENCydiaPackageURL]];
	}
}

@end

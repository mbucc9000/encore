#import "ENAppIcons.h"
#import "ENL.h"
#import "ENDiag.h"
#include <notify.h>
#include <signal.h>

// See ENAppIcons.h. The names below are the contract with the add-on (DESIGN-APP-ICONS.md §5): change them only together
// with app/EncoreIcons/Tweak.x.

static NSString *const ENAppIconKey = @"appIcon";                                        // in the app's own defaults domain
static NSString *const ENAppIconDefault = @"encore";
static NSString *const ENAppIconSubstrate = @"/Library/MobileSubstrate/MobileSubstrate.dylib";
static const char *const ENAppIconLoaded = "com.mbucc9000.encore.iconsloaded";     // libnotify state: SpringBoard's pid
static const CGFloat ENAppIconTile = 29;          // the Settings icon tiles (ENGroupedCell's column)
static const CGFloat ENAppIconRadius = 6;         // as -[ENTheme iconTileNamed:size:] at 29 pt

@implementation ENAppIcons

+ (NSArray *)identifiers {
	return @[ ENAppIconDefault, @"classic", @"round", @"2013", @"flat", @"disco" ];
}

// each translated name is a literal in its own ENL() so l10n.py merge finds it; "Encore" and "2013" are names, never
// translated
+ (NSString *)titleFor:(NSString *)identifier {
	if (![identifier isKindOfClass:[NSString class]]) return nil;
	if ([identifier isEqualToString:ENAppIconDefault]) return @"Encore";
	if ([identifier isEqualToString:@"classic"]) return ENL(@"Classic");
	if ([identifier isEqualToString:@"round"]) return ENL(@"Round");
	if ([identifier isEqualToString:@"2013"]) return @"2013";
	if ([identifier isEqualToString:@"flat"]) return ENL(@"Flat");
	if ([identifier isEqualToString:@"disco"]) return ENL(@"Disco");
	return nil;
}

static BOOL ENAppIconKnown(id identifier) {
	return [identifier isKindOfClass:[NSString class]] && [[ENAppIcons identifiers] containsObject:identifier];
}

+ (NSString *)chosen {
	id v = [[NSUserDefaults standardUserDefaults] objectForKey:ENAppIconKey];
	return ENAppIconKnown(v) ? v : ENAppIconDefault;
}

+ (void)choose:(NSString *)identifier {
	NSString *ident = ENAppIconKnown(identifier) ? identifier : ENAppIconDefault;
	NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
	[ud setObject:ident forKey:ENAppIconKey];
	[ud synchronize];             // first: the add-on reads the plist file itself (no cfprefsd on iOS 5/6)
	CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFSTR("com.mbucc9000.encore.iconchanged"),
	                                     NULL, NULL, true);
	ENLog(@"settings: app icon %@%@", ident, [self addOnState] == ENAppIconsReady ? @"" : @" (add-on not loaded)");
}

// The add-on sets the name's state to SpringBoard's pid when it loads and never cancels its token. A pid that is no
// longer alive (SpringBoard restarted without it, e.g. in safe mode) or no state at all means not loaded.
+ (ENAppIconsState)addOnState {
	int token = 0;
	uint64_t pid = 0;
	if (notify_register_check(ENAppIconLoaded, &token) == NOTIFY_STATUS_OK) {
		if (notify_get_state(token, &pid) != NOTIFY_STATUS_OK) pid = 0;
		notify_cancel(token);
	}
	if (pid > 1 && pid < 100000 && kill((pid_t)pid, 0) == 0) return ENAppIconsReady;
	if (![[NSFileManager defaultManager] fileExistsAtPath:ENAppIconSubstrate]) return ENAppIconsNeedsSubstrate;
	return ENAppIconsNeedsRespring;
}

#pragma mark - thumbnails

// the art for a 29 pt tile: the sharpest file for this screen first, the other size as a fallback (drawInRect: scales
// either to the tile); the encore row uses the bundle's own icon
static UIImage *ENAppIconArt(NSString *ident) {
	if ([ident isEqualToString:ENAppIconDefault]) return [UIImage imageNamed:@"Icon"];
	NSString *dir = [[[NSBundle mainBundle] bundlePath] stringByAppendingPathComponent:[@"AppIcons" stringByAppendingPathComponent:ident]];
	BOOL retina = [UIScreen mainScreen].scale >= 2;
	NSArray *names = retina ? @[ @"Icon-Small@2x.png", @"Icon-Small.png" ] : @[ @"Icon-Small.png", @"Icon-Small@2x.png" ];
	for (NSString *n in names) {
		NSData *d = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:n]];
		UIImage *img = d.length ? [UIImage imageWithData:d] : nil;
		if (img) return img;
	}
	return nil;
}

+ (UIImage *)thumbnailFor:(NSString *)identifier {
	if (!ENAppIconKnown(identifier)) return nil;
	static NSMutableDictionary *cache;
	if (!cache) cache = [NSMutableDictionary dictionary];
	UIImage *done = cache[identifier];
	if (done) return done;

	UIImage *art = ENAppIconArt(identifier);
	CGRect r = CGRectMake(0, 0, ENAppIconTile, ENAppIconTile);
	UIGraphicsBeginImageContextWithOptions(r.size, NO, 0);
	CGContextSetInterpolationQuality(UIGraphicsGetCurrentContext(), kCGInterpolationHigh);     // (Encore's 114 px icon)
	UIBezierPath *tile = [UIBezierPath bezierPathWithRoundedRect:r cornerRadius:ENAppIconRadius];
	[tile addClip];
	if (art) {
		[art drawInRect:r];
	} else {
		[[UIColor colorWithWhite:0.78f alpha:1] setFill];      // the art is missing (a build without AppIcons/)
		[tile fill];
	}
	UIBezierPath *ring = [UIBezierPath bezierPathWithRoundedRect:CGRectInset(r, 0.5f, 0.5f) cornerRadius:ENAppIconRadius - 0.5f];
	[[UIColor colorWithWhite:0 alpha:0.15f] setStroke];     // the inset 1 pt black .15 ring of the Settings tiles
	ring.lineWidth = 1;
	[ring stroke];
	UIImage *img = UIGraphicsGetImageFromCurrentImageContext();
	UIGraphicsEndImageContext();
	if (img) cache[identifier] = img;             // the bundle can't change while the app runs: one tile per id
	return img;
}

@end

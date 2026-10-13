#import "ENUtil.h"
#import <CommonCrypto/CommonDigest.h>
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import "ENL.h"

// ---------------------------------------------------------------- JSON guards

NSString *ENJStr(id v) {
	return [v isKindOfClass:[NSString class]] && [(NSString *)v length] ? v : nil;
}

// "123", "-5", " 42 ": what NSString's integerValue / longLongValue would read in full (no "12abc", no "")
static BOOL ENNumericString(NSString *s) {
	NSString *t = [s stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
	if (!t.length) return NO;
	NSUInteger i = ([t characterAtIndex:0] == '-' || [t characterAtIndex:0] == '+') ? 1 : 0;
	if (i >= t.length) return NO;
	for (; i < t.length; i++) {
		unichar c = [t characterAtIndex:i];
		if (c < '0' || c > '9') return NO;
	}
	return YES;
}

NSInteger ENJInt(id v, NSInteger dflt) {
	if ([v isKindOfClass:[NSNumber class]]) return [(NSNumber *)v integerValue];
	if ([v isKindOfClass:[NSString class]] && ENNumericString(v)) return [(NSString *)v integerValue];
	return dflt;
}

long long ENJLong(id v, long long dflt) {
	if ([v isKindOfClass:[NSNumber class]]) return [(NSNumber *)v longLongValue];
	if ([v isKindOfClass:[NSString class]] && ENNumericString(v)) return [(NSString *)v longLongValue];
	return dflt;
}

BOOL ENJFlag(id v) {
	return [v isKindOfClass:[NSNumber class]] && [(NSNumber *)v longLongValue] == 1;     // 1, or JSON true
}

NSArray *ENJArr(id v) {
	return [v isKindOfClass:[NSArray class]] ? v : nil;
}

NSDictionary *ENJDict(id v) {
	return [v isKindOfClass:[NSDictionary class]] ? v : nil;
}

// ---------------------------------------------------------------- ids and files

NSString *ENIDFromURI(NSString *uri) {
	if (![uri isKindOfClass:[NSString class]]) return nil;
	NSRange r = [uri rangeOfString:@":" options:NSBackwardsSearch];
	if (r.location == NSNotFound || r.location + 1 >= uri.length) return nil;
	return [uri substringFromIndex:r.location + 1];
}

NSString *ENSHA1Hex(NSString *s) {
	NSData *d = [(s ?: @"") dataUsingEncoding:NSUTF8StringEncoding];
	unsigned char h[CC_SHA1_DIGEST_LENGTH];
	CC_SHA1(d.bytes, (CC_LONG)d.length, h);
	NSMutableString *out = [NSMutableString stringWithCapacity:CC_SHA1_DIGEST_LENGTH * 2];
	for (int i = 0; i < CC_SHA1_DIGEST_LENGTH; i++) [out appendFormat:@"%02x", h[i]];
	return out;
}

NSString *ENCacheDir(NSString *sub) {
	static NSString *base;
	static NSMutableSet *made;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		NSArray *a = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
		NSString *caches = a.count ? a[0] : [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Caches"];
		base = [caches stringByAppendingPathComponent:@"com.mbucc9000.encore"];
		made = [NSMutableSet set];
	});
	NSString *dir = sub.length ? [base stringByAppendingPathComponent:sub] : base;
	@synchronized (made) {
		if (![made containsObject:dir]) {
			NSError *e = nil;
			if ([[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:&e]) [made addObject:dir];
			else NSLog(@"[Encore] can't create %@: %@", dir, e);
		}
	}
	return dir;
}

// ---------------------------------------------------------------- text

NSString *ENTimeText(double ms) {
	long long s = ms > 0 ? (long long)floor(ms / 1000.0) : 0;
	if (s >= 3600) return [NSString stringWithFormat:@"%lld:%02lld:%02lld", s / 3600, (s / 60) % 60, s % 60];
	return [NSString stringWithFormat:@"%lld:%02lld", s / 60, s % 60];
}

NSString *ENDurationText(long long ms) {
	if (ms <= 0) return ENL(@"0 min");
	long long m = (ms + 30000) / 60000;          // to the nearest minute (the mockup's fmtLong)
	if (m < 1) m = 1;
	if (m < 60) return [NSString stringWithFormat:ENL(@"%lld min"), m];
	long long hr = m / 60, mm = m % 60;
	return mm ? [NSString stringWithFormat:ENL(@"%lld hr %lld min"), hr, mm] : [NSString stringWithFormat:ENL(@"%lld hr"), hr];
}

NSString *ENCountText(NSInteger n, NSString *one, NSString *many) {
	static NSNumberFormatter *f;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		f = [[NSNumberFormatter alloc] init];
		f.numberStyle = NSNumberFormatterDecimalStyle;
		f.usesGroupingSeparator = YES;
	});
	NSString *num;
	@synchronized (f) { num = [f stringFromNumber:@(n)]; }     // formatters aren't thread-safe on iOS 6
	return [NSString stringWithFormat:@"%@ %@", num ?: [NSString stringWithFormat:@"%ld", (long)n], n == 1 ? one : many];
}

NSString *ENRelativeTime(NSDate *d) {
	if (!d) return @"";
	NSTimeInterval ago = -[d timeIntervalSinceNow];
	if (ago < 60) return ENL(@"just now");                          // (a clock that moved back counts as now too)
	if (ago < 3600) return [NSString stringWithFormat:ENL(@"%d min ago"), (int)(ago / 60)];
	if (ago < 12 * 3600) return [NSString stringWithFormat:ENL(@"%d hr ago"), (int)(ago / 3600)];
	static NSDateFormatter *day, *shortDate;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		day = [[NSDateFormatter alloc] init];
		day.dateFormat = @"yyyyMMdd";
		shortDate = [[NSDateFormatter alloc] init];
		shortDate.dateFormat = @"MMM d";
	});
	@synchronized (day) {
		NSDate *now = [NSDate date];
		NSString *k = [day stringFromDate:d];
		if ([k isEqualToString:[day stringFromDate:now]]) return [NSString stringWithFormat:ENL(@"%d hr ago"), (int)(ago / 3600)];
		if ([k isEqualToString:[day stringFromDate:[now dateByAddingTimeInterval:-86400]]]) return ENL(@"yesterday");
		return [shortDate stringFromDate:d];
	}
}

// ---------------------------------------------------------------- the picture fade (3c, C1; main thread)

// (iOS 6.1 CALayer.h: transitions always live under kCATransition, whatever key they are added with)
void ENFadeIn(UIView *v) {
	if (!v || v.hidden || !v.window) return;
	CATransition *t = [CATransition animation];
	t.type = kCATransitionFade;
	t.duration = 0.18;
	t.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
	[v.layer addAnimation:t forKey:kCATransition];
}

void ENFadeInCancel(UIView *v) {
	[v.layer removeAnimationForKey:kCATransition];
}

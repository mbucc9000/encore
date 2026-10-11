#import "ENCompat.h"
#import "ENTheme.h"
#import <AVFoundation/AVFoundation.h>
#import <objc/runtime.h>
#include <stdio.h>

// See ENCompat.h. Each iOS 6-only API is called only behind its own feature test; the iOS 5 code runs only where it fails.

// A weak-imported symbol (iOS 6 only) is NULL on iOS 5. Through a function, so a declaration without the weak import (the
// quick Windows check's stubs) doesn't make the comparison "always true".
static BOOL ENSymbolPresent(const void *address) { return address != NULL; }

BOOL ENSystemIs6(void) {
	static int is6 = -1;
	if (is6 < 0) is6 = NSFoundationVersionNumber > NSFoundationVersionNumber_iOS_5_1 ? 1 : 0;
	return is6 == 1;
}

#pragma mark - install (iOS 5 only)

// (§2-A) the iOS 6 subscripting methods as arclite adds them, built on the iOS 2 ones
static id ENArrayObjectAtIndexedSubscript(NSArray *array, SEL cmd, NSUInteger idx) {
	return [array objectAtIndex:idx];
}

static void ENArraySetObjectAtIndexedSubscript(NSMutableArray *array, SEL cmd, id obj, NSUInteger idx) {
	if (idx == array.count) [array addObject:obj];
	else [array replaceObjectAtIndex:idx withObject:obj];
}

static id ENDictionaryObjectForKeyedSubscript(NSDictionary *dict, SEL cmd, id key) {
	return [dict objectForKey:key];
}

static void ENDictionarySetObjectForKeyedSubscript(NSMutableDictionary *dict, SEL cmd, id obj, id<NSCopying> key) {
	if (obj) [dict setObject:obj forKey:key];
	else [dict removeObjectForKey:key];      // (iOS 6: a nil object removes the key)
}

static void ENAddMethodIfMissing(Class cls, SEL sel, IMP imp, const char *types) {
	if (!cls || [cls instancesRespondToSelector:sel]) return;
	if (!class_addMethod(cls, sel, imp, types)) NSLog(@"[Encore] compat: couldn't add %@", NSStringFromSelector(sel));
}

static void ENInstallSubscripting(void) {
	static char getIndexed[16], setIndexed[16];          // the runtime keeps the pointers: static storage
	const char *u = @encode(NSUInteger);
	snprintf(getIndexed, sizeof getIndexed, "@@:%s", u);
	snprintf(setIndexed, sizeof setIndexed, "v@:@%s", u);
	ENAddMethodIfMissing([NSArray class], @selector(objectAtIndexedSubscript:), (IMP)(void *)ENArrayObjectAtIndexedSubscript, getIndexed);
	ENAddMethodIfMissing([NSMutableArray class], @selector(setObject:atIndexedSubscript:), (IMP)(void *)ENArraySetObjectAtIndexedSubscript, setIndexed);
	ENAddMethodIfMissing([NSDictionary class], @selector(objectForKeyedSubscript:), (IMP)(void *)ENDictionaryObjectForKeyedSubscript, "@@:@");
	ENAddMethodIfMissing([NSMutableDictionary class], @selector(setObject:forKeyedSubscript:), (IMP)(void *)ENDictionarySetObjectForKeyedSubscript, "v@:@@");
}

// (§3-1) iOS 6's rule: a view controller keeps its view on a memory warning. iOS 5's UIViewController releases a hidden view
// there (and calls viewDidUnload, which no class here has); its own implementation now does nothing, as on iOS 6. Overrides
// (ENListViewController's -dropModels) still run.
static void ENKeepViewsOnMemoryWarning(id vc, SEL cmd) {}

static void ENInstallViewRetention(void) {
	SEL sel = @selector(didReceiveMemoryWarning);
	unsigned int n = 0;
	Method *list = class_copyMethodList([UIViewController class], &n);       // UIViewController's own, never a superclass's
	BOOL done = NO;
	for (unsigned int i = 0; i < n && !done; i++) {
		if (method_getName(list[i]) != sel) continue;
		method_setImplementation(list[i], (IMP)(void *)ENKeepViewsOnMemoryWarning);
		done = YES;
	}
	free(list);
	if (!done) NSLog(@"[Encore] compat: UIViewController has no didReceiveMemoryWarning of its own");
}

void ENCompatInstall(void) {
	static BOOL installed;
	if (installed) return;
	installed = YES;
	if (ENSystemIs6()) return;
	@autoreleasepool {             // (before main()'s pool: its only objects are a failure's log lines)
		ENInstallSubscripting();
		ENInstallViewRetention();
	}
}

#pragma mark - table cells (§2-B)

static char ENCellClassesKey;

static BOOL ENHasCellRegistration(void) {
	static int has = -1;
	if (has < 0) has = [UITableView instancesRespondToSelector:@selector(dequeueReusableCellWithIdentifier:forIndexPath:)] ? 1 : 0;
	return has == 1;
}

void ENRegisterCellClass(UITableView *tv, Class cellClass, NSString *rid) {
	if (ENHasCellRegistration()) {
		[tv registerClass:cellClass forCellReuseIdentifier:rid];
		return;
	}
	if (!tv || !rid) return;
	NSMutableDictionary *classes = objc_getAssociatedObject(tv, &ENCellClassesKey);
	if (!classes) {
		classes = [NSMutableDictionary dictionary];
		objc_setAssociatedObject(tv, &ENCellClassesKey, classes, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
	}
	if (cellClass) [classes setObject:cellClass forKey:rid];
	else [classes removeObjectForKey:rid];
}

id ENDequeueCell(UITableView *tv, NSString *rid, NSIndexPath *ip) {
	if (ENHasCellRegistration()) return [tv dequeueReusableCellWithIdentifier:rid forIndexPath:ip];
	UITableViewCell *cell = [tv dequeueReusableCellWithIdentifier:rid];
	if (!cell) {
		Class cls = [objc_getAssociatedObject(tv, &ENCellClassesKey) objectForKey:rid];
		if (!cls) [NSException raise:NSInternalInconsistencyException format:@"unable to dequeue a cell with identifier %@", rid];
		cell = [[cls alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:rid];
	}
	// iOS 6 hands the cell out at its row's size (a new iOS 5 cell is 320 x 44 until the table lays it out)
	id<UITableViewDelegate> d = tv.delegate;
	CGFloat h = [d respondsToSelector:@selector(tableView:heightForRowAtIndexPath:)] ? [d tableView:tv heightForRowAtIndexPath:ip] : tv.rowHeight;
	CGFloat w = tv.bounds.size.width;
	CGRect f = cell.frame;
	if (f.size.width != w || f.size.height != h) cell.frame = CGRectMake(f.origin.x, f.origin.y, w, h);
	return cell;
}

BOOL ENTableRowHighlightable(id delegate, UITableView *tv, NSIndexPath *ip) {
	SEL sel = @selector(tableView:shouldHighlightRowAtIndexPath:);
	if (!ip || ![delegate respondsToSelector:sel]) return YES;
	BOOL (*ask)(id, SEL, UITableView *, NSIndexPath *) = (BOOL (*)(id, SEL, UITableView *, NSIndexPath *))(void *)[delegate methodForSelector:sel];
	return ask(delegate, sel, tv, ip);
}

#pragma mark - pull to refresh (§2-D)

static const CGFloat ENPullHeight = 60;      // how far to pull, and the band the spinner holds open while it runs

// iOS 5's stand-in for UIRefreshControl: a centred line of text (and a spinner while it runs) in the 60 pt above the rows.
// Pulled past 60 pt and let go, it opens that band (contentInset.top + 60, only .top) and sends UIControlEventValueChanged
// as UIRefreshControl does; -endRefreshing closes it again. Its owner forwards the scroll view's drag events.
@interface ENPullRefreshView : UIControl
@property (nonatomic, strong) UIColor *color;
@property (nonatomic, readonly) BOOL refreshing;
- (id)initWithScrollView:(UIScrollView *)scrollView;
- (void)scrolled;
- (void)dragEnded;
- (void)endRefreshing;
@end

@implementation ENPullRefreshView {
	__weak UIScrollView *_scroll;
	UILabel *_label;
	UIActivityIndicatorView *_spin;
	BOOL _armed;               // pulled past the line while still dragging ("Release to refresh")
}

- (id)initWithScrollView:(UIScrollView *)sv {
	if ((self = [super initWithFrame:CGRectMake(0, -ENPullHeight, sv.bounds.size.width, ENPullHeight)])) {
		_scroll = sv;
		self.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		self.backgroundColor = [UIColor clearColor];
		self.userInteractionEnabled = NO;
		_label = [[UILabel alloc] initWithFrame:CGRectZero];
		_label.backgroundColor = [UIColor clearColor];
		_label.font = [ENTheme fontOfSize:13 bold:YES];
		_label.textAlignment = NSTextAlignmentCenter;
		[self addSubview:_label];
		_spin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleGray];
		_spin.hidesWhenStopped = YES;
		[self addSubview:_spin];
		self.color = [UIColor grayColor];
		[self showState];
		[sv addSubview:self];
	}
	return self;
}

- (void)setColor:(UIColor *)color {
	_color = color;
	_label.textColor = color;
	_spin.color = color;
}

- (void)showState {
	_label.text = _refreshing ? @"Loading…" : _armed ? @"Release to refresh" : @"Pull down to refresh";
	[self setNeedsLayout];
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGSize b = self.bounds.size;
	CGFloat tw = MIN(ceilf([_label.text sizeWithFont:_label.font].width), b.width - 60);
	CGFloat sw = _refreshing ? 20 + 8 : 0, x = floorf((b.width - tw - sw) / 2);
	_spin.center = CGPointMake(x + 10, floorf(b.height / 2));
	_label.frame = CGRectMake(x + sw, floorf((b.height - 20) / 2), tw, 20);
}

- (CGFloat)pulled {
	UIScrollView *s = _scroll;
	return s ? -(s.contentOffset.y + s.contentInset.top) : 0;
}

- (void)scrolled {
	if (_refreshing) return;
	BOOL armed = _scroll.isDragging && [self pulled] > ENPullHeight;
	if (armed == _armed) return;
	_armed = armed;
	[self showState];
}

- (void)dragEnded {
	if (_refreshing) return;
	BOOL go = [self pulled] > ENPullHeight;
	_armed = NO;
	if (!go) { [self showState]; return; }
	_refreshing = YES;
	[_spin startAnimating];
	[self showState];
	[self moveTopInsetBy:ENPullHeight];
	[self sendActionsForControlEvents:UIControlEventValueChanged];
}

- (void)endRefreshing {
	if (!_refreshing) return;
	_refreshing = NO;
	[_spin stopAnimating];
	[self showState];
	[self moveTopInsetBy:-ENPullHeight];
}

- (void)moveTopInsetBy:(CGFloat)d {
	UIScrollView *s = _scroll;
	if (!s) return;
	UIEdgeInsets in = s.contentInset;
	in.top = MAX(in.top + d, 0);
	[UIView animateWithDuration:0.25 delay:0 options:UIViewAnimationOptionAllowUserInteraction | UIViewAnimationOptionBeginFromCurrentState
	                 animations:^{
		s.contentInset = in;
		if (d < 0 && s.contentOffset.y < -in.top) s.contentOffset = CGPointMake(s.contentOffset.x, -in.top);   // the band closes
	} completion:nil];
}

@end

static char ENPullKey;

static ENPullRefreshView *ENPull(UITableViewController *vc) {
	return vc ? objc_getAssociatedObject(vc, &ENPullKey) : nil;
}

BOOL ENHasRefreshControl(void) {
	static int has = -1;
	if (has < 0) has = NSClassFromString(@"UIRefreshControl") && [UITableViewController instancesRespondToSelector:@selector(setRefreshControl:)] ? 1 : 0;
	return has == 1;
}

void ENRefreshInstall(UITableViewController *vc, UIColor *tint, id target, SEL action) {
	if (ENHasRefreshControl()) {
		UIRefreshControl *rc = [[UIRefreshControl alloc] init];
		rc.tintColor = tint;
		[rc addTarget:target action:action forControlEvents:UIControlEventValueChanged];
		vc.refreshControl = rc;
		return;
	}
	[ENPull(vc) removeFromSuperview];
	ENPullRefreshView *p = [[ENPullRefreshView alloc] initWithScrollView:vc.tableView];
	if (tint) p.color = tint;
	[p addTarget:target action:action forControlEvents:UIControlEventValueChanged];
	objc_setAssociatedObject(vc, &ENPullKey, p, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

BOOL ENRefreshIsRefreshing(UITableViewController *vc) {
	if (ENHasRefreshControl()) return vc.refreshControl.refreshing;
	return ENPull(vc).refreshing;
}

void ENRefreshEnd(UITableViewController *vc) {
	if (ENHasRefreshControl()) {
		if (vc.refreshControl.refreshing) [vc.refreshControl endRefreshing];
		return;
	}
	[ENPull(vc) endRefreshing];
}

void ENRefreshSetTint(UITableViewController *vc, UIColor *tint) {
	if (ENHasRefreshControl()) {
		vc.refreshControl.tintColor = tint;
		return;
	}
	if (tint) ENPull(vc).color = tint;
}

void ENRefreshScrolled(UITableViewController *vc) {
	if (!ENHasRefreshControl()) [ENPull(vc) scrolled];
}

void ENRefreshDragEnded(UITableViewController *vc) {
	if (!ENHasRefreshControl()) [ENPull(vc) dragEnded];
}

#pragma mark - labels and fields (§2-E, §2-F)

void ENSetMinimumScaleFactor(UILabel *label, CGFloat factor) {
	if ([label respondsToSelector:@selector(setMinimumScaleFactor:)]) {
		label.minimumScaleFactor = factor;
		return;
	}
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
	label.minimumFontSize = label.font.pointSize * factor;      // (iOS 5's form of the same floor; the font is final by now)
#pragma clang diagnostic pop
}

BOOL ENHasAttributedText(void) {
	static int has = -1;
	if (has < 0) has = ENSymbolPresent((const void *)&NSFontAttributeName) && ENSymbolPresent((const void *)&NSForegroundColorAttributeName)
		&& [UILabel instancesRespondToSelector:@selector(setAttributedText:)] ? 1 : 0;
	return has == 1;
}

static BOOL ENHasAttributedPlaceholder(void) {
	return ENHasAttributedText() && [UITextField instancesRespondToSelector:@selector(setAttributedPlaceholder:)];
}

void ENSetFieldPlaceholder(UITextField *f, NSString *ph, UIFont *font, UIColor *color) {
	if (ENHasAttributedPlaceholder()) {
		f.attributedPlaceholder = [[NSAttributedString alloc] initWithString:ph attributes:@{ NSFontAttributeName: font, NSForegroundColorAttributeName: color }];
		return;
	}
	f.placeholder = ph;          // drawn in the field's font
	ENTintFieldPlaceholder(f, color);
}

// iOS 5 has no public placeholder colour: its placeholder label's, when it has one (else the stock grey stays)
void ENTintFieldPlaceholder(UITextField *f, UIColor *color) {
	if (!f || !color || [f respondsToSelector:@selector(setAttributedPlaceholder:)]) return;
	@try {
		[f setValue:color forKeyPath:@"_placeholderLabel.textColor"];
	} @catch (NSException *e) {
		(void)e;
	}
}

#pragma mark - images (§2-G)

UIImage *ENResizableImage(UIImage *image, UIEdgeInsets caps) {
	if ([image respondsToSelector:@selector(resizableImageWithCapInsets:resizingMode:)])
		return [image resizableImageWithCapInsets:caps resizingMode:UIImageResizingModeStretch];
	if (UIEdgeInsetsEqualToEdgeInsets(caps, UIEdgeInsetsZero)) return image;
	return [image resizableImageWithCapInsets:caps];
}

UIImage *ENImageWithPNGData(NSData *data, CGFloat scale) {
	if (!data) return nil;
	if ([UIImage respondsToSelector:@selector(imageWithData:scale:)]) return [UIImage imageWithData:data scale:scale];
	CGImageRef cg = [UIImage imageWithData:data].CGImage;
	return cg ? [UIImage imageWithCGImage:cg scale:scale orientation:UIImageOrientationUp] : nil;
}

#pragma mark - network (§3-2)

// iOS 5: a cancellable NSURLConnection on the main run loop (common modes) whose watchdog restarts on every response and
// data chunk (the idle timeout iOS 6 applies) and cancels it with NSURLErrorTimedOut; the completion runs once.
@interface ENLegacyRequest : NSObject <NSURLConnectionDataDelegate>
- (void)start:(NSURLRequest *)request completion:(ENURLCompletion)done;
@end

@implementation ENLegacyRequest {
	NSURLConnection *_conn;
	NSTimer *_timer;
	NSTimeInterval _timeout;
	NSURLResponse *_response;
	NSMutableData *_data;
	ENURLCompletion _done;
}

- (void)start:(NSURLRequest *)r completion:(ENURLCompletion)done {
	_done = [done copy];
	_timeout = r.timeoutInterval > 0 ? r.timeoutInterval : 60;
	_conn = [[NSURLConnection alloc] initWithRequest:r delegate:self startImmediately:NO];     // (it keeps its delegate)
	[_conn scheduleInRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
	[_conn start];
	[self armTimer];
}

- (void)armTimer {
	[_timer invalidate];
	_timer = [NSTimer timerWithTimeInterval:_timeout target:self selector:@selector(timedOut) userInfo:nil repeats:NO];
	[[NSRunLoop mainRunLoop] addTimer:_timer forMode:NSRunLoopCommonModes];
}

- (void)connection:(NSURLConnection *)c didReceiveResponse:(NSURLResponse *)response {
	_response = response;
	_data = [NSMutableData data];
	if (_done) [self armTimer];
}

- (void)connection:(NSURLConnection *)c didReceiveData:(NSData *)data {
	[_data appendData:data];
	if (_done) [self armTimer];
}

- (void)connectionDidFinishLoading:(NSURLConnection *)c {
	[self finishWithResponse:_response data:(_data ?: [NSData data]) error:nil];
}

- (void)connection:(NSURLConnection *)c didFailWithError:(NSError *)error {
	[self finishWithResponse:nil data:nil error:error];
}

- (void)timedOut {
	_timer = nil;
	[_conn cancel];
	NSError *e = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorTimedOut
	                             userInfo:@{ NSLocalizedDescriptionKey: @"The request timed out." }];
	[self finishWithResponse:nil data:nil error:e];
}

- (void)finishWithResponse:(NSURLResponse *)response data:(NSData *)data error:(NSError *)error {
	ENURLCompletion done = _done;
	if (!done) return;
	_done = nil;
	[_timer invalidate];
	_timer = nil;
	_conn = nil;
	done(response, data, error);
}

@end

void ENSendAsynchronousRequest(NSURLRequest *r, ENURLCompletion done) {
	if (ENSystemIs6() || !(r.HTTPBody || [r.HTTPMethod isEqualToString:@"POST"])) {
		[NSURLConnection sendAsynchronousRequest:r queue:[NSOperationQueue mainQueue] completionHandler:done];
		return;
	}
	[[[ENLegacyRequest alloc] init] start:r completion:done];
}

#pragma mark - audio (§2-I)

BOOL ENHasAudioSessionNotifications(void) {
	static int has = -1;
	if (has < 0) has = ENSymbolPresent((const void *)&AVAudioSessionInterruptionNotification) && ENSymbolPresent((const void *)&AVAudioSessionRouteChangeNotification)
		&& ENSymbolPresent((const void *)&AVAudioSessionMediaServicesWereResetNotification) && ENSymbolPresent((const void *)&AVAudioSessionInterruptionTypeKey)
		&& ENSymbolPresent((const void *)&AVAudioSessionInterruptionOptionKey) && ENSymbolPresent((const void *)&AVAudioSessionRouteChangeReasonKey) ? 1 : 0;
	return has == 1;
}

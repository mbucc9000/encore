#import "ENHUD.h"
#import "ENAppDelegate.h"
#import "ENTheme.h"

// The 3c HUD (DESIGN-3 §6; mockup .hud): 150 pt wide and at least 140 tall, centred a little above the middle of the app's
// window, black at 78 % with a 12 pt radius, a spinner or a 46 pt glyph (0.10: the check by default) over bold 15.5 pt white
// text with a black (0,-1) shadow (up to 3 lines). Colours and the font: ENTheme hudFill / hudText / hudTextShadow / hudFont.
// One view, drawn in -drawRect: (the spinner is its only subview); userInteractionEnabled NO, so it never blocks touches.
// It lives in the app's own window, not the key window: an alert or action sheet on iOS 6 is its own key window and would
// take the HUD away with it.
// (R2c, 3.5-inch screens) While a keyboard is up and the HUD would reach under it, it is centred in the room above the
// keyboard instead (the keyboard's window is over the app's). 4-inch: never (the HUD ends at ~331, the keyboard starts at
// 352); 3.5-inch: the 216 pt keyboard starts at 264, under the usual ~151-291.

static const CGFloat ENHUDWidth = 150, ENHUDMinHeight = 140, ENHUDIcon = 46, ENHUDGap = 10, ENHUDTextWidth = 126;

static UIFont *ENHUDFont(void) {
	return [ENTheme current].hudFont;
}

// an icon in the 46 pt box: white, cached by ENTheme per name / size / colour
static UIImage *ENHUDGlyph(NSString *name) {
	ENTheme *th = [ENTheme current];
	return name.length ? [th glyphNamed:name size:ENHUDIcon color:th.hudText] : nil;
}

@interface ENHUDView : UIView
@property (nonatomic, copy) NSString *text;
@property (nonatomic) BOOL busy;
@property (nonatomic, strong) UIImage *glyph;        // 0.6: drawn in place of the check mark (nil = the check mark; 0.10: 46 pt)
- (CGFloat)heightForText;
@end

@implementation ENHUDView {
	UIActivityIndicatorView *_spin;
}

- (instancetype)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		self.opaque = NO;
		self.backgroundColor = [UIColor clearColor];
		self.userInteractionEnabled = NO;
		self.contentMode = UIViewContentModeRedraw;
		_spin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleWhiteLarge];
		_spin.hidesWhenStopped = YES;
		[self addSubview:_spin];
	}
	return self;
}

- (CGFloat)textHeight {
	if (!_text.length) return 0;
	UIFont *f = ENHUDFont();
	CGFloat max = ceil(f.lineHeight * 3);
	CGSize s = [_text sizeWithFont:f constrainedToSize:CGSizeMake(ENHUDTextWidth, max) lineBreakMode:NSLineBreakByWordWrapping];
	return MIN(ceil(s.height), max);
}

- (CGFloat)heightForText {
	return MAX(ENHUDMinHeight, 18 + ENHUDIcon + ENHUDGap + [self textHeight] + 14);
}

// the icon box's top: the icon + text block is centred vertically (mockup: flex, centred)
- (CGFloat)iconTop {
	CGFloat th = [self textHeight];
	CGFloat block = ENHUDIcon + (th > 0 ? ENHUDGap + th : 0);
	return floor((self.bounds.size.height - block) / 2);
}

- (void)setBusy:(BOOL)busy {
	_busy = busy;
	if (busy) [_spin startAnimating]; else [_spin stopAnimating];
	[self setNeedsLayout];
	[self setNeedsDisplay];
}

- (void)setGlyph:(UIImage *)glyph {
	_glyph = glyph;
	[self setNeedsDisplay];
}

- (void)setText:(NSString *)text {
	_text = [text copy];
	[self setNeedsLayout];
	[self setNeedsDisplay];
}

- (void)layoutSubviews {
	[super layoutSubviews];
	_spin.center = CGPointMake(floor(self.bounds.size.width / 2), [self iconTop] + ENHUDIcon / 2);
}

- (void)drawRect:(CGRect)rect {
	CGContextRef c = UIGraphicsGetCurrentContext();
	CGRect b = self.bounds;
	ENTheme *th = [ENTheme current];
	[th.hudFill setFill];
	[[UIBezierPath bezierPathWithRoundedRect:b cornerRadius:12] fill];

	CGFloat top = [self iconTop];
	UIImage *icon = _busy ? nil : _glyph ?: ENHUDGlyph(@"check");     // 0.10: the default is the mockup's check glyph
	if (icon) {
		CGSize gs = icon.size;
		[icon drawAtPoint:CGPointMake(floor((b.size.width - gs.width) / 2), top + floor((ENHUDIcon - gs.height) / 2))];
	} else if (!_busy) {
		// (no glyph image: the 0.5 check mark, white, in the 46 pt icon box)
		CGFloat x = floor((b.size.width - ENHUDIcon) / 2);
		CGContextSaveGState(c);
		CGContextSetStrokeColorWithColor(c, th.hudText.CGColor);
		CGContextSetLineWidth(c, 4.5);
		CGContextSetLineCap(c, kCGLineCapRound);
		CGContextSetLineJoin(c, kCGLineJoinRound);
		CGContextMoveToPoint(c, x + 10, top + 24);
		CGContextAddLineToPoint(c, x + 19, top + 33);
		CGContextAddLineToPoint(c, x + 36, top + 13);
		CGContextStrokePath(c);
		CGContextRestoreGState(c);
	}
	if (_text.length) {
		CGContextSaveGState(c);
		CGContextSetShadowWithColor(c, CGSizeMake(0, -1), 0, th.hudTextShadow.CGColor);
		[th.hudText setFill];
		CGRect tr = CGRectMake(floor((b.size.width - ENHUDTextWidth) / 2), top + ENHUDIcon + ENHUDGap, ENHUDTextWidth, [self textHeight]);
		[_text drawInRect:tr withFont:ENHUDFont() lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentCenter];
		CGContextRestoreGState(c);
	}
}

@end

@implementation ENHUD

static ENHUDView *sView;
static NSTimer *sTimer;
static NSUInteger sGen;          // bumped by every show / hide: a fade-out that finishes late leaves a newer HUD alone
static CGFloat sKeyboardTop;     // (R2c) the keyboard's top on screen while one is up (between WillShow and WillHide), else 0

// (R2c) the keyboard, watched from launch (UIKit is loaded before this class: its notification names are there)
+ (void)load {
	@autoreleasepool {
		NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
		[nc addObserver:self selector:@selector(keyboardWillShow:) name:UIKeyboardWillShowNotification object:nil];
		[nc addObserver:self selector:@selector(keyboardWillHide:) name:UIKeyboardWillHideNotification object:nil];
	}
}

+ (void)keyboardWillShow:(NSNotification *)n {
	CGRect kb = [n.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue];     // screen coordinates
	sKeyboardTop = CGRectIsEmpty(kb) ? 0 : CGRectGetMinY(kb);
}

+ (void)keyboardWillHide:(NSNotification *)n {
	sKeyboardTop = 0;
}

+ (UIWindow *)window {
	id<UIApplicationDelegate> d = [UIApplication sharedApplication].delegate;
	if ([d isKindOfClass:[ENAppDelegate class]] && ((ENAppDelegate *)d).window) return ((ENAppDelegate *)d).window;
	return [UIApplication sharedApplication].keyWindow;
}

+ (void)show:(NSString *)text busy:(BOOL)busy {
	[self show:text busy:busy glyph:nil];
}

+ (void)show:(NSString *)text busy:(BOOL)busy glyph:(UIImage *)glyph {
	UIWindow *w = [self window];
	if (!w) return;
	[sTimer invalidate];
	sTimer = nil;
	sGen++;
	if (!sView) sView = [[ENHUDView alloc] initWithFrame:CGRectMake(0, 0, ENHUDWidth, ENHUDMinHeight)];
	ENHUDView *v = sView;
	BOOL appear = v.superview != w || v.alpha < 0.01;
	v.text = text;
	v.busy = busy;
	v.glyph = glyph;
	CGRect wb = w.bounds;
	CGFloat h = [v heightForText];
	CGFloat y = floor(wb.size.height * 0.46 - h / 2);
	if (sKeyboardTop > 0) {          // (R2c) reaching under the keyboard: centred between the status bar and the keyboard
		CGFloat kbTop = [w convertPoint:CGPointMake(0, sKeyboardTop) fromWindow:nil].y;
		if (y + h > kbTop - 8) y = MAX(20, floor((20 + kbTop - h) / 2));
	}
	v.transform = CGAffineTransformIdentity;
	v.frame = CGRectMake(floor((wb.size.width - ENHUDWidth) / 2), y, ENHUDWidth, h);
	if (v.superview != w) [w addSubview:v]; else [w bringSubviewToFront:v];
	if (appear) {
		v.alpha = 0;
		v.transform = CGAffineTransformMakeScale(0.9, 0.9);
	}
	[UIView animateWithDuration:0.2 delay:0 options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction
		animations:^{
			v.alpha = 1;
			v.transform = CGAffineTransformIdentity;
		} completion:nil];
	if (!busy) {
		// common modes: it must go away while a list is being scrolled too
		sTimer = [NSTimer timerWithTimeInterval:1.2 target:self selector:@selector(timerFired:) userInfo:nil repeats:NO];
		[[NSRunLoop mainRunLoop] addTimer:sTimer forMode:NSRunLoopCommonModes];
	}
}

+ (void)timerFired:(NSTimer *)t {
	if (t != sTimer) return;
	sTimer = nil;
	[self hide];
}

+ (void)showBusy:(NSString *)text {
	[self show:text busy:YES];
}

+ (void)showDone:(NSString *)text {
	[self show:text busy:NO];
}

+ (void)showDone:(NSString *)text glyph:(NSString *)name {
	[self show:text busy:NO glyph:ENHUDGlyph(name)];
}

+ (void)hide {
	[sTimer invalidate];
	sTimer = nil;
	ENHUDView *v = sView;
	if (!v.superview) return;
	NSUInteger gen = ++sGen;
	[UIView animateWithDuration:0.25 delay:0 options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction
		animations:^{
			v.alpha = 0;
		} completion:^(BOOL finished) {
			if (gen != sGen) return;
			v.busy = NO;
			[v removeFromSuperview];
		}];
}

// hides the HUD only while it still says `text`: a failed like takes back its own "Saved to Liked Songs", never an
// "Adding…" that replaced it (0.6: public; the Jam actions use it too)
+ (void)hideText:(NSString *)text {
	if (sView.superview && sView.alpha > 0.01 && [sView.text isEqualToString:text]) [self hide];
}

@end

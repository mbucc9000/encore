#import "ENJamBar.h"
#import "ENTheme.h"

// 0.10: glyph + gap + text are one block centred in the bar (mockup .connect-bar: justify-content center, gap 5px); the text
// is cut to -textWidth, so the block never runs into the 8 pt margins.
static const CGFloat ENJamBarHeight = 18, ENJamBarMargin = 8, ENJamBarGap = 5;

@implementation ENJamBar

+ (CGFloat)height { return ENJamBarHeight; }

+ (UIFont *)font {
	return [ENTheme current].jamBarFont;
}

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		ENTheme *th = [ENTheme current];
		self.opaque = YES;
		self.backgroundColor = th.jamBarFill;
		self.contentMode = UIViewContentModeRedraw;
		self.exclusiveTouch = YES;
		_glyph = [ENJamBar glyphForMode:ENJamBarModeJam];
		UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(tapped)];
		[self addGestureRecognizer:tap];
	}
	return self;
}

// (3b) the mode's glyph, white: people 14 pt (Jam) or speakerHi 13 pt (Connect, mockup .connect-bar)
+ (UIImage *)glyphForMode:(ENJamBarMode)mode {
	ENTheme *th = [ENTheme current];
	return mode == ENJamBarModeConnect ? [th glyphNamed:@"speakerHi" size:13 color:th.jamBarText]
	                                   : [th glyphNamed:@"people" size:14 color:th.jamBarText];
}

- (void)setMode:(ENJamBarMode)mode {
	if (mode == _mode) return;
	_mode = mode;
	self.glyph = [ENJamBar glyphForMode:mode];
}

- (void)tapped {
	if (self.onTap) self.onTap();
}

- (void)setText:(NSString *)text {
	if (text == _text || [text isEqualToString:_text]) return;
	_text = [text copy];
	[self setNeedsDisplay];
}

- (void)setGlyph:(UIImage *)glyph {
	_glyph = glyph;
	[self setNeedsDisplay];
}

- (CGFloat)textWidth {
	CGFloat g = _glyph ? _glyph.size.width + ENJamBarGap : 0;
	return MAX(self.bounds.size.width - 2 * ENJamBarMargin - g, 10);
}

- (void)drawRect:(CGRect)rect {
	CGRect b = self.bounds;
	CGContextRef c = UIGraphicsGetCurrentContext();
	ENTheme *th = [ENTheme current];
	[th.jamBarImage drawInRect:b];
	UIFont *f = [ENJamBar font];
	BOOL text = _text.length > 0;
	CGFloat gw = _glyph ? _glyph.size.width : 0, gap = _glyph && text ? ENJamBarGap : 0;
	CGFloat tw = text ? MIN(ceilf([_text sizeWithFont:f].width), [self textWidth]) : 0;
	CGFloat x = floorf((b.size.width - gw - gap - tw) / 2);
	if (_glyph) [_glyph drawAtPoint:CGPointMake(x, floorf((b.size.height - _glyph.size.height) / 2))];
	if (!text) return;
	CGContextSetShadowWithColor(c, CGSizeMake(0, -1), 0, th.jamBarTextShadow.CGColor);
	[th.jamBarText set];
	[_text drawAtPoint:CGPointMake(x + gw + gap, floorf((b.size.height - f.lineHeight) / 2)) forWidth:tw withFont:f
	     lineBreakMode:NSLineBreakByTruncatingTail];
}

@end

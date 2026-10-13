#import "ENTheme.h"
#import "ENL.h"
#import "ENAppDelegate.h"
#import "ENUtil.h"
#import "ENDiag.h"
#import "ENCompat.h"

// Drop 3a (DESIGN-5 §1, A1): three palettes, the Appearance and Text size settings, the Automatic clock, every token of
// §1.3-1.5 and the C1 chrome. See ENTheme.h. Chrome images live in shared statics (ENShared); content images in each palette's
// own cache (-cached:make:), which a memory warning empties for the palette that is neither +current nor +queue.
// A6 (0.10): dark mode is off behind ENTheme.h's EN_DARK_MODE (0 = Light only; the #if blocks below keep the full mechanism).
// B1 (0.11): the Explicit Badges setting, the NP chrome / slider kit / pager dots / repeat-one images (end of file), the final
// +queue values and the reworked tab selection indicator.
// C1 (1.0, Drop 3c): the Ghost button style, +configureButton:style:title:glyph: (C7), homeBackground and the Setup images and
// tokens (end of file); artistShade .65 -> .75. Additions only otherwise.

NSString *const ENThemeDidChangeNotification = @"ENThemeDidChangeNotification";
NSString *const ENAppearanceDefaultsKey = @"encore.appearance";
NSString *const ENTextSizeDefaultsKey = @"encore.textSize";
NSString *const ENExplicitBadgesDefaultsKey = @"encore.explicitBadges";
NSString *const ENButtonGlyphPlayDisc = @"playDisc";

// (0.10: moved here from ENAppDelegate.m, still declared in ENAppDelegate.h, so every literal colour lives in this file)
UIColor *ENColor(unsigned rgb) {
	return [UIColor colorWithRed:((rgb >> 16) & 0xff) / 255.0 green:((rgb >> 8) & 0xff) / 255.0 blue:(rgb & 0xff) / 255.0 alpha:1];
}

typedef enum { ENPaletteLight = 0, ENPaletteDark, ENPaletteQueue } ENPalette;

static ENTheme *sCurrent;                  // +light or +dark (nil until first asked)
static ENAppearance sAppearance = ENAppearanceLight;
static ENTextSize sTextSize = ENTextSizeDefault;
static BOOL sExplicitBadges = YES;         // (3b) encore.explicitBadges; YES when never set
static BOOL sSettingsLoaded;
static NSTimer *sClock;                    // Automatic: the next 07:00 / 19:00 boundary + 1 s (only while active)
static NSMutableDictionary *sAlertImages;  // alert panels by size (dropped on a memory warning)
static UIFont *sRowTitle, *sRowSub, *sRowNumber, *sRowBadge;     // the text-size row fonts

#pragma mark - drawing helpers

static UIColor *ENRGBA(unsigned rgb, CGFloat a) { return [ENColor(rgb) colorWithAlphaComponent:a]; }
static UIColor *ENGrey(CGFloat white, CGFloat a) { return [UIColor colorWithWhite:white alpha:a]; }

static CGGradientRef ENGradientCreate(NSArray *colors, const CGFloat *locs) {
	CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
	NSMutableArray *cg = [NSMutableArray arrayWithCapacity:colors.count];
	for (UIColor *col in colors) [cg addObject:(__bridge id)col.CGColor];
	CGGradientRef g = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)cg, locs);
	CGColorSpaceRelease(cs);
	return g;
}

// a vertical gradient over r (colours are RGB UIColors; locs NULL = evenly spaced)
static void ENVGradient(CGContextRef c, CGRect r, NSArray *colors, const CGFloat *locs) {
	CGGradientRef g = ENGradientCreate(colors, locs);
	CGContextSaveGState(c);
	CGContextClipToRect(c, r);
	CGContextDrawLinearGradient(c, g, CGPointMake(0, CGRectGetMinY(r)), CGPointMake(0, CGRectGetMaxY(r)), 0);
	CGContextRestoreGState(c);
	CGGradientRelease(g);
}

// the same, left to right
static void ENHGradient(CGContextRef c, CGRect r, NSArray *colors, const CGFloat *locs) {
	CGGradientRef g = ENGradientCreate(colors, locs);
	CGContextSaveGState(c);
	CGContextClipToRect(c, r);
	CGContextDrawLinearGradient(c, g, CGPointMake(CGRectGetMinX(r), 0), CGPointMake(CGRectGetMaxX(r), 0), 0);
	CGContextRestoreGState(c);
	CGGradientRelease(g);
}

// the same along the diagonal (top-left -> bottom-right), clipped to whatever the caller set up
static void ENDGradient(CGContextRef c, CGRect r, UIColor *from, UIColor *to) {
	CGGradientRef g = ENGradientCreate(@[ from, to ], NULL);
	CGContextDrawLinearGradient(c, g, r.origin, CGPointMake(CGRectGetMaxX(r), CGRectGetMaxY(r)), 0);
	CGGradientRelease(g);
}

// a radial gradient from ctr out to `radius`, its last colour carried on beyond (CSS radial-gradient), clipped by the caller
static void ENRadial(CGContextRef c, CGPoint ctr, CGFloat radius, NSArray *colors, const CGFloat *locs) {
	CGGradientRef g = ENGradientCreate(colors, locs);
	CGContextDrawRadialGradient(c, g, ctr, 0, ctr, radius, kCGGradientDrawsAfterEndLocation);
	CGGradientRelease(g);
}

static void ENFill(CGContextRef c, CGRect r, UIColor *col) {
	CGContextSetFillColorWithColor(c, col.CGColor);
	CGContextFillRect(c, r);
}

static UIFont *ENHN(BOOL bold, CGFloat size) {
	UIFont *f = [UIFont fontWithName:(bold ? @"HelveticaNeue-Bold" : @"HelveticaNeue") size:size];
	return f ?: (bold ? [UIFont boldSystemFontOfSize:size] : [UIFont systemFontOfSize:size]);
}

// (1.1) iOS 6: resizableImageWithCapInsets:resizingMode:Stretch; iOS 5 (no stretch mode: a resizable centre tiles) see
// ENResizableImage, and the row bands below, which iOS 5 draws at the row height itself
static UIImage *ENStretch(UIImage *img, UIEdgeInsets caps) {
	return ENResizableImage(img, caps);
}

// A 1 pt wide opaque strip `h` tall, stretched vertically between the caps (cell / bar backgrounds).
static UIImage *ENStrip(CGFloat h, CGFloat capTop, CGFloat capBottom, void (^draw)(CGContextRef c, CGSize s)) {
	UIImage *img = [ENTheme imageOfSize:CGSizeMake(1, h) opaque:YES drawing:draw];
	return ENStretch(img, UIEdgeInsetsMake(capTop, 0, capBottom, 0));
}

// a row / header band: a two-colour gradient with a 1 pt line at the top and at the bottom
static UIImage *ENBand(CGFloat h, unsigned from, unsigned to, unsigned top, unsigned bottom) {
	return ENStrip(h, 1, 1, ^(CGContextRef c, CGSize s) {
		ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(from), ENColor(to) ], NULL);
		ENFill(c, CGRectMake(0, 0, s.width, 1), ENColor(top));
		ENFill(c, CGRectMake(0, s.height - 1, s.width, 1), ENColor(bottom));
	});
}

// an inner shadow (CSS box-shadow: inset): a frame round the shape casts it, clipped to the shape
static void ENInnerShadow(CGContextRef c, UIBezierPath *shape, CGSize offset, CGFloat blur, UIColor *color) {
	CGContextSaveGState(c);
	[shape addClip];
	CGContextSetShadowWithColor(c, offset, blur, color.CGColor);
	UIBezierPath *frame = [UIBezierPath bezierPathWithRect:CGRectInset(shape.bounds, -20, -20)];
	[frame appendPath:shape];
	frame.usesEvenOddFillRule = YES;
	[[UIColor blackColor] setFill];
	[frame fill];
	CGContextRestoreGState(c);
}

// The mockup's glossy controls (bar buttons, sheet buttons, gbtns): an optional highlight 1 pt under the shape, the gradient
// clipped to the shape (top to bottom of its box), an optional pressed inner shadow from the top, an optional 1 pt highlight
// just inside the top edge, then the 1 pt border stroked on the (half-point) path.
static void ENGloss(CGContextRef c, UIBezierPath *shape, NSArray *cols, const CGFloat *locs, UIColor *border, UIColor *innerTop,
                    UIColor *outerBottom, UIColor *pressedShadow) {
	CGRect box = shape.bounds;
	if (outerBottom) {
		CGContextSaveGState(c);
		CGContextTranslateCTM(c, 0, 1);
		[outerBottom setFill];
		[shape fill];
		CGContextRestoreGState(c);
	}
	CGContextSaveGState(c);
	[shape addClip];
	ENVGradient(c, box, cols, locs);
	if (innerTop) ENFill(c, CGRectMake(box.origin.x, box.origin.y + 0.5f, box.size.width, 1), innerTop);
	CGContextRestoreGState(c);
	if (pressedShadow) ENInnerShadow(c, shape, CGSizeMake(0, 1), 3, pressedShadow);
	if (border) {
		[border setStroke];
		shape.lineWidth = 1;
		[shape stroke];
	}
}

static NSString *ENColorKey(UIColor *color) {
	CGFloat r = 0, g = 0, b = 0, a = 1;
	if (![color getRed:&r green:&g blue:&b alpha:&a] && [color getWhite:&r alpha:&a]) g = b = r;
	return [NSString stringWithFormat:@"%.3f,%.3f,%.3f,%.3f", r, g, b, a];
}

// chrome images: built once, shared by every palette
static UIImage *ENShared(NSString *key, UIImage *(^make)(void)) {
	static NSMutableDictionary *cache;
	if (!cache) cache = [NSMutableDictionary dictionary];
	UIImage *img = cache[key];
	if (img) return img;
	img = make();
	if (img) cache[key] = img;
	return img;
}

#pragma mark - the mockup's 24-box glyph paths (art.js ICONS)

static void ENHeartPath(CGContextRef c) {
	CGContextMoveToPoint(c, 12, 20.7);
	CGContextAddCurveToPoint(c, 12, 20.7, 4.4, 16.1, 2.4, 11.4);
	CGContextAddCurveToPoint(c, 1, 8.1, 3.2, 4.3, 6.9, 4.3);
	CGContextAddCurveToPoint(c, 9, 4.3, 10.5, 5.4, 12, 7.2);
	CGContextAddCurveToPoint(c, 13.5, 5.4, 15, 4.3, 17.1, 4.3);
	CGContextAddCurveToPoint(c, 20.8, 4.3, 23, 8.1, 21.6, 11.4);
	CGContextAddCurveToPoint(c, 19.6, 16.1, 12, 20.7, 12, 20.7);
	CGContextClosePath(c);
}

static void ENNotePath(CGContextRef c) {          // two beamed notes
	CGContextAddRect(c, CGRectMake(9, 3.2, 2, 14.4));
	CGContextAddRect(c, CGRectMake(19, 1.6, 2, 14));
	CGContextMoveToPoint(c, 9, 3.5);
	CGContextAddLineToPoint(c, 21, 1.8);
	CGContextAddLineToPoint(c, 21, 6);
	CGContextAddLineToPoint(c, 9, 7.8);
	CGContextClosePath(c);
	CGContextAddEllipseInRect(c, CGRectMake(4.6, 14.4, 6.4, 6.4));
	CGContextAddEllipseInRect(c, CGRectMake(14.6, 12.4, 6.4, 6.4));
}

static void ENArtistPath(CGContextRef c) {
	CGContextAddEllipseInRect(c, CGRectMake(12 - 4.6, 3, 9.2, 9.2));
	CGContextMoveToPoint(c, 3.5, 21);
	CGContextAddCurveToPoint(c, 4.1, 16.4, 7.7, 13.8, 12, 13.8);
	CGContextAddCurveToPoint(c, 16.3, 13.8, 19.9, 16.4, 20.5, 21);
	CGContextClosePath(c);
}

// 0.6 (art.js people): two heads and two shoulders, even-odd filled
static void ENPeoplePath(CGContextRef c) {
	CGContextAddEllipseInRect(c, CGRectMake(8.5f - 3.6f, 8 - 3.6f, 7.2f, 7.2f));
	CGContextAddEllipseInRect(c, CGRectMake(16.5f - 3, 9 - 3, 6, 6));
	CGContextMoveToPoint(c, 1.5f, 20.5f);
	CGContextAddCurveToPoint(c, 2, 16.2f, 4.8f, 13.9f, 8.5f, 13.9f);
	CGContextAddCurveToPoint(c, 12.2f, 13.9f, 15, 16.2f, 15.5f, 20.5f);
	CGContextClosePath(c);
	CGContextMoveToPoint(c, 14.2f, 14.3f);
	CGContextAddCurveToPoint(c, 14.9f, 14, 15.7f, 13.9f, 16.5f, 13.9f);
	CGContextAddCurveToPoint(c, 19.6f, 13.9f, 21.9f, 15.9f, 22.4f, 19.5f);
	CGContextAddLineToPoint(c, 16.8f, 19.5f);
	CGContextAddCurveToPoint(c, 16.5f, 17.4f, 15.6f, 15.6f, 14.2f, 14.3f);
	CGContextClosePath(c);
}

// 0.6 (art.js message): a speech bubble with its tail at the lower left
static void ENMessagePath(CGContextRef c) {
	CGContextMoveToPoint(c, 12, 3.5f);
	CGContextAddCurveToPoint(c, 6.8f, 3.5f, 2.5f, 6.9f, 2.5f, 11.2f);
	CGContextAddCurveToPoint(c, 2.5f, 13.6f, 3.9f, 15.8f, 6, 17.2f);
	CGContextAddLineToPoint(c, 5, 21);
	CGContextAddLineToPoint(c, 9.3f, 18.6f);
	CGContextAddCurveToPoint(c, 10.2f, 18.8f, 11.1f, 18.9f, 12, 18.9f);
	CGContextAddCurveToPoint(c, 17.2f, 18.9f, 21.5f, 15.5f, 21.5f, 11.2f);
	CGContextAddCurveToPoint(c, 21.5f, 6.9f, 17.2f, 3.5f, 12, 3.5f);
	CGContextClosePath(c);
}

// 0.6 (art.js link): two chain links. The SVG arcs (sweep 0 = decreasing angle in this y-down space, CG's clockwise 1); the
// two 6/6 arcs have a radius under half their chord, so (as SVG does) they become half circles.
static void ENLinkPath(CGContextRef c) {
	CGFloat d = 2.9394f, h = 4.2426f;          // sqrt(4.2² - 3²), and 3·√2
	CGContextMoveToPoint(c, 10, 14);
	CGContextAddArc(c, 13, 14 - d, 4.2f, 2.3662f, 0.7754f, 1);
	CGContextAddLineToPoint(c, 19, 11);
	CGContextAddArc(c, 16, 8, h, (CGFloat)M_PI_4, (CGFloat)(-3 * M_PI_4), 1);
	CGContextAddLineToPoint(c, 11.8f, 6.2f);
	CGContextMoveToPoint(c, 14, 10);
	CGContextAddArc(c, 11, 10 + d, 4.2f, -0.7754f, -2.3662f, 1);
	CGContextAddLineToPoint(c, 5, 13);
	CGContextAddArc(c, 8, 16, h, (CGFloat)(-3 * M_PI_4), (CGFloat)(M_PI_4 - 2 * M_PI), 1);
	CGContextAddLineToPoint(c, 12.2f, 17.8f);
}

static void ENTri(CGContextRef c, CGFloat x0, CGFloat y0, CGFloat x1, CGFloat y1, CGFloat x2, CGFloat y2) {
	CGContextMoveToPoint(c, x0, y0);
	CGContextAddLineToPoint(c, x1, y1);
	CGContextAddLineToPoint(c, x2, y2);
	CGContextClosePath(c);
}

static void ENGearPath(CGContextRef c) {          // 16 alternating radii, k = 0.1 rad, a 3.4 hole (even-odd)
	for (int i = 0; i < 16; i++) {
		CGFloat a0 = (CGFloat)(i / 16.0 * 2 * M_PI), a1 = (CGFloat)((i + 1) / 16.0 * 2 * M_PI), r = (i % 2) ? 7.9f : 10.4f, k = 0.1f;
		CGFloat x0 = 12 + r * cosf(a0 + k), y0 = 12 + r * sinf(a0 + k), x1 = 12 + r * cosf(a1 - k), y1 = 12 + r * sinf(a1 - k);
		if (i == 0) CGContextMoveToPoint(c, x0, y0);
		else CGContextAddLineToPoint(c, x0, y0);
		CGContextAddLineToPoint(c, x1, y1);
	}
	CGContextClosePath(c);
	CGContextAddEllipseInRect(c, CGRectMake(12 - 3.4f, 12 - 3.4f, 6.8f, 6.8f));
}

// 0.10: SVG "A r r 0 large sweep x1 y1" from (x0, y0), the current point. As SVG does, a radius under half the chord grows to
// it. sweep 1 = increasing angle in this y-down space = CG's clockwise 0 (see ENLinkPath); the centre lies right of the
// direction of travel when large != sweep.
static void ENArcTo(CGContextRef c, CGFloat x0, CGFloat y0, CGFloat x1, CGFloat y1, CGFloat r, BOOL large, BOOL sweep) {
	CGFloat dx = x1 - x0, dy = y1 - y0, chord = sqrtf(dx * dx + dy * dy);
	if (chord < 0.0001f) return;
	if (r < chord / 2) r = chord / 2;
	CGFloat hh = r * r - chord * chord / 4, h = hh > 0 ? sqrtf(hh) : 0, side = (large != sweep) ? 1 : -1;
	CGFloat cx = (x0 + x1) / 2 + side * h * (-dy / chord), cy = (y0 + y1) / 2 + side * h * (dx / chord);
	CGContextAddArc(c, cx, cy, r, atan2f(y0 - cy, x0 - cx), atan2f(y1 - cy, x1 - cx), sweep ? 0 : 1);
}

static void ENRoundRectPath(CGContextRef c, CGRect r, CGFloat rad) {
	CGFloat x0 = CGRectGetMinX(r), x1 = CGRectGetMaxX(r), y0 = CGRectGetMinY(r), y1 = CGRectGetMaxY(r);
	CGContextMoveToPoint(c, x0 + rad, y0);
	CGContextAddArcToPoint(c, x1, y0, x1, y1, rad);
	CGContextAddArcToPoint(c, x1, y1, x0, y1, rad);
	CGContextAddArcToPoint(c, x0, y1, x0, y0, rad);
	CGContextAddArcToPoint(c, x0, y0, x1, y0, rad);
	CGContextClosePath(c);
}

// 0.10 (art.js speaker): the cone, filled
static void ENSpeakerPath(CGContextRef c) {
	CGContextMoveToPoint(c, 3, 9);
	CGContextAddLineToPoint(c, 7, 9);
	CGContextAddLineToPoint(c, 12, 4.5f);
	CGContextAddLineToPoint(c, 12, 19.5f);
	CGContextAddLineToPoint(c, 7, 15);
	CGContextAddLineToPoint(c, 3, 15);
	CGContextClosePath(c);
}

// 0.10 (art.js wifi): the dot's wedge, then three bands, each out along one arc and back along the next
static void ENWifiPath(CGContextRef c) {
	CGContextMoveToPoint(c, 12, 18.6f);
	CGContextAddLineToPoint(c, 14.4f, 15.7f);
	ENArcTo(c, 14.4f, 15.7f, 9.6f, 15.7f, 3.8f, NO, NO);
	CGContextClosePath(c);
	CGContextMoveToPoint(c, 7.9f, 13.6f);
	CGContextAddLineToPoint(c, 9.3f, 15.3f);
	ENArcTo(c, 9.3f, 15.3f, 14.7f, 15.3f, 4.3f, NO, YES);
	CGContextAddLineToPoint(c, 16.1f, 13.6f);
	ENArcTo(c, 16.1f, 13.6f, 7.9f, 13.6f, 6.5f, NO, NO);
	CGContextClosePath(c);
	CGContextMoveToPoint(c, 5.1f, 10.2f);
	CGContextAddLineToPoint(c, 6.5f, 11.9f);
	ENArcTo(c, 6.5f, 11.9f, 17.5f, 11.9f, 8.6f, NO, YES);
	CGContextAddLineToPoint(c, 18.9f, 10.2f);
	ENArcTo(c, 18.9f, 10.2f, 5.1f, 10.2f, 10.9f, NO, NO);
	CGContextClosePath(c);
	CGContextMoveToPoint(c, 2.3f, 6.8f);
	CGContextAddLineToPoint(c, 3.7f, 8.5f);
	ENArcTo(c, 3.7f, 8.5f, 20.3f, 8.5f, 13, NO, YES);
	CGContextAddLineToPoint(c, 21.7f, 6.8f);
	ENArcTo(c, 21.7f, 6.8f, 2.3f, 6.8f, 15.2f, NO, NO);
	CGContextClosePath(c);
}

// 0.10 (art.js folder): a tab on the left, rounded 1.5 corners
static void ENFolderPath(CGContextRef c) {
	CGContextMoveToPoint(c, 2.5f, 6.5f);
	ENArcTo(c, 2.5f, 6.5f, 4, 5, 1.5f, NO, YES);
	CGContextAddLineToPoint(c, 9, 5);
	CGContextAddLineToPoint(c, 11, 7.2f);
	CGContextAddLineToPoint(c, 20, 7.2f);
	ENArcTo(c, 20, 7.2f, 21.5f, 8.7f, 1.5f, NO, YES);
	CGContextAddLineToPoint(c, 21.5f, 18.5f);
	ENArcTo(c, 21.5f, 18.5f, 20, 20, 1.5f, NO, YES);
	CGContextAddLineToPoint(c, 4, 20);
	ENArcTo(c, 4, 20, 2.5f, 18.5f, 1.5f, NO, YES);
	CGContextClosePath(c);
}

// Draws glyph `name` in the 24-box (the caller scaled the CTM) with the current fill / stroke colour.
static void ENDrawGlyph(CGContextRef c, NSString *name) {
	CGContextSetLineCap(c, kCGLineCapRound);
	CGContextSetLineJoin(c, kCGLineJoinRound);
	if ([name isEqualToString:@"play"]) {
		ENTri(c, 7.4f, 4.4f, 20, 12, 7.4f, 19.6f);
		CGContextSetLineWidth(c, 1.2f);
		CGContextDrawPath(c, kCGPathFillStroke);
	} else if ([name isEqualToString:@"pause"]) {
		CGContextFillRect(c, CGRectMake(6, 4, 4.3f, 16));
		CGContextFillRect(c, CGRectMake(13.7f, 4, 4.3f, 16));
	} else if ([name isEqualToString:@"next"]) {
		ENTri(c, 2.5f, 5.2f, 10.9f, 12, 2.5f, 18.8f);
		ENTri(c, 10.9f, 5.2f, 19.3f, 12, 10.9f, 18.8f);
		CGContextAddRect(c, CGRectMake(19.5f, 5, 2.2f, 14));
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"prev"]) {
		ENTri(c, 21.5f, 5.2f, 13.1f, 12, 21.5f, 18.8f);
		ENTri(c, 13.1f, 5.2f, 4.7f, 12, 13.1f, 18.8f);
		CGContextAddRect(c, CGRectMake(2.3f, 5, 2.2f, 14));
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"shuffle"]) {
		CGContextSetLineWidth(c, 1.9f);
		CGContextMoveToPoint(c, 2.5f, 7.5f);
		CGContextAddLineToPoint(c, 5.7f, 7.5f);
		CGContextAddCurveToPoint(c, 10.2f, 7.5f, 12.3f, 16.5f, 17, 16.5f);
		CGContextAddLineToPoint(c, 20.5f, 16.5f);
		CGContextMoveToPoint(c, 17.5f, 13.5f);
		CGContextAddLineToPoint(c, 20.5f, 16.5f);
		CGContextAddLineToPoint(c, 17.5f, 19.5f);
		CGContextMoveToPoint(c, 2.5f, 16.5f);
		CGContextAddLineToPoint(c, 5.7f, 16.5f);
		CGContextAddCurveToPoint(c, 7.4f, 16.5f, 8.7f, 15.1f, 9.8f, 13.3f);
		CGContextMoveToPoint(c, 13, 10.3f);
		CGContextAddCurveToPoint(c, 14.1f, 8.7f, 15.4f, 7.5f, 17, 7.5f);
		CGContextAddLineToPoint(c, 20.5f, 7.5f);
		CGContextMoveToPoint(c, 17.5f, 4.5f);
		CGContextAddLineToPoint(c, 20.5f, 7.5f);
		CGContextAddLineToPoint(c, 17.5f, 10.5f);
		CGContextStrokePath(c);
	} else if ([name hasPrefix:@"repeat"]) {
		CGContextSetLineWidth(c, 1.9f);
		CGContextMoveToPoint(c, 3.5f, 11.5f);
		CGContextAddLineToPoint(c, 3.5f, 9.5f);
		CGContextAddArcToPoint(c, 3.5f, 6.5f, 6.5f, 6.5f, 3);
		CGContextAddLineToPoint(c, 19.5f, 6.5f);
		CGContextMoveToPoint(c, 16.5f, 3.5f);
		CGContextAddLineToPoint(c, 19.5f, 6.5f);
		CGContextAddLineToPoint(c, 16.5f, 9.5f);
		CGContextMoveToPoint(c, 20.5f, 12.5f);
		CGContextAddLineToPoint(c, 20.5f, 14.5f);
		CGContextAddArcToPoint(c, 20.5f, 17.5f, 17.5f, 17.5f, 3);
		CGContextAddLineToPoint(c, 4.5f, 17.5f);
		CGContextMoveToPoint(c, 7.5f, 20.5f);
		CGContextAddLineToPoint(c, 4.5f, 17.5f);
		CGContextAddLineToPoint(c, 7.5f, 14.5f);
		CGContextStrokePath(c);
		if ([name isEqualToString:@"repeatOne"]) {      // a small "1" in the loop
			CGContextFillEllipseInRect(c, CGRectMake(8.6f, 7.6f, 6.8f, 8.8f));
			CGContextSetBlendMode(c, kCGBlendModeClear);
			CGContextFillRect(c, CGRectMake(11.2f, 9.2f, 1.7f, 5.6f));
			CGContextFillRect(c, CGRectMake(10.2f, 9.2f, 1.6f, 1.4f));
			CGContextSetBlendMode(c, kCGBlendModeNormal);
		}
	} else if ([name isEqualToString:@"plus"]) {
		CGContextSetLineWidth(c, 1.8f);
		CGContextStrokeEllipseInRect(c, CGRectMake(2.5f, 2.5f, 19, 19));
		CGContextSetLineWidth(c, 2);
		CGContextMoveToPoint(c, 12, 7.5f);
		CGContextAddLineToPoint(c, 12, 16.5f);
		CGContextMoveToPoint(c, 7.5f, 12);
		CGContextAddLineToPoint(c, 16.5f, 12);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"clock"]) {     // 0.7: Library's Recently Played
		CGContextSetLineWidth(c, 2.2f);
		CGContextStrokeEllipseInRect(c, CGRectMake(3, 3, 18, 18));
		CGContextMoveToPoint(c, 12, 7);
		CGContextAddLineToPoint(c, 12, 12);
		CGContextAddLineToPoint(c, 15.5f, 14.5f);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"mic"]) {       // 0.8: Now Playing's Lyrics button
		// the head: a 6.6 x 12 capsule (two half circles of r 3.3 joined by straight sides), filled
		CGContextMoveToPoint(c, 8.7f, 5.5f);
		CGContextAddArc(c, 12, 5.5f, 3.3f, (CGFloat)M_PI, 0, 0);
		CGContextAddLineToPoint(c, 15.3f, 10.9f);
		CGContextAddArc(c, 12, 10.9f, 3.3f, 0, (CGFloat)M_PI, 0);
		CGContextClosePath(c);
		CGContextFillPath(c);
		// the U-shaped holder around its lower half, the stem and the base
		CGContextSetLineWidth(c, 1.9f);
		CGContextMoveToPoint(c, 5.6f, 9);
		CGContextAddLineToPoint(c, 5.6f, 11);
		CGContextAddArc(c, 12, 11, 6.4f, (CGFloat)M_PI, 0, 1);
		CGContextAddLineToPoint(c, 18.4f, 9);
		CGContextMoveToPoint(c, 12, 17.4f);
		CGContextAddLineToPoint(c, 12, 21);
		CGContextMoveToPoint(c, 8.4f, 21);
		CGContextAddLineToPoint(c, 15.6f, 21);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"dots"]) {
		CGContextFillEllipseInRect(c, CGRectMake(3.5f, 10, 4, 4));
		CGContextFillEllipseInRect(c, CGRectMake(10, 10, 4, 4));
		CGContextFillEllipseInRect(c, CGRectMake(16.5f, 10, 4, 4));
	} else if ([name isEqualToString:@"album"]) {
		CGContextAddEllipseInRect(c, CGRectMake(2.5f, 2.5f, 19, 19));
		CGContextAddEllipseInRect(c, CGRectMake(9, 9, 6, 6));
		CGContextEOFillPath(c);
	} else if ([name isEqualToString:@"artist"]) {
		ENArtistPath(c);
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"chevDown"]) {
		CGContextSetLineWidth(c, 2.6f);
		CGContextMoveToPoint(c, 5.5f, 9);
		CGContextAddLineToPoint(c, 12, 15.5f);
		CGContextAddLineToPoint(c, 18.5f, 9);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"note"]) {
		ENNotePath(c);
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"heart"]) {
		ENHeartPath(c);
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"people"]) {
		ENPeoplePath(c);
		CGContextEOFillPath(c);
	} else if ([name isEqualToString:@"message"]) {
		ENMessagePath(c);
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"link"]) {
		CGContextSetLineWidth(c, 2.1f);
		ENLinkPath(c);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"queue"]) {     // three lines and a play triangle
		CGContextSetLineWidth(c, 2);
		CGContextMoveToPoint(c, 3, 6);
		CGContextAddLineToPoint(c, 17, 6);
		CGContextMoveToPoint(c, 3, 11);
		CGContextAddLineToPoint(c, 17, 11);
		CGContextMoveToPoint(c, 3, 16);
		CGContextAddLineToPoint(c, 12, 16);
		CGContextStrokePath(c);
		ENTri(c, 15.5f, 15, 20.5f, 18, 15.5f, 21);
		CGContextDrawPath(c, kCGPathFillStroke);
	} else if ([name isEqualToString:@"pin"]) {       // 0.9: a pinned playlist (Spotify's push pin, leaning right)
		CGContextSaveGState(c);
		CGContextTranslateCTM(c, 12, 12);
		CGContextRotateCTM(c, (CGFloat)M_PI_4);          // y-down: clockwise, the head to the upper right
		CGContextTranslateCTM(c, -12, -12);
		// upright: the cap, the body, the flared collar, then the needle
		CGContextMoveToPoint(c, 8, 2.5f);
		CGContextAddLineToPoint(c, 16, 2.5f);
		CGContextAddLineToPoint(c, 16, 5);
		CGContextAddLineToPoint(c, 14.6f, 5);
		CGContextAddLineToPoint(c, 14.6f, 10.4f);
		CGContextAddLineToPoint(c, 18, 14.4f);
		CGContextAddLineToPoint(c, 6, 14.4f);
		CGContextAddLineToPoint(c, 9.4f, 10.4f);
		CGContextAddLineToPoint(c, 9.4f, 5);
		CGContextAddLineToPoint(c, 8, 5);
		CGContextClosePath(c);
		CGContextFillPath(c);
		CGContextSetLineWidth(c, 2.2f);
		CGContextMoveToPoint(c, 12, 14);
		CGContextAddLineToPoint(c, 12, 21.5f);
		CGContextStrokePath(c);
		CGContextRestoreGState(c);
	} else if ([name isEqualToString:@"close"]) {     // 0.9.5: a thin × (Search's recent rows: remove one)
		CGContextSetLineWidth(c, 1.9f);
		CGContextMoveToPoint(c, 6, 6);
		CGContextAddLineToPoint(c, 18, 18);
		CGContextMoveToPoint(c, 18, 6);
		CGContextAddLineToPoint(c, 6, 18);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"x"]) {         // 0.10 (art.js from here on): HUD removals, a bold ×
		CGContextSetLineWidth(c, 2.6f);
		CGContextMoveToPoint(c, 6.5f, 6.5f);
		CGContextAddLineToPoint(c, 17.5f, 17.5f);
		CGContextMoveToPoint(c, 17.5f, 6.5f);
		CGContextAddLineToPoint(c, 6.5f, 17.5f);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"check"]) {     // HUD, Settings, pickers
		CGContextSetLineWidth(c, 3);
		CGContextMoveToPoint(c, 4.5f, 12.5f);
		CGContextAddLineToPoint(c, 9.5f, 17.5f);
		CGContextAddLineToPoint(c, 19.5f, 7);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"speaker"] || [name isEqualToString:@"speakerHi"]) {     // the playing row, volume, Connect
		ENSpeakerPath(c);
		CGContextFillPath(c);
		if ([name isEqualToString:@"speakerHi"]) {       // two sound waves
			CGContextSetLineWidth(c, 1.8f);
			CGContextMoveToPoint(c, 15, 8.5f);
			ENArcTo(c, 15, 8.5f, 15, 15.5f, 5, NO, YES);
			CGContextStrokePath(c);
			CGContextMoveToPoint(c, 17.6f, 5.8f);
			ENArcTo(c, 17.6f, 5.8f, 17.6f, 18.2f, 8.6f, NO, YES);
			CGContextStrokePath(c);
		}
	} else if ([name isEqualToString:@"list"]) {      // Now Playing's Up Next button: three bullets and lines
		for (int i = 0; i < 3; i++) {
			CGContextAddRect(c, CGRectMake(3, 5.2f + i * 5.2f, 3.2f, 3.2f));
			CGContextAddRect(c, CGRectMake(8.2f, 5.8f + i * 5.2f, 12.8f, 2));
		}
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"chevRight"]) { // grouped rows
		CGContextSetLineWidth(c, 2.6f);
		CGContextMoveToPoint(c, 9, 5.5f);
		CGContextAddLineToPoint(c, 15.5f, 12);
		CGContextAddLineToPoint(c, 9, 18.5f);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"heartO"]) {    // an unsaved heart: the outline
		CGContextSetLineWidth(c, 1.8f);
		ENHeartPath(c);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"computer"]) {  // Settings: Home Address
		CGContextSetLineWidth(c, 1.8f);
		CGContextAddRect(c, CGRectMake(3.5f, 4.5f, 17, 11.5f));
		CGContextMoveToPoint(c, 9, 20.5f);
		CGContextAddLineToPoint(c, 15, 20.5f);
		CGContextMoveToPoint(c, 12, 16);
		CGContextAddLineToPoint(c, 12, 20.5f);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"wifi"]) {      // Settings: Away Address
		ENWifiPath(c);
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"moon"]) {      // Settings: Theme (a crescent)
		CGContextMoveToPoint(c, 14.5f, 2.8f);
		ENArcTo(c, 14.5f, 2.8f, 21.2f, 16.4f, 8.8f, YES, NO);
		ENArcTo(c, 21.2f, 16.4f, 14.5f, 2.8f, 7.4f, NO, YES);
		CGContextClosePath(c);
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"folder"]) {    // Playlists folders
		ENFolderPath(c);
		CGContextFillPath(c);
	} else if ([name isEqualToString:@"addlistPlus"]) {     // Now Playing's ⊕, Add to
		CGContextSetLineWidth(c, 2.1f);
		CGContextMoveToPoint(c, 3, 6);
		CGContextAddLineToPoint(c, 14, 6);
		CGContextMoveToPoint(c, 3, 11);
		CGContextAddLineToPoint(c, 14, 11);
		CGContextMoveToPoint(c, 3, 16);
		CGContextAddLineToPoint(c, 10, 16);
		CGContextMoveToPoint(c, 18, 10);
		CGContextAddLineToPoint(c, 18, 20);
		CGContextMoveToPoint(c, 13, 15);
		CGContextAddLineToPoint(c, 23, 15);
		CGContextStrokePath(c);
	} else if ([name isEqualToString:@"phone"]) {     // Now Playing's device page
		CGContextSetLineWidth(c, 1.8f);
		ENRoundRectPath(c, CGRectMake(6.5f, 2.5f, 11, 19), 1.5f);
		CGContextMoveToPoint(c, 11, 18.5f);
		CGContextAddLineToPoint(c, 13, 18.5f);
		CGContextStrokePath(c);
	}
}

#pragma mark - tab icons

static void ENDrawTabIcon(CGContextRef c, NSUInteger i) {     // the mockup's tab glyphs, black on clear, 24-box
	[[UIColor blackColor] set];
	switch (i) {
		case 0:      // Home (0.7): a house
			CGContextMoveToPoint(c, 12, 2.8f);
			CGContextAddLineToPoint(c, 22, 11.6f);
			CGContextAddLineToPoint(c, 19.4f, 11.6f);
			CGContextAddLineToPoint(c, 19.4f, 21);
			CGContextAddLineToPoint(c, 14.4f, 21);
			CGContextAddLineToPoint(c, 14.4f, 15);
			CGContextAddLineToPoint(c, 9.6f, 15);
			CGContextAddLineToPoint(c, 9.6f, 21);
			CGContextAddLineToPoint(c, 4.6f, 21);
			CGContextAddLineToPoint(c, 4.6f, 11.6f);
			CGContextAddLineToPoint(c, 2, 11.6f);
			CGContextClosePath(c);
			CGContextFillPath(c);
			break;
		case 1:      // Search
			CGContextSetLineWidth(c, 2.6f);
			CGContextSetLineCap(c, kCGLineCapRound);
			CGContextStrokeEllipseInRect(c, CGRectMake(4, 4, 13, 13));
			CGContextMoveToPoint(c, 15.4f, 15.4f);
			CGContextAddLineToPoint(c, 21, 21);
			CGContextStrokePath(c);
			break;
		case 2:      // Playlists: three lines and a note
			CGContextAddRect(c, CGRectMake(2.5f, 5, 13, 2.4f));
			CGContextAddRect(c, CGRectMake(2.5f, 9.6f, 13, 2.4f));
			CGContextAddRect(c, CGRectMake(2.5f, 14.2f, 8.5f, 2.4f));
			CGContextAddRect(c, CGRectMake(17, 3.5f, 2.2f, 14));
			CGContextAddRect(c, CGRectMake(17, 3.5f, 4.8f, 3.7f));
			CGContextAddEllipseInRect(c, CGRectMake(13, 14.3f, 6.2f, 6.2f));
			CGContextFillPath(c);
			break;
		case 3:      // Library: two books and a leaning one
			CGContextAddRect(c, CGRectMake(3.5f, 3.5f, 2.8f, 17));
			CGContextAddRect(c, CGRectMake(8.7f, 3.5f, 2.8f, 17));
			CGContextMoveToPoint(c, 13.5f, 4.4f);
			CGContextAddLineToPoint(c, 16.2f, 3.7f);
			CGContextAddLineToPoint(c, 20.6f, 20.1f);
			CGContextAddLineToPoint(c, 17.9f, 20.8f);
			CGContextClosePath(c);
			CGContextFillPath(c);
			break;
		default:     // Settings: the gear
			ENGearPath(c);
			CGContextEOFillPath(c);
			break;
	}
}

// the black-on-clear 30 pt mask of tab i, at scale 2 (the PNG caches are @2x)
static UIImage *ENTabMask(NSUInteger i) {
	UIGraphicsBeginImageContextWithOptions(CGSizeMake(30, 30), NO, 2);
	CGContextRef c = UIGraphicsGetCurrentContext();
	CGContextScaleCTM(c, 30.0f / 24, 30.0f / 24);
	ENDrawTabIcon(c, i);
	UIImage *img = UIGraphicsGetImageFromCurrentImageContext();
	UIGraphicsEndImageContext();
	return img;
}

// the mask filled with a vertical gradient: kCGBlendModeDestinationIn keeps the gradient only where the mask is
static UIImage *ENTintedMask(UIImage *mask, NSArray *cols, const CGFloat *locs) {
	CGRect r = CGRectMake(0, 0, mask.size.width, mask.size.height);
	UIGraphicsBeginImageContextWithOptions(r.size, NO, 2);
	ENVGradient(UIGraphicsGetCurrentContext(), r, cols, locs);
	[mask drawInRect:r blendMode:kCGBlendModeDestinationIn alpha:1];
	UIImage *img = UIGraphicsGetImageFromCurrentImageContext();
	UIGraphicsEndImageContext();
	return img;
}

static UIImage *ENCachedPNG(NSString *name, UIImage *(^draw)(void)) {
	NSString *path = [ENCacheDir(@"ui") stringByAppendingPathComponent:[name stringByAppendingString:@"@2x.png"]];
	NSData *png = [NSData dataWithContentsOfFile:path];
	UIImage *img = png ? ENImageWithPNGData(png, 2) : nil;      // (1.1: iOS 5 has no imageWithData:scale:)
	if (img) return img;
	img = draw();
	NSData *out = img ? UIImagePNGRepresentation(img) : nil;
	if (out) dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_LOW, 0), ^{ [out writeToFile:path atomically:YES]; });
	return img;
}

#pragma mark - settings

static void ENLoadSettings(void) {
	if (sSettingsLoaded) return;
	sSettingsLoaded = YES;
	NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
#if EN_DARK_MODE
	NSString *a = [d stringForKey:ENAppearanceDefaultsKey];
	sAppearance = [a isEqualToString:@"dark"] ? ENAppearanceDark : [a isEqualToString:@"auto"] ? ENAppearanceAutomatic : ENAppearanceLight;
#endif
	// (EN_DARK_MODE 0: sAppearance stays Light; a stored encore.appearance is neither read nor removed)
	NSString *t = [d stringForKey:ENTextSizeDefaultsKey];
	sTextSize = [t isEqualToString:@"small"] ? ENTextSizeSmall : [t isEqualToString:@"large"] ? ENTextSizeLarge : ENTextSizeDefault;
	sExplicitBadges = [d objectForKey:ENExplicitBadgesDefaultsKey] ? [d boolForKey:ENExplicitBadgesDefaultsKey] : YES;
}

static NSUInteger ENSizeIndex(void) {
	ENLoadSettings();
	return sTextSize == ENTextSizeSmall ? 0 : sTextSize == ENTextSizeLarge ? 2 : 1;
}

static void ENBuildRowFonts(void) {
	static const CGFloat title[] = { 14.5f, 15.5f, 17 }, sub[] = { 11.5f, 12.5f, 13.5f }, num[] = { 13, 14, 15 }, badge[] = { 8.5f, 9, 10 };
	NSUInteger i = ENSizeIndex();
	sRowTitle = ENHN(YES, title[i]);
	sRowSub = ENHN(NO, sub[i]);
	sRowNumber = ENHN(YES, num[i]);
	sRowBadge = ENHN(YES, badge[i]);
}

static BOOL ENWantsDark(NSDate *now) {
#if EN_DARK_MODE
	ENLoadSettings();
	return sAppearance == ENAppearanceDark || (sAppearance == ENAppearanceAutomatic && [ENTheme isDarkAt:now]);
#else
	return NO;                       // dark mode is off (ENTheme.h EN_DARK_MODE): Light only
#endif
}

#pragma mark -

@interface ENTheme ()
- (instancetype)initWithPalette:(ENPalette)palette;
@end

@implementation ENTheme {
	ENPalette _palette;
	NSMutableDictionary *_images;      // this palette's content images by name
	NSMutableDictionary *_glyphs;      // glyphNamed:size:color:
	NSMutableDictionary *_thumbFrames; // thumbFrameImageOfSide:round:, by side and shape
	UIColor *_pattern;                 // groupedPattern
}

#pragma mark palettes

+ (ENTheme *)light {
	static ENTheme *t;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ t = [[ENTheme alloc] initWithPalette:ENPaletteLight]; });
	return t;
}

+ (ENTheme *)dark {
	static ENTheme *t;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ t = [[ENTheme alloc] initWithPalette:ENPaletteDark]; });
	return t;
}

+ (ENTheme *)queue {
	static ENTheme *t;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ t = [[ENTheme alloc] initWithPalette:ENPaletteQueue]; });
	return t;
}

+ (ENTheme *)current {
#if EN_DARK_MODE
	if (!sCurrent) sCurrent = ENWantsDark([NSDate date]) ? [self dark] : [self light];
	return sCurrent;
#else
	return [self light];             // EN_DARK_MODE 0: always Light, whatever is stored
#endif
}

- (instancetype)init {
	return [self initWithPalette:ENPaletteLight];
}

// Every value of DESIGN-5 §1.3-1.5. P picks Light | Dark | Queue (the queue falls back to Dark where §1.3 is silent).
- (instancetype)initWithPalette:(ENPalette)palette {
	if (!(self = [super init])) return nil;
	_palette = palette;
	BOOL dark = palette != ENPaletteLight, q = palette == ENPaletteQueue;
#define P(l, d, qq) (q ? (qq) : dark ? (d) : (l))
#define LD(l, d) (dark ? (d) : (l))
	_isDark = dark;
	_images = [NSMutableDictionary dictionary];
	_glyphs = [NSMutableDictionary dictionary];
	_thumbFrames = [NSMutableDictionary dictionary];
	UIColor *white = [UIColor whiteColor], *clear = [UIColor clearColor];

	// ---- content
	_listBackground = ENColor(P(0xedf2e9, 0x0f140e, 0x0b110a));
	_cellTitle = ENColor(P(0x000000, 0xeef4ea, 0xf1f1f1));
	_cellSub = ENColor(P(0x7c7c7c, 0x8b9885, 0x8d8d8d));
	_cellNumber = ENColor(LD(0x9a9a9a, 0x6b7a64));
	_cellDuration = ENColor(P(0x8a8a8a, 0x8b9885, 0x7d7d7d));
	_cellDimmed = ENColor(LD(0xb9b9b9, 0x46523f));
	_cellPlaying = ENColor(P(0x3fae3a, 0x93e063, 0x74d150));
	_cellSelectedTitle = white;
	_cellSelectedTitleShadow = ENGrey(0, 0.25f);
	_cellSelectedSub = ENColor(0xe8ffe0);
	_accent = ENColor(LD(0x3fae3a, 0x93e063));
	_accentStrong = ENColor(LD(0x2f9a2b, 0x93e063));
	_moreGlyph = ENColor(LD(0x3a8a28, 0x93e063));
	_chevron = ENColor(LD(0x7d8a76, 0x6b7a64));
	_badgeBackground = ENColor(LD(0x8f8f8f, 0x5b6a54));
	_badgeText = white;
	_headerText = q ? ENColor(0xdddddd) : white;
	_headerTextShadow = q ? ENGrey(0, 1) : ENGrey(0, 0.35f);
	_headerTextShadowOffset = q ? CGSizeMake(0, -1) : CGSizeMake(0, 1);
	_headerActionHighlighted = ENGrey(1, 0.5f);
	_footerText = ENColor(LD(0x8b8b8b, 0x6b7a64));
	_footerTextShadow = LD(white, clear);
	_emptyTitle = ENColor(LD(0x666666, 0xbac8b2));
	_emptyBody = ENColor(LD(0x8d8d8d, 0x7d8a77));
	_emptyTextShadow = LD(white, clear);
	_thumbBorder = LD(ENGrey(0, 0.18f), ENGrey(1, 0.08f));
	_thumbFill = ENColor(LD(0xdddddd, 0x222a1f));
	_thumbDrop = LD(ENGrey(0, 0.12f), clear);
	_heartSaved = ENColor(0x3fae3a);
	_heartOutline = LD(ENGrey(0.45f, 1), ENGrey(1, 0.55f));
	_pickerRing = ENColor(LD(0xa6b09f, 0x4b5a45));
	_noteStripText = ENColor(LD(0x4a6b3a, 0x9fd47a));
	_fieldText = ENColor(LD(0x000000, 0xeef4ea));
	_fieldPlaceholder = ENColor(LD(0xa5a5a5, 0x6b7a64));
	_filterButtonTint = ENColor(LD(0x8fa880, 0x3b4937));
	_refreshTint = ENColor(LD(0x4e7843, 0x93e063));
	_keyboardAppearance = LD(UIKeyboardAppearanceDefault, UIKeyboardAppearanceAlert);
	_spinnerStyle = LD(UIActivityIndicatorViewStyleGray, UIActivityIndicatorViewStyleWhite);
	_indicatorStyle = LD(UIScrollViewIndicatorStyleDefault, UIScrollViewIndicatorStyleWhite);
	_sourceTagText = ENColor(0x0e0e0e);       // (3b) Up Next's QUEUE / AUTOPLAY tags
	_sourceTagQueue = ENColor(0x74d150);
	_sourceTagAutoplay = ENColor(0x6aa8ff);

	_listHeaderTop = ENColor(LD(0xf5f8f2, 0x1e2a1a));
	_listHeaderBottom = ENColor(LD(0xe0e8da, 0x131a11));
	_listHeaderBorder = ENColor(LD(0xbccbb2, 0x080b07));
	_listHeaderTitle = ENColor(LD(0x111111, 0xf1f6ee));
	_listHeaderMeta = ENColor(LD(0x8a8a8a, 0x8b9885));
	_listHeaderDescBackground = ENColor(LD(0xe9eee5, 0x141b12));
	_listHeaderDescBorder = ENColor(LD(0xccd6c4, 0x080b07));
	_listHeaderDescText = ENColor(LD(0x66705f, 0x93a08c));
	_coverMat = LD(white, ENColor(0x2a3426));
	_coverMatShadow = ENGrey(0, LD(0.35f, 0.7f));
	_coverMatShadowBlur = LD(5, 6);
	_tileMatShadow = ENGrey(0, LD(0.3f, 0.7f));
	_tileMatShadowBlur = LD(4, 6);
	_silverText = ENColor(LD(0x333333, 0xe3ebdf));
	_silverTextShadow = LD(white, [UIColor blackColor]);
	_silverTextShadowOffset = LD(CGSizeMake(0, 1), CGSizeMake(0, -1));
	_silverOnText = ENColor(LD(0x2f9a2b, 0x93e063));

	_homeTitle = ENColor(LD(0x222222, 0xeef4ea));
	_homeTitleShadow = LD(white, clear);
	_shelfSub = ENColor(LD(0x888888, 0x7d8a77));
	_tileTitle = ENColor(LD(0x222222, 0xe3ebdf));
	_tileSub = ENColor(LD(0x8a8a8a, 0x7d8a77));
	_tileRing = LD(white, ENColor(0x2a3426));
	_homeSeparator = ENColor(LD(0xd8d8d8, 0x080b07));
	_homeSeparatorHighlight = LD(white, ENGrey(1, 0.04f));
	_placeholderTop = ENColor(LD(0xe3eadf, 0x263022));
	_placeholderBottom = ENColor(LD(0xc9d3c2, 0x1c2419));
	_placeholderGlyph = ENColor(LD(0xa3b19b, 0x4b5a45));
	_cardPlaceholderFill = ENColor(LD(0xc9d8bf, 0x263022));
	_cardPlaceholderGlyph = LD(ENGrey(1, 0.85f), ENColor(0x4b5a45));

	_groupedBackground = ENColor(LD(0xc2cfbb, 0x111710));
	_groupedCard = ENColor(LD(0xffffff, 0x1a2117));
	_groupedBorder = ENColor(LD(0xa7a9ac, 0x2c3728));
	_groupedSeparator = ENColor(LD(0xe0e0e0, 0x263022));
	_groupedLabel = ENColor(LD(0x000000, 0xeef4ea));
	_groupedSmall = ENColor(LD(0x7a7a7a, 0x86947f));
	_groupedValue = ENColor(LD(0x3a8a28, 0x93e063));
	_groupedHeader = ENColor(LD(0x45593a, 0xa7c096));
	_groupedHeaderShadow = LD(white, [UIColor blackColor]);
	_groupedHeaderShadowOffset = LD(CGSizeMake(0, 1), CGSizeMake(0, -1));
	_groupedFooter = ENColor(LD(0x45593a, 0x7f8c79));
	_groupedFooterShadow = LD(white, clear);
	_groupedNote = ENColor(LD(0x66705f, 0x86947f));
	_jamRed = ENColor(LD(0xc51a1a, 0xff7070));
	_jamPlayingFill = ENColor(LD(0xe9f5e1, 0x21361a));
	_jamMutedTitle = ENColor(LD(0x6b6b6b, 0x6b7a64));
	_jamMutedSub = ENColor(LD(0xa0a0a0, 0x46523f));
	_qrBorder = LD(ENGrey(0.82f, 1), ENColor(0x2c3728));

	// ---- chrome (the same in every palette)
	_navTint = ENColor(0x2c4224);
	_windowBackground = ENColor(0x0d1310);
	_navTitle = white;
	_navTitleShadow = ENGrey(0, 0.6f);
	_navTitleSub = ENColor(0xc9c9c9);
	_barButtonText = white;
	_barButtonTextShadow = ENGrey(0, 0.55f);
	_tabLabelOff = ENColor(0xa8bf9b);
	_tabLabelOn = white;
	_bannerBackground = ENColor(0xf6d35e);
	_bannerText = ENColor(0x3a2a00);
	_bannerTextShadow = ENGrey(1, 0.5f);
	_miniTitle = white;
	_miniTitleShadow = [UIColor blackColor];
	_miniSub = ENColor(0xb9d2aa);
	_miniPlayerFill = ENColor(0x162412);
	_progress = ENColor(0x8fdc5a);
	_knobGlyph = ENColor(0x2f7d1e);
	_jamBarFill = ENColor(0x3b9c25);
	_jamBarText = white;
	_jamBarTextShadow = ENGrey(0, 0.3f);
	_hudFill = ENGrey(0, 0.78f);
	_hudText = white;
	_hudTextShadow = [UIColor blackColor];
	_sheetTitleText = ENColor(0xd2d2d2);
	_sheetTitleBoldText = white;
	_sheetTitleShadow = [UIColor blackColor];
	_sheetButtonText = white;
	_sheetButtonTextShadow = ENGrey(0, 0.6f);
	_greenButtonText = white;
	_greenButtonTextShadow = ENGrey(0, 0.35f);
	_ghostButtonText = white;                 // (3c) the ghost button (mockup .ahdr .gbtn.silver.ghost)
	_ghostButtonTextShadow = [UIColor blackColor];
	_switchOnTint = ENColor(0x4fae2f);
	_heartOnChrome = ENGrey(0.8f, 1);
	_avatarText = white;
	_avatarTextShadow = ENGrey(0, 0.25f);
	_avatarRing = white;
	_profileButtonFill = ENColor(0x2c4a22);
	_profileButtonGlyph = ENColor(0xc8e6b4);
	_profileButtonRing = ENGrey(1, 0.9f);
	_jamHeroFill = ENColor(0x3d9a22);
	_jamHeroText = white;
	_jamHeroSub = ENColor(0xeaffdf);
	_jamHeroTextShadow = ENGrey(0, 0.3f);
	_jamHeroAvatarBacking = [UIColor colorWithRed:0.12f green:0.42f blue:0.10f alpha:1];
	_jamHeroAvatarShadow = ENGrey(0, 0.35f);
	_jamHeroMoreFill = ENGrey(0, 0.25f);
	_jamHeroWell = ENGrey(0, 0.18f);
	_jamHeroWellEdge = ENGrey(1, 0.3f);
	_jamHeroWellShadow = ENGrey(0, 0.25f);
	_artistHeaderTop = ENColor(0x3d6131);
	_artistHeaderBottom = ENColor(0x1b3015);
	_artistHeaderGlyph = ENColor(0x56804a);
	_artistShade = ENGrey(0, 0.75f);          // (3c: the mockup's .ahdr .shade; was .65)
	_artistNameShadow = ENGrey(0, 0.8f);
	_profileHeaderTop = ENColor(0x4f8a3a);
	_profileHeaderMid = ENColor(0x2a4a20);
	_profileHeaderBottom = ENColor(0x16260f);
	_profileAvatarShadow = ENGrey(0, 0.45f);
	_profileNameShadow = ENGrey(0, 0.4f);
	// Now Playing (3b, §1.3 "NP chrome")
	_npCountText = ENColor(0xbfe0aa);
	_npTimeText = ENColor(0xcfcfcf);
	_npToggleOff = ENColor(0x8a8a8a);
	_npToggleOn = ENColor(0x6fd14a);
	_npActionGlyph = ENColor(0xdddddd);
	_npActionText = ENColor(0xcfcfcf);
	_npActionDisabled = ENColor(0x5b6a54);
	_npDeviceText = ENColor(0xcfcfcf);
	_npDeviceSub = ENColor(0x8a8a8a);
	_npVolumeGlyph = ENColor(0x9a9a9a);
	_npBufferDim = ENGrey(0, 0.35f);
	// Setup (3c, §1.3 "Setup", mockup .setup)
	_setupTitle = white;
	_setupTitleShadow = [UIColor blackColor];
	_setupTagline = ENColor(0x9a9a9a);
	_setupLabel = ENColor(0xdddddd);
	_setupInput = white;
	_setupPlaceholder = ENColor(0x666666);
	_setupHint = ENColor(0x8a8a8a);
	_setupHintBold = ENColor(0xc8c8c8);
	_setupStatus = ENColor(0xcfcfcf);
	_setupDone = ENColor(0x8fd16a);
	_setupError = ENColor(0xff8a80);

	// ---- fonts (the row fonts follow the text size: their getters)
	_durationFont = ENHN(NO, q ? 12.5f : 13);     // (3b: Up Next's durations are 12.5)
	_headerFont = ENHN(YES, q ? 12 : 13);
	_footerFont = ENHN(NO, 13);
	_bigTitleFont = ENHN(YES, 19);
	_navTitleFont = ENHN(YES, 20);
	_navTitleSmallFont = ENHN(YES, 17);
	_barButtonFont = ENHN(YES, 12);
	_tabLabelFont = ENHN(YES, 10);
	_bannerFont = ENHN(YES, 12.5f);
	_hudFont = ENHN(YES, 15.5f);
	_jamBarFont = ENHN(YES, 11);
	_miniTitleFont = ENHN(YES, 15.5f);
	_miniSubFont = ENHN(YES, 12);
	_emptyTitleFont = ENHN(YES, 17);
	_emptyBodyFont = ENHN(NO, 14.5f);
	_linkFont = ENHN(YES, 15);
	_metaFont = ENHN(NO, 13);
	_descriptionFont = ENHN(NO, 13);
	_buttonFont = ENHN(YES, 14.5f);
	_wideButtonFont = ENHN(YES, 18);
	_smallButtonFont = ENHN(YES, 12.5f);
	_greetingFont = ENHN(YES, 21);
	_shelfTitleFont = ENHN(YES, 17);
	_shelfSubFont = ENHN(NO, 13);
	_tileTitleFont = ENHN(YES, 13);
	_tileSubFont = ENHN(NO, 11.5f);
	_artistNameFont = ENHN(YES, 27);
	_groupedLabelFont = ENHN(YES, 16.5f);
	_groupedSmallFont = ENHN(NO, 12.5f);
	_groupedValueFont = ENHN(NO, 16);
	_groupedHeaderFont = ENHN(YES, 17);
	_groupedFooterFont = ENHN(NO, 14);
	_actionRowFont = ENHN(YES, 15);
	_swipeStripFont = ENHN(YES, 14);
	_sourceTagFont = ENHN(YES, 9.5f);
	_noteStripFont = ENHN(YES, 12);
	_sheetButtonFont = ENHN(YES, 18.5f);
	_sheetTitleFont = ENHN(NO, 13.5f);
	_sheetTitleBoldFont = ENHN(YES, 13.5f);
	_npTitleFont = ENHN(YES, 17);
	_npArtistsFont = ENHN(YES, 12);
	_npCountFont = ENHN(YES, 13);
	_npTimeFont = ENHN(YES, 12.5f);
	_npActionFont = ENHN(YES, 10);
	_npDeviceFont = ENHN(YES, 12.5f);
	_npDeviceSubFont = ENHN(NO, 11.5f);
	_jamPillFont = ENHN(YES, 12);
	_setupTitleFont = ENHN(YES, 27);
	_setupTaglineFont = ENHN(NO, 14);
	_setupLabelFont = ENHN(YES, 15);          // (3c) the Setup rows, hint and status
	_setupInputFont = ENHN(NO, 16);
	_setupCodeFont = ENHN(YES, 22);
	_setupHintFont = ENHN(NO, 12.5f);
	_setupHintBoldFont = ENHN(YES, 12.5f);
	_setupStatusFont = ENHN(YES, 14);
#undef P
#undef LD
	return self;
}

- (UIImage *)cached:(NSString *)key make:(UIImage *(^)(void))make {
	UIImage *img = _images[key];
	if (img) return img;
	img = make();
	if (img) _images[key] = img;
	return img;
}

- (void)purge {
	[_images removeAllObjects];
	[_glyphs removeAllObjects];
	[_thumbFrames removeAllObjects];
	_pattern = nil;
}

+ (UIImage *)imageOfSize:(CGSize)size opaque:(BOOL)opaque drawing:(void (^)(CGContextRef c, CGSize size))draw {
	UIGraphicsBeginImageContextWithOptions(size, opaque, 0);
	if (draw) draw(UIGraphicsGetCurrentContext(), size);
	UIImage *img = UIGraphicsGetImageFromCurrentImageContext();
	UIGraphicsEndImageContext();
	return img;
}

+ (UIFont *)fontOfSize:(CGFloat)pt bold:(BOOL)bold {
	return ENHN(bold, pt);
}

#pragma mark setting, clock, notification

+ (ENAppearance)appearance {
	ENLoadSettings();
	return sAppearance;
}

+ (BOOL)isDarkAt:(NSDate *)date {
	NSInteger hour = [[[NSCalendar currentCalendar] components:NSHourCalendarUnit fromDate:(date ?: [NSDate date])] hour];
	return hour >= 19 || hour < 7;
}

+ (void)setAppearance:(ENAppearance)a {
#if EN_DARK_MODE
	ENLoadSettings();
	if (a != ENAppearanceDark && a != ENAppearanceAutomatic) a = ENAppearanceLight;
	NSString *v = a == ENAppearanceDark ? @"dark" : a == ENAppearanceAutomatic ? @"auto" : @"light";
	NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
	[d setObject:v forKey:ENAppearanceDefaultsKey];
	[d synchronize];
	sAppearance = a;
	ENLog(@"theme: appearance %@", v);
	[self reevaluate];
	[self armClock];
#endif
	// (EN_DARK_MODE 0: a no-op; nothing is stored, nothing is posted, no clock)
}

// the effective palette for now; posts only when it flips
+ (void)reevaluate {
	ENTheme *want = ENWantsDark([NSDate date]) ? [self dark] : [self light];
	if (want == sCurrent) return;
	sCurrent = want;
	ENLog(@"theme: now %@", want.isDark ? @"dark" : @"light");
	[[NSNotificationCenter defaultCenter] postNotificationName:ENThemeDidChangeNotification object:want];
}

// Automatic only, and only while active: one timer for the next 07:00 or 19:00 plus 1 s (common modes, so it also fires
// during a scroll). A clock or time-zone change re-arms it (UIApplicationSignificantTimeChangeNotification).
+ (void)armClock {
	[sClock invalidate];
	sClock = nil;
	if (!EN_DARK_MODE) return;       // (Light only: never a timer; +start does not observe the clock either)
	if (sAppearance != ENAppearanceAutomatic || [UIApplication sharedApplication].applicationState != UIApplicationStateActive) return;
	NSDateComponents *k = [[NSCalendar currentCalendar] components:(NSHourCalendarUnit | NSMinuteCalendarUnit | NSSecondCalendarUnit)
	                                                       fromDate:[NSDate date]];
	NSInteger s = [k hour] * 3600 + [k minute] * 60 + [k second];
	NSInteger next = s < 7 * 3600 ? 7 * 3600 : s < 19 * 3600 ? 19 * 3600 : 31 * 3600;      // 31 h = 07:00 tomorrow
	sClock = [NSTimer timerWithTimeInterval:(NSTimeInterval)(next - s + 1) target:self selector:@selector(clockFired:) userInfo:nil repeats:NO];
	[[NSRunLoop mainRunLoop] addTimer:sClock forMode:NSRunLoopCommonModes];
}

+ (void)clockFired:(NSTimer *)timer {
	if (timer == sClock) sClock = nil;
	[self reevaluate];
	[self armClock];
}

+ (void)appBecameActive:(NSNotification *)n {
	[self reevaluate];
	[self armClock];
}

+ (void)appWillResignActive:(NSNotification *)n {
	[sClock invalidate];
	sClock = nil;
}

+ (void)timeChanged:(NSNotification *)n {
	if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) return;     // becoming active re-checks
	[self reevaluate];
	[self armClock];
}

// P7: the palette that is neither shown nor Up Next's drops its images (rebuilt lazily when it is next used)
+ (void)memoryWarning:(NSNotification *)n {
#if EN_DARK_MODE
	ENTheme *cur = [self current];
	if ([self light] != cur) [[self light] purge];
	if ([self dark] != cur) [[self dark] purge];
#endif
	// (EN_DARK_MODE 0: +light is always +current and +dark is never made, so no palette purges; +dark is not created here)
	[sAlertImages removeAllObjects];
}

+ (void)start {
	static BOOL started;
	if (started) return;
	started = YES;
	ENLoadSettings();
#if EN_DARK_MODE
	sCurrent = ENWantsDark([NSDate date]) ? [self dark] : [self light];
	ENLog(@"theme: start (%@, %@, text size %ld)", sAppearance == ENAppearanceDark ? @"dark" : sAppearance == ENAppearanceAutomatic ? @"auto" : @"light",
	      sCurrent.isDark ? @"dark now" : @"light now", (long)sTextSize);
#else
	sCurrent = [self light];
	ENLog(@"theme: start (light only: dark mode off, text size %ld)", (long)sTextSize);
#endif
	[self applyChrome];
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
#if EN_DARK_MODE
	// the Automatic clock (§1.1); with dark mode off nothing can flip, so none of these is observed
	[nc addObserver:self selector:@selector(appBecameActive:) name:UIApplicationDidBecomeActiveNotification object:nil];
	[nc addObserver:self selector:@selector(appWillResignActive:) name:UIApplicationWillResignActiveNotification object:nil];
	[nc addObserver:self selector:@selector(timeChanged:) name:UIApplicationSignificantTimeChangeNotification object:nil];
#endif
	[nc addObserver:self selector:@selector(memoryWarning:) name:UIApplicationDidReceiveMemoryWarningNotification object:nil];
	[self armClock];      // (at launch the app is not active yet: DidBecomeActive arms it; EN_DARK_MODE 0: never arms)
}

#pragma mark text size

+ (ENTextSize)textSize {
	ENLoadSettings();
	return sTextSize;
}

+ (void)setTextSize:(ENTextSize)size {
	ENLoadSettings();
	if (size != ENTextSizeSmall && size != ENTextSizeLarge) size = ENTextSizeDefault;
	if (size == sTextSize) return;
	sTextSize = size;
	ENBuildRowFonts();
	NSString *v = size == ENTextSizeSmall ? @"small" : size == ENTextSizeLarge ? @"large" : @"default";
	NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
	[d setObject:v forKey:ENTextSizeDefaultsKey];
	[d synchronize];
	ENLog(@"theme: text size %@", v);
	[[NSNotificationCenter defaultCenter] postNotificationName:ENThemeDidChangeNotification object:[self current]];
}

#pragma mark explicit badges (3b)

+ (BOOL)showsExplicitBadges {
	ENLoadSettings();
	return sExplicitBadges;
}

+ (void)setShowsExplicitBadges:(BOOL)shows {
	ENLoadSettings();
	shows = shows ? YES : NO;
	if (shows == sExplicitBadges) return;
	sExplicitBadges = shows;
	NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
	[d setBool:shows forKey:ENExplicitBadgesDefaultsKey];
	[d synchronize];
	ENLog(@"theme: explicit badges %@", shows ? @"on" : @"off");
	[[NSNotificationCenter defaultCenter] postNotificationName:ENThemeDidChangeNotification object:[self current]];
}

- (UIFont *)titleFont { if (!sRowTitle) ENBuildRowFonts(); return sRowTitle; }
- (UIFont *)subFont { if (!sRowSub) ENBuildRowFonts(); return sRowSub; }
- (UIFont *)numberFont { if (!sRowNumber) ENBuildRowFonts(); return sRowNumber; }
- (UIFont *)badgeFont { if (!sRowBadge) ENBuildRowFonts(); return sRowBadge; }

- (CGFloat)rowHeight {
	static const CGFloat h[] = { 44, 48, 54 };
	return h[ENSizeIndex()];
}

- (CGFloat)tallRowHeight {
	return 60;
}

- (CGFloat)numberColumnWidth {
	static const CGFloat w[] = { 24, 26, 28 };
	return w[ENSizeIndex()];
}

// (1.1) the per-style bar button background setter (iOS 6)
static BOOL ENBarItemStyleAppearance(void) {
	return [UIBarButtonItem instancesRespondToSelector:@selector(setBackgroundImage:forState:style:barMetrics:)];
}

#pragma mark - C1: the chrome appearance

+ (void)applyChrome {
	static BOOL applied;
	if (applied) return;
	applied = YES;
	ENTheme *th = [self current];
	NSValue *up = [NSValue valueWithUIOffset:UIOffsetMake(0, -1)];

	UINavigationBar *nav = [UINavigationBar appearance];
	[nav setBackgroundImage:th.navBarBackground forBarMetrics:UIBarMetricsDefault];
	nav.tintColor = th.navTint;
	nav.titleTextAttributes = @{ UITextAttributeTextColor: th.navTitle, UITextAttributeTextShadowColor: th.navTitleShadow,
	                             UITextAttributeTextShadowOffset: up, UITextAttributeFont: th.navTitleFont };

	// bar buttons everywhere, and (the iOS 5/6 way) the search bars' Cancel buttons
	NSDictionary *text = @{ UITextAttributeTextColor: th.barButtonText, UITextAttributeTextShadowColor: th.barButtonTextShadow,
	                        UITextAttributeTextShadowOffset: up, UITextAttributeFont: th.barButtonFont };
	NSDictionary *off = @{ UITextAttributeTextColor: ENGrey(1, 0.45f), UITextAttributeTextShadowColor: th.barButtonTextShadow,
	                       UITextAttributeTextShadowOffset: up, UITextAttributeFont: th.barButtonFont };
	for (UIBarButtonItem *item in @[ [UIBarButtonItem appearance], [UIBarButtonItem appearanceWhenContainedIn:[UISearchBar class], nil] ]) {
		[item setBackgroundImage:[th barButtonImageDone:NO pressed:NO] forState:UIControlStateNormal barMetrics:UIBarMetricsDefault];
		[item setBackgroundImage:[th barButtonImageDone:NO pressed:YES] forState:UIControlStateHighlighted barMetrics:UIBarMetricsDefault];
		if (ENBarItemStyleAppearance()) {        // (1.1) iOS 6 only: an iOS 5 proxy throws on it (iOS 5: +skinBarItem:)
			[item setBackgroundImage:[th barButtonImageDone:YES pressed:NO] forState:UIControlStateNormal style:UIBarButtonItemStyleDone
			              barMetrics:UIBarMetricsDefault];
			[item setBackgroundImage:[th barButtonImageDone:YES pressed:YES] forState:UIControlStateHighlighted style:UIBarButtonItemStyleDone
			              barMetrics:UIBarMetricsDefault];
		}
		[item setBackButtonBackgroundImage:[th backButtonImagePressed:NO] forState:UIControlStateNormal barMetrics:UIBarMetricsDefault];
		[item setBackButtonBackgroundImage:[th backButtonImagePressed:YES] forState:UIControlStateHighlighted barMetrics:UIBarMetricsDefault];
		[item setTitleTextAttributes:text forState:UIControlStateNormal];
		[item setTitleTextAttributes:text forState:UIControlStateHighlighted];
		[item setTitleTextAttributes:off forState:UIControlStateDisabled];
	}

	UISwitch *sw = [UISwitch appearance];
	sw.onTintColor = th.switchOnTint;

	// tab labels: iOS 5/6 take the selected item's from Highlighted (Selected is set too, harmlessly)
	NSDictionary *tabOff = @{ UITextAttributeTextColor: th.tabLabelOff, UITextAttributeTextShadowColor: [UIColor clearColor],
	                          UITextAttributeFont: th.tabLabelFont };
	NSDictionary *tabOn = @{ UITextAttributeTextColor: th.tabLabelOn, UITextAttributeTextShadowColor: [UIColor clearColor],
	                         UITextAttributeFont: th.tabLabelFont };
	UITabBarItem *tab = [UITabBarItem appearance];
	[tab setTitleTextAttributes:tabOff forState:UIControlStateNormal];
	[tab setTitleTextAttributes:tabOn forState:UIControlStateHighlighted];
	[tab setTitleTextAttributes:tabOn forState:UIControlStateSelected];
}

+ (void)skinBarItem:(UIBarButtonItem *)item {
	[self skinBarItem:item done:item.style == UIBarButtonItemStyleDone];
}

+ (void)skinBarItem:(UIBarButtonItem *)item done:(BOOL)done {
	if (!item || ENBarItemStyleAppearance()) return;
	ENTheme *th = [self current];
	[item setBackgroundImage:[th barButtonImageDone:done pressed:NO] forState:UIControlStateNormal barMetrics:UIBarMetricsDefault];
	[item setBackgroundImage:[th barButtonImageDone:done pressed:YES] forState:UIControlStateHighlighted barMetrics:UIBarMetricsDefault];
}

#pragma mark instance helpers

static UITextField *ENFindTextField(UIView *v, NSUInteger depth) {
	if (depth > 3) return nil;
	for (UIView *s in v.subviews) {
		if ([s isKindOfClass:[UITextField class]]) return (UITextField *)s;
		UITextField *f = ENFindTextField(s, depth + 1);
		if (f) return f;
	}
	return nil;
}

- (void)styleSearchBar:(UISearchBar *)bar nav:(BOOL)inNavBar {
	if (!bar) return;
	[bar setSearchFieldBackgroundImage:[self searchFieldImage:inNavBar] forState:UIControlStateNormal];
	if (!inNavBar) bar.backgroundImage = self.filterBarBackground;
	UITextField *f = ENFindTextField(bar, 0);   // (iOS 6.1 UISearchBar has no keyboardAppearance: set on its field below)
	if (!f) return;           // an unexpected 6.1 hierarchy: the field keeps its stock text and placeholder
	f.textColor = self.fieldText;
	f.keyboardAppearance = self.keyboardAppearance;
	NSString *ph = bar.placeholder.length ? bar.placeholder : f.placeholder;
	if (ph.length && [f respondsToSelector:@selector(setAttributedPlaceholder:)]) {
		NSMutableDictionary *attrs = [NSMutableDictionary dictionaryWithObject:self.fieldPlaceholder forKey:NSForegroundColorAttributeName];
		if (f.font) attrs[NSFontAttributeName] = f.font;
		f.attributedPlaceholder = [[NSAttributedString alloc] initWithString:ph attributes:attrs];
	} else if (ph.length) {
		ENTintFieldPlaceholder(f, self.fieldPlaceholder);      // (1.1) iOS 5: the colour alone, where it can be set
	}
}

static const NSInteger ENTitleViewTag = 0x454e54;      // "ENT": a titleView -applyTitle: made
static const NSInteger ENBackItemTag = 0x454e42;       // "ENB": its "Back" item

- (void)applyTitle:(NSString *)title toItem:(UINavigationItem *)item small:(BOOL)small {
	if (!item) return;
	item.title = title;
	UIView *tv = item.titleView;
	BOOL ours = tv && tv.tag == ENTitleViewTag && [tv isKindOfClass:[UILabel class]];
	BOOL shrink = title.length && (small || [title sizeWithFont:self.navTitleFont].width > 172);
	if (shrink && (ours || !tv)) {
		UILabel *l = ours ? (UILabel *)tv : [[UILabel alloc] initWithFrame:CGRectMake(0, 0, 196, 44)];
		l.tag = ENTitleViewTag;
		l.backgroundColor = [UIColor clearColor];
		l.opaque = NO;
		l.font = self.navTitleSmallFont;
		l.textColor = self.navTitle;
		l.shadowColor = self.navTitleShadow;
		l.shadowOffset = CGSizeMake(0, -1);
		l.textAlignment = NSTextAlignmentCenter;
		l.lineBreakMode = NSLineBreakByTruncatingTail;
		l.text = title;
		l.frame = CGRectMake(0, 0, MIN(ceilf([title sizeWithFont:l.font].width), 196), 44);
		item.titleView = l;
	} else if (!shrink && ours) {
		item.titleView = nil;
	}
	UIBarButtonItem *back = item.backBarButtonItem;
	if (title.length > 13) {
		if (!back) {
			back = [[UIBarButtonItem alloc] initWithTitle:ENL(@"Back") style:UIBarButtonItemStyleBordered target:nil action:NULL];
			back.tag = ENBackItemTag;
			item.backBarButtonItem = back;
		}
	} else if (back.tag == ENBackItemTag) {
		item.backBarButtonItem = nil;
	}
}

+ (UIBarButtonItem *)barButtonWithGlyph:(NSString *)glyph target:(id)target action:(SEL)action {
	UIImage *img = [[ENTheme current] glyphNamed:glyph size:20 color:[UIColor whiteColor]];
	return [[UIBarButtonItem alloc] initWithImage:img style:UIBarButtonItemStyleBordered target:target action:action];
}

#pragma mark - content images (per palette)

// (1.1) the row bands' height and cache key: 48 under "cell…" on iOS 6, which stretches the gradient to the row; iOS 5 tiles
// a resizable centre, so there the band is drawn at the height it fills and keyed by it: the row height (Text size: 44 / 48 /
// 54) for the properties, the row's own for -cell…OfHeight: (Search's 60 pt Top Result)
- (CGFloat)bandHeight:(CGFloat)h {
	if (ENSystemIs6()) return 48;
	return h >= 4 ? ceilf(h) : self.rowHeight;      // (a band at least as tall as the rect: its centre never repeats)
}

- (NSString *)bandKey:(NSString *)key height:(CGFloat)h {
	return ENSystemIs6() ? key : [NSString stringWithFormat:@"%@%d", key, (int)h];
}

- (UIImage *)cellBackground { return [self cellBackgroundOfHeight:self.rowHeight]; }
- (UIImage *)cellSelectedBackground { return [self cellSelectedBackgroundOfHeight:self.rowHeight]; }
- (UIImage *)cellPlayingBackground { return [self cellPlayingBackgroundOfHeight:self.rowHeight]; }

- (UIImage *)cellBackgroundOfHeight:(CGFloat)rh {
	ENPalette p = _palette;
	CGFloat h = [self bandHeight:rh];
	return [self cached:[self bandKey:@"cell" height:h] make:^UIImage *{
		if (p == ENPaletteQueue) return ENBand(h, 0x141c12, 0x0e140d, 0x1b2618, 0x000000);
		if (p == ENPaletteDark) return ENBand(h, 0x1c2419, 0x151c13, 0x263022, 0x090c08);
		return ENBand(h, 0xf9fbf7, 0xedf2e9, 0xffffff, 0xd0dbc8);
	}];
}

- (UIImage *)cellSelectedBackgroundOfHeight:(CGFloat)rh {
	BOOL q = _palette == ENPaletteQueue;
	CGFloat h = [self bandHeight:rh];
	return [self cached:[self bandKey:@"cellSel" height:h] make:^UIImage *{
		if (q) return ENBand(h, 0x55b337, 0x3a8e22, 0x6cc24e, 0x000000);
		return ENBand(h, 0x6fc94f, 0x3e9f2a, 0x84d667, 0x2f7d1e);
	}];
}

- (UIImage *)cellPlayingBackgroundOfHeight:(CGFloat)rh {
	BOOL dark = _isDark;
	CGFloat h = [self bandHeight:rh];
	return [self cached:[self bandKey:@"cellPlaying" height:h] make:^UIImage *{
		if (dark) return ENBand(h, 0x21361a, 0x182a13, 0x2a4222, 0x090c08);
		return ENBand(h, 0xeef8e6, 0xdcefcf, 0xf7fcf3, 0xc3d8b5);
	}];
}

- (UIImage *)sectionHeaderBackground {
	ENPalette p = _palette;
	return [self cached:@"header" make:^UIImage *{
		if (p == ENPaletteQueue) return ENBand(22, 0x35502b, 0x1f3119, 0x4d6d3f, 0x000000);
		if (p == ENPaletteDark) return ENBand(22, 0x3f7d2b, 0x2a5b1d, 0x529a3b, 0x173a10);
		return ENBand(22, 0x7fbf5c, 0x579a3a, 0x9ad27d, 0x3f7a29);
	}];
}

- (UIImage *)sectionHeaderStrongBackground {
	BOOL dark = _isDark;
	return [self cached:@"headerStrong" make:^UIImage *{
		if (dark) return ENBand(22, 0x55a93a, 0x367c24, 0x529a3b, 0x173a10);
		return ENBand(22, 0x7cc95c, 0x4ea436, 0x96d77c, 0x3e8a28);
	}];
}

- (UIImage *)filterBarBackground {
	BOOL dark = _isDark;
	return [self cached:@"filterBar" make:^UIImage *{
		return ENStrip(44, 0, 1, ^(CGContextRef c, CGSize s) {
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), dark ? @[ ENColor(0x1b2418), ENColor(0x131a11) ]
			                                                          : @[ ENColor(0xcbd9c1), ENColor(0xb0c5a3) ], NULL);
			ENFill(c, CGRectMake(0, s.height - 1, s.width, 1), ENColor(dark ? 0x080b07 : 0x91a984));
		});
	}];
}

- (UIImage *)noteStripImage {
	BOOL dark = _isDark;
	return [self cached:@"noteStrip" make:^UIImage *{
		return ENStrip(36, 0, 1, ^(CGContextRef c, CGSize s) {
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), dark ? @[ ENColor(0x1f2f18), ENColor(0x182613) ]
			                                                          : @[ ENColor(0xe7f4dc), ENColor(0xd6eac6) ], NULL);
			ENFill(c, CGRectMake(0, s.height - 1, s.width, 1), ENColor(dark ? 0x080b07 : 0xb6d0a0));
		});
	}];
}

// a square tile: the placeholder gradient with a glyph at half the side
- (UIImage *)tileOfSide:(CGFloat)side round:(BOOL)round glyph:(NSString *)glyph {
	UIColor *top = self.placeholderTop, *bottom = self.placeholderBottom, *ink = self.placeholderGlyph;
	return [ENTheme imageOfSize:CGSizeMake(side, side) opaque:!round drawing:^(CGContextRef c, CGSize s) {
		CGRect r = CGRectMake(0, 0, s.width, s.height);
		if (round) {
			CGContextAddEllipseInRect(c, r);
			CGContextClip(c);
		}
		ENVGradient(c, r, @[ top, bottom ], NULL);
		CGFloat g = s.width * 0.5f;
		CGContextTranslateCTM(c, (s.width - g) / 2, (s.height - g) / 2);
		CGContextScaleCTM(c, g / 24, g / 24);
		[ink set];
		ENDrawGlyph(c, glyph);
	}];
}

- (UIImage *)placeholderCover {
	return [self cached:@"phCover" make:^UIImage *{ return [self tileOfSide:42 round:NO glyph:@"note"]; }];
}

- (UIImage *)placeholderArtist {
	return [self cached:@"phArtist" make:^UIImage *{ return [self tileOfSide:42 round:YES glyph:@"artist"]; }];
}

- (UIImage *)placeholderLarge {
	return [self cached:@"phLarge" make:^UIImage *{ return [self tileOfSide:108 round:NO glyph:@"note"]; }];
}

// ••• (31 pt disc): Light a white -> #e4e4e4 disc, #bdbdbd ring, a soft drop; Dark #3b4937 -> #252e22, #0a0d09 ring, a faint
// light line under it; the dots in moreGlyph
- (UIImage *)moreDiscPressed:(BOOL)pressed {
	BOOL dark = _isDark;
	unsigned top = dark ? (pressed ? 0x253022 : 0x3b4937) : (pressed ? 0xd8d8d8 : 0xffffff);
	unsigned bottom = dark ? (pressed ? 0x3b4937 : 0x252e22) : (pressed ? 0xf2f2f2 : 0xe4e4e4);
	UIColor *ring = ENColor(dark ? 0x0a0d09 : 0xbdbdbd), *dots = self.moreGlyph;
	return [ENTheme imageOfSize:CGSizeMake(31, 32) opaque:NO drawing:^(CGContextRef c, CGSize s) {
		CGRect r = CGRectMake(0.5f, 0.5f, 30, 30);
		CGContextSaveGState(c);
		if (dark) {
			[ENGrey(1, 0.06f) setFill];
			CGContextFillEllipseInRect(c, CGRectOffset(r, 0, 1));
		} else {
			CGContextSetShadowWithColor(c, CGSizeMake(0, 1), 1, ENGrey(0, 0.12f).CGColor);
			[ring setFill];
			CGContextFillEllipseInRect(c, r);
		}
		CGContextRestoreGState(c);
		CGContextSaveGState(c);
		CGContextAddEllipseInRect(c, r);
		CGContextClip(c);
		ENVGradient(c, r, @[ ENColor(top), ENColor(bottom) ], NULL);
		CGContextRestoreGState(c);
		[ring setStroke];
		CGContextSetLineWidth(c, 1);
		CGContextStrokeEllipseInRect(c, r);
		[dots setFill];
		for (int i = -1; i <= 1; i++) CGContextFillEllipseInRect(c, CGRectMake(15.5f + i * 5.5f - 1.8f, 15.5f - 1.8f, 3.6f, 3.6f));
	}];
}

- (UIImage *)moreGlyphImage {
	return [self cached:@"more" make:^UIImage *{ return [self moreDiscPressed:NO]; }];
}

- (UIImage *)moreGlyphPressedImage {
	return [self cached:@"more1" make:^UIImage *{ return [self moreDiscPressed:YES]; }];
}

// (the getters a row's drawRect calls look up a constant key: no string building per draw, P4)
- (UIImage *)speakerGlyph {
	return [self cached:@"speaker" make:^UIImage *{ return [self glyphNamed:@"speakerHi" size:16 color:self.cellPlaying]; }];
}

- (UIImage *)playingGlyph {
	static const CGFloat pt[] = { 13, 14, 15.5f };
	static NSString *const keys[] = { @"playing0", @"playing1", @"playing2" };
	NSUInteger i = ENSizeIndex();
	return [self cached:keys[i] make:^UIImage *{ return [self glyphNamed:@"speakerHi" size:pt[i] color:self.cellPlaying]; }];
}

- (UIImage *)chevronImage {
	BOOL dark = _isDark;
	UIColor *chevron = self.chevron;
	return [self cached:@"chevron" make:^UIImage *{
		UIColor *col = dark ? chevron : [chevron colorWithAlphaComponent:0.8f];
		return [ENTheme imageOfSize:CGSizeMake(9, 14) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			[col setStroke];
			CGContextSetLineWidth(c, 2.2f);
			CGContextSetLineCap(c, kCGLineCapRound);
			CGContextSetLineJoin(c, kCGLineJoinRound);
			CGContextMoveToPoint(c, 1.6f, 1.6f);
			CGContextAddLineToPoint(c, 7, 7);
			CGContextAddLineToPoint(c, 1.6f, 12.4f);
			CGContextStrokePath(c);
		}];
	}];
}

- (UIImage *)closeGlyphImage {
	return [self cached:@"close" make:^UIImage *{ return [self glyphNamed:@"close" size:22 color:self.chevron]; }];
}

// (3c) Home's gradient (mockup .home-bg: linear-gradient(top, mid 300px, bottom)): 1 x 568, the top 300 pt a fixed cap
- (UIImage *)homeBackground {
	BOOL dark = _isDark;
	return [self cached:@"homeBG" make:^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(1, 568) opaque:YES drawing:^(CGContextRef c, CGSize s) {
			UIColor *top = ENColor(dark ? 0x18221a : 0xf3f8ef), *mid = ENColor(dark ? 0x10160f : 0xe4eedd), *end = ENColor(dark ? 0x0f140e : 0xedf3e9);
			ENVGradient(c, CGRectMake(0, 0, s.width, 300), @[ top, mid ], NULL);
			ENVGradient(c, CGRectMake(0, 300, s.width, s.height - 300), @[ mid, end ], NULL);
		}];
		return ENStretch(img, UIEdgeInsetsMake(300, 0, 0, 0));
	}];
}

- (UIImage *)groupedChevronImage {
	BOOL dark = _isDark;
	return [self cached:@"groupedChevron" make:^UIImage *{
		return [self glyphNamed:@"chevRight" size:13 color:ENColor(dark ? 0x6b7a64 : 0x8b8b8b)];
	}];
}

- (UIImage *)groupedCheckImage {
	return [self cached:@"groupedCheck" make:^UIImage *{ return [self glyphNamed:@"check" size:16 color:self.groupedValue]; }];
}

// the grouped cell selection (mockup .g-cell:active): #6fc94f -> #3e9f2a, rounded 10 at this position's corners
- (UIImage *)groupedSelectionImage:(ENGroupedPosition)position {
	UIRectCorner corners = position == ENGroupedTop ? (UIRectCornerTopLeft | UIRectCornerTopRight)
	                     : position == ENGroupedBottom ? (UIRectCornerBottomLeft | UIRectCornerBottomRight)
	                     : position == ENGroupedSingle ? UIRectCornerAllCorners : 0;
	return ENShared([NSString stringWithFormat:@"groupedSel%lu", (unsigned long)corners], ^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(23, 44) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			CGRect r = CGRectMake(0, 0, s.width, s.height);
			UIBezierPath *p = corners ? [UIBezierPath bezierPathWithRoundedRect:r byRoundingCorners:corners cornerRadii:CGSizeMake(10, 10)]
			                          : [UIBezierPath bezierPathWithRect:r];
			[p addClip];
			ENVGradient(c, r, @[ ENColor(0x6fc94f), ENColor(0x3e9f2a) ], NULL);
		}];
		return ENStretch(img, UIEdgeInsetsMake(10, 11, 10, 11));
	});
}

- (UIColor *)groupedPattern {
	if (!_pattern) {
		UIColor *base = self.groupedBackground, *stripe = ENGrey(1, _isDark ? 0.025f : 0.22f);
		UIImage *tile = [ENTheme imageOfSize:CGSizeMake(7, 1) opaque:YES drawing:^(CGContextRef c, CGSize s) {
			ENFill(c, CGRectMake(0, 0, 7, 1), base);
			ENFill(c, CGRectMake(5, 0, 2, 1), stripe);
		}];
		_pattern = tile ? [UIColor colorWithPatternImage:tile] : base;
	}
	return _pattern;
}

- (UIImage *)searchFieldImage:(BOOL)inNavBar {
	BOOL dark = _isDark;
	UIColor *fill = ENColor(dark ? 0x253021 : 0xffffff);
	UIColor *border = ENColor(dark ? 0x080b07 : inNavBar ? 0x0f1d0b : 0x8b9097);
	UIColor *inset = ENGrey(0, dark ? 0.7f : 0.35f);
	return [self cached:(inNavBar ? @"fieldNav" : @"field") make:^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(31, 30) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(0.5f, 0.5f, s.width - 1, s.height - 1) cornerRadius:14.5f];
			[fill setFill];
			[p fill];
			ENInnerShadow(c, p, CGSizeMake(0, 1), 2, inset);
			[border setStroke];
			p.lineWidth = 1;
			[p stroke];
		}];
		return ENStretch(img, UIEdgeInsetsMake(0, 15, 0, 15));
	}];
}

- (UIImage *)pickerCheckImage:(BOOL)on {
	UIColor *ring = self.pickerRing;
	return [self cached:(on ? @"check1" : @"check0") make:^UIImage *{
		return [ENTheme imageOfSize:CGSizeMake(22, 22) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			CGRect r = CGRectMake(1, 1, s.width - 2, s.height - 2);
			if (!on) {
				[ring setStroke];
				CGContextSetLineWidth(c, 1.5f);
				CGContextStrokeEllipseInRect(c, CGRectInset(r, 0.75f, 0.75f));
				return;
			}
			CGContextSaveGState(c);
			CGContextAddEllipseInRect(c, r);
			CGContextClip(c);
			ENVGradient(c, r, @[ ENColor(0x6fc94f), ENColor(0x3e9f2a) ], NULL);
			CGContextRestoreGState(c);
			[ENColor(0x2f8a22) setStroke];
			CGContextSetLineWidth(c, 1);
			CGContextStrokeEllipseInRect(c, CGRectInset(r, 0.5f, 0.5f));
			CGFloat k = s.width / 22;
			CGContextSetLineWidth(c, 2.2f * k);
			CGContextSetLineCap(c, kCGLineCapRound);
			CGContextSetLineJoin(c, kCGLineJoinRound);
			[[UIColor whiteColor] setStroke];
			CGContextMoveToPoint(c, 6.5f * k, 11.5f * k);
			CGContextAddLineToPoint(c, 9.7f * k, 14.6f * k);
			CGContextAddLineToPoint(c, 15.6f * k, 7.8f * k);
			CGContextStrokePath(c);
		}];
	}];
}

- (UIImage *)heartImage:(BOOL)saved size:(CGFloat)side {
	return saved ? [self glyphNamed:@"heart" size:side color:self.heartSaved] : [self glyphNamed:@"heartO" size:side color:self.heartOutline];
}

// (called from a row's drawRect: the key is a boxed integer, not a formatted string)
- (UIImage *)thumbFrameImageOfSide:(CGFloat)side round:(BOOL)round {
	if (side < 4 || side > 400) return nil;
	NSNumber *key = @((NSInteger)roundf(side * 10) * 2 + (round ? 1 : 0));
	UIImage *hit = _thumbFrames[key];
	if (hit) return hit;
	UIColor *border = self.thumbBorder, *fill = self.thumbFill, *drop = self.thumbDrop;
	BOOL hasDrop = !_isDark;
	UIImage *made = [ENTheme imageOfSize:CGSizeMake(side, side + (hasDrop ? 1 : 0)) opaque:NO drawing:^(CGContextRef c, CGSize s) {
		CGRect r = CGRectMake(0, 0, side, side);
		if (hasDrop) {          // the drop line under the box only (a round one is clipped to outside the circle)
			CGContextSaveGState(c);
			if (round) {
				CGContextAddRect(c, CGRectMake(0, 0, s.width, s.height));
				CGContextAddEllipseInRect(c, r);
				CGContextEOClip(c);
				[drop setFill];
				CGContextFillEllipseInRect(c, CGRectOffset(r, 0, 1));
			} else {
				ENFill(c, CGRectMake(0, side, side, 1), drop);
			}
			CGContextRestoreGState(c);
		}
		[border setFill];
		if (round) CGContextFillEllipseInRect(c, r);
		else CGContextFillRect(c, r);
		[fill setFill];                // opaque: it covers the ring's colour inside, leaving the 1 pt ring
		if (round) CGContextFillEllipseInRect(c, CGRectInset(r, 1, 1));
		else CGContextFillRect(c, CGRectInset(r, 1, 1));
	}];
	if (made) _thumbFrames[key] = made;
	return made;
}

// C7: the glossy gbtn pill, h - 1 pt tall plus its 1 pt drop, radius by height, resizable both ways. 3b: 6 up to 40 pt (the 28 pt
// one too, as the mockup's .gbtn: it was 5, and nothing asked for a 28 before NP's device page), 9 from 40 (.gbtn.wide)
static CGFloat ENButtonRadius(CGFloat h) { return h < 40 ? 6 : 9; }

static UIImage *ENPill(CGFloat h, NSArray *cols, const CGFloat *locs, UIColor *border, UIColor *innerTop, UIColor *drop) {
	CGFloat rad = ENButtonRadius(h), cap = rad + 2;
	UIImage *img = [ENTheme imageOfSize:CGSizeMake(cap * 2 + 1, h) opaque:NO drawing:^(CGContextRef c, CGSize s) {
		UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(0.5f, 0.5f, s.width - 1, s.height - 2) cornerRadius:rad];
		if (drop) {
			CGContextSaveGState(c);
			CGContextSetShadowWithColor(c, CGSizeMake(0, 1), 1, drop.CGColor);
			[border setFill];
			[p fill];
			CGContextRestoreGState(c);
		}
		ENGloss(c, p, cols, locs, border, innerTop, nil, nil);
	}];
	return ENStretch(img, UIEdgeInsetsMake(cap, cap, cap, cap));
}

- (UIImage *)buttonImage:(ENButtonStyle)style height:(CGFloat)h pressed:(BOOL)pressed {
	if (h < 20) h = 20;
	static const CGFloat gloss[] = { 0, 0.48f, 0.52f, 1 };
	NSString *key = [NSString stringWithFormat:@"btn%d/%.1f/%d", (int)style, h, pressed];
	if (style == ENButtonStyleGhost) {         // (3c) Ghost: chrome; translucent, no gloss, no drop (mockup .gbtn.silver.ghost)
		return ENShared(key, ^UIImage *{
			UIColor *fill = ENGrey(0, pressed ? 0.55f : 0.35f);
			return ENPill(h, @[ fill, fill ], NULL, ENGrey(1, 0.7f), nil, nil);
		});
	}
	if (style != ENButtonStyleSilver) {        // Green: chrome
		return ENShared(key, ^UIImage *{
			NSArray *cols = pressed ? @[ ENColor(0x3c9a23), ENColor(0x4fb432) ]
			                        : @[ ENColor(0x8ddc6c), ENColor(0x5bbf3e), ENColor(0x44ab28), ENColor(0x3a9f20) ];
			return ENPill(h, cols, pressed ? NULL : gloss, ENColor(0x23781a), ENGrey(1, 0.4f), ENGrey(0, 0.2f));
		});
	}
	BOOL dark = _isDark;
	return [self cached:key make:^UIImage *{
		if (dark) {
			NSArray *cols = pressed ? @[ ENColor(0x252e21), ENColor(0x3b4937) ]
			                        : @[ ENColor(0x4b5a45), ENColor(0x36432f), ENColor(0x2b3526), ENColor(0x252e21) ];
			return ENPill(h, cols, pressed ? NULL : gloss, ENColor(0x0a0d09), ENGrey(1, 0.12f), nil);
		}
		NSArray *cols = pressed ? @[ ENColor(0xcfcfcf), ENColor(0xe9e9e9) ]
		                        : @[ ENColor(0xffffff), ENColor(0xededed), ENColor(0xdddddd), ENColor(0xd3d3d3) ];
		return ENPill(h, cols, pressed ? NULL : gloss, ENColor(0x9d9d9d), ENGrey(1, 1), ENGrey(0, 0.15f));
	}];
}

- (UIImage *)glossyButtonImage:(BOOL)green pressed:(BOOL)pressed {
	return [self buttonImage:(green ? ENButtonStyleGreen : ENButtonStyleSilver) height:34 pressed:pressed];
}

// C7 (3c): the mockup's .gbtn on a UIButton (see ENTheme.h). Every state it touches is set each time (nil clears), so a
// second call (Edit -> Done, Follow -> Following, a theme change) leaves nothing of the first behind.
+ (void)configureButton:(UIButton *)button style:(ENButtonStyle)style title:(NSString *)title glyph:(NSString *)glyph {
	if (!button) return;
	ENTheme *th = [self current];
	CGFloat h = button.bounds.size.height;
	if (h < 20) h = 34;
	BOOL wide = h >= 40, small = h <= 30;
	BOOL silver = style == ENButtonStyleSilver, ghost = style == ENButtonStyleGhost;
	UIControlState selHi = UIControlStateSelected | UIControlStateHighlighted;

	UIImage *bg = [th buttonImage:style height:h pressed:NO], *bgDown = [th buttonImage:style height:h pressed:YES];
	[button setBackgroundImage:bg forState:UIControlStateNormal];
	[button setBackgroundImage:bg forState:UIControlStateSelected];
	[button setBackgroundImage:bgDown forState:UIControlStateHighlighted];
	[button setBackgroundImage:bgDown forState:selHi];

	UIColor *text = silver ? th.silverText : ghost ? th.ghostButtonText : th.greenButtonText;
	UIColor *shadow = silver ? th.silverTextShadow : ghost ? th.ghostButtonTextShadow : th.greenButtonTextShadow;
	UIColor *on = silver ? th.silverOnText : text;
	BOOL hasTitle = title.length > 0;
	[button setTitle:(hasTitle ? title : nil) forState:UIControlStateNormal];
	button.titleLabel.font = wide ? th.wideButtonFont : small ? th.smallButtonFont : th.buttonFont;
	button.titleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
	button.titleLabel.shadowOffset = silver ? th.silverTextShadowOffset : CGSizeMake(0, -1);
	[button setTitleColor:text forState:UIControlStateNormal];
	[button setTitleColor:text forState:UIControlStateHighlighted];
	[button setTitleColor:[text colorWithAlphaComponent:0.5f] forState:UIControlStateDisabled];
	[button setTitleColor:on forState:UIControlStateSelected];
	[button setTitleColor:on forState:selHi];
	[button setTitleShadowColor:shadow forState:UIControlStateNormal];

	// the glyph: 16 / 14 / 20 pt beside a title, 19 / 16 / 22 alone (mockup: 16 in Message / Copy Link, 19 in the iconly Shuffle)
	BOOL disc = [glyph isEqualToString:ENButtonGlyphPlayDisc];
	UIImage *img = nil, *imgOn = nil;
	if (disc) {
		img = imgOn = th.playDiscImage;
	} else if (glyph.length) {
		CGFloat pt = hasTitle ? (wide ? 20 : small ? 14 : 16) : (wide ? 22 : small ? 16 : 19);
		img = [th glyphNamed:glyph size:pt color:text];
		imgOn = silver ? [th glyphNamed:glyph size:pt color:on] : img;
	}
	[button setImage:img forState:UIControlStateNormal];
	[button setImage:img forState:UIControlStateHighlighted];
	[button setImage:imgOn forState:UIControlStateSelected];
	[button setImage:imgOn forState:selHi];
	button.adjustsImageWhenHighlighted = NO;
	button.adjustsImageWhenDisabled = YES;

	// padding (mockup .gbtn: 0 11 0 5 round the disc, 11 on a green one without it, 0 10 on silver and at 28 pt; gap 6).
	// The disc is 26 pt with its 1.5 pt ring, so it starts 1.5 pt early and the gap is 1.5 pt shorter. sizeThatFits:
	// counts contentEdgeInsets but not titleEdgeInsets: the gap goes into both (title moved right, content wider on the right).
	CGFloat left = 0, right = 0, gap = 0;
	if (hasTitle) {
		if (disc) { left = 3.5f; right = 11; }
		else if (silver || ghost || small) left = right = 10;     // (a 28 pt green one: the mockup's padding 0 10px)
		else left = right = 11;
		if (img) gap = disc ? 4.5f : 6;
	}
	button.contentEdgeInsets = UIEdgeInsetsMake(0, left, 1, right + gap);
	button.titleEdgeInsets = UIEdgeInsetsMake(0, gap, 0, -gap);
	button.imageEdgeInsets = UIEdgeInsetsZero;
}

#pragma mark - chrome images (shared)

- (UIImage *)navBarBackground {
	return ENShared(@"navBar", ^UIImage *{
		return ENStrip(44, 0, 0, ^(CGContextRef c, CGSize s) {
			static const CGFloat locs[] = { 0, 0.45f, 0.55f, 1 };
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(0x5a8049), ENColor(0x3d6131), ENColor(0x2c4b23), ENColor(0x1b3015) ], locs);
			ENFill(c, CGRectMake(0, 0, s.width, 1), ENGrey(1, 0.32f));
			ENFill(c, CGRectMake(0, s.height - 2, s.width, 1), ENRGBA(0x82e155, 0.9f));     // row 42
			ENFill(c, CGRectMake(0, s.height - 1, s.width, 1), ENColor(0x0a1407));          // row 43, the very bottom
		});
	});
}

- (UIImage *)tabBarBackground {
	return ENShared(@"tabBar", ^UIImage *{
		return ENStrip(49, 1, 0, ^(CGContextRef c, CGSize s) {
			static const CGFloat locs[] = { 0, 0.49f, 0.51f, 1 };
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(0x35502b), ENColor(0x1f3119), ENColor(0x0f1c0b), ENColor(0x060d04) ], locs);
			ENFill(c, CGRectMake(0, 0, s.width, 1), ENColor(0x55783f));
		});
	});
}

// The selected tab's box. 3b (B1), feedback on 0.10.0: the highlight was off, blocky, with a solid line at the bottom.
// How iOS 6.1 draws it (read from the 6.1 SDK's UIKit, -[UITabBar(Static) _positionTabBarButtons:ignoringItem:],
// -[UITabBarButton _frameForSelectedIndicator], -[UITabBarSelectionIndicatorView setFrame:]): with a custom bar appearance each
// tab button is (64 i, 1, 64, 48) on the 320 pt bar, and the indicator view is CGRectInset(button.bounds, 2, 0) = 60 x 48. A
// resizable image with a top or bottom cap is stretched to exactly that frame; a non-resizable one is drawn at its own size,
// centred, with its vertical offset applied twice; one with only side caps keeps the 48 pt height but is pushed down. So this
// is drawn at 60 x 48 with caps on all four sides, and nothing stretches. (Until 0.10 it was 80 x 49 squeezed into that frame:
// a radius-3 box with a hard 1.5 pt black line along its top and a solid 2 pt #8ce65a line along its bottom, the mockup's
// `inset 0 -2px 0`.) Now: the mockup's box (rgba(130,225,85,.22), 2 pt off the bar's top and bottom, 58 pt wide) rounded 6,
// a soft gloss (a lighter upper half under a faint white sheen) and the mockup's soft inner shadow (0 1px 2px black .6) in
// place of the hard top line. No bottom line.
- (UIImage *)tabSelectionIndicator {
	return ENShared(@"tabSel", ^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(60, 48) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			CGRect r = CGRectMake(1, 1, s.width - 2, s.height - 3);       // 58 x 45: bar y 2 to 47, as the mockup's .tab margin
			UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:r cornerRadius:6];
			CGFloat mid = floorf(r.size.height / 2);
			CGContextSaveGState(c);
			[p addClip];
			ENVGradient(c, CGRectMake(r.origin.x, r.origin.y, r.size.width, mid), @[ ENRGBA(0x9cee70, 0.32f), ENRGBA(0x82e155, 0.24f) ], NULL);
			ENVGradient(c, CGRectMake(r.origin.x, r.origin.y + mid, r.size.width, r.size.height - mid),
			            @[ ENRGBA(0x78d84d, 0.17f), ENRGBA(0x6ccf45, 0.13f) ], NULL);
			ENVGradient(c, CGRectMake(r.origin.x, r.origin.y, r.size.width, roundf(r.size.height * 0.48f)),
			            @[ ENRGBA(0xffffff, 0.07f), ENRGBA(0xffffff, 0.015f) ], NULL);       // the sheen
			CGContextRestoreGState(c);
			ENInnerShadow(c, p, CGSizeMake(0, 1), 2, ENGrey(0, 0.6f));
		}];
		return ENStretch(img, UIEdgeInsetsMake(12, 12, 12, 12));
	});
}

- (UIImage *)miniPlayerBackground {
	return ENShared(@"mini", ^UIImage *{
		return ENStrip(46, 1, 1, ^(CGContextRef c, CGSize s) {
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(0x3b5a2f), ENColor(0x25391c), ENColor(0x162412) ], NULL);
			ENFill(c, CGRectMake(0, 0, s.width, 1), ENColor(0x5f8a4b));
			ENFill(c, CGRectMake(0, s.height - 1, s.width, 1), [UIColor blackColor]);
		});
	});
}

- (UIImage *)miniProgressImage {
	return ENShared(@"miniProgress", ^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(40, 7) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			ENVGradient(c, CGRectMake(0, 2, s.width, 5), @[ ENRGBA(0x78dc50, 0.7f), ENRGBA(0x78dc50, 0) ], NULL);     // the glow
			ENHGradient(c, CGRectMake(0, 0, s.width, 2), @[ ENColor(0x3f9e22), ENColor(0x8fdc5a) ], NULL);           // the line
		}];
		return ENStretch(img, UIEdgeInsetsZero);
	});
}

- (UIImage *)miniArtFrame {
	return ENShared(@"miniArtFrame", ^UIImage *{
		return [ENTheme imageOfSize:CGSizeMake(40, 40) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			CGContextSetLineWidth(c, 1);
			[ENGrey(1, 0.12f) setStroke];
			CGContextStrokeRect(c, CGRectMake(0.5f, 0.5f, 39, 39));
			[[UIColor blackColor] setStroke];
			CGContextStrokeRect(c, CGRectMake(1.5f, 1.5f, 37, 37));
		}];
	});
}

- (UIImage *)bannerImage {
	return ENShared(@"banner", ^UIImage *{
		return ENStrip(30, 0, 1, ^(CGContextRef c, CGSize s) {
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(0xffe278), ENColor(0xf0c43c) ], NULL);
			ENFill(c, CGRectMake(0, s.height - 1, s.width, 1), ENColor(0xb38a12));
		});
	});
}

// .pi: a 23 pt radial disc (#4b4b4b -> #1a1a1a at 50 % / 35 %), a 1.5 pt white .75 ring, a 13 pt white triangle (the
// mockup's 2 px margin in a centred box: +1)
- (UIImage *)playDiscImage {
	UIImage *tri = [self glyphNamed:@"play" size:13 color:[UIColor whiteColor]];
	return ENShared(@"playDisc", ^UIImage *{
		return [ENTheme imageOfSize:CGSizeMake(26, 26) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			CGRect r = CGRectMake(1.5f, 1.5f, 23, 23);
			[ENGrey(1, 0.75f) setFill];
			CGContextFillEllipseInRect(c, CGRectMake(0, 0, s.width, s.height));
			CGContextSaveGState(c);
			CGContextAddEllipseInRect(c, r);
			CGContextClip(c);
			ENRadial(c, CGPointMake(13, 1.5f + 23 * 0.35f), 18.9f, @[ ENColor(0x4b4b4b), ENColor(0x1a1a1a) ], NULL);
			CGContextRestoreGState(c);
			[tri drawAtPoint:CGPointMake((s.width - 13) / 2 + 1, (s.height - 13) / 2)];
		}];
	});
}

- (UIImage *)sheetBackgroundImage {
	return ENShared(@"sheetBG", ^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(1, 4) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			ENFill(c, CGRectMake(0, 0, s.width, s.height), ENRGBA(0x091107, 0.86f));
			ENFill(c, CGRectMake(0, 0, s.width, 1), ENRGBA(0x96e66e, 0.35f));
		}];
		return ENStretch(img, UIEdgeInsetsMake(1, 0, 2, 0));
	});
}

// Spotify's Liked Songs tile (as the mockup draws it): violet -> mint diagonal, a white heart at 48 %
static UIImage *ENLikedTile(CGFloat side) {
	return [ENTheme imageOfSize:CGSizeMake(side, side) opaque:YES drawing:^(CGContextRef c, CGSize s) {
		CGRect r = CGRectMake(0, 0, s.width, s.height);
		ENDGradient(c, r, ENColor(0x4a1ff2), ENColor(0xb9ead6));
		CGFloat g = s.width * 0.48f;
		CGContextTranslateCTM(c, s.width * 0.26f, s.width * 0.25f);
		CGContextScaleCTM(c, g / 24, g / 24);
		[[UIColor whiteColor] set];
		ENDrawGlyph(c, @"heart");
	}];
}

- (UIImage *)likedTile {
	return ENShared(@"liked42", ^UIImage *{ return ENLikedTile(42); });
}

- (UIImage *)likedTileLarge {
	return ENShared(@"liked108", ^UIImage *{ return ENLikedTile(108); });
}

- (UIImage *)newPlaylistTile {
	return ENShared(@"newPlaylist42", ^UIImage *{
		return [ENTheme imageOfSize:CGSizeMake(42, 42) opaque:YES drawing:^(CGContextRef c, CGSize s) {
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(0x8ddc6c), ENColor(0x3a9f20) ], NULL);
			[[UIColor whiteColor] setStroke];
			CGContextSetLineWidth(c, 3.5f);
			CGContextSetLineCap(c, kCGLineCapRound);
			CGContextMoveToPoint(c, 21, 12);
			CGContextAddLineToPoint(c, 21, 30);
			CGContextMoveToPoint(c, 12, 21);
			CGContextAddLineToPoint(c, 30, 21);
			CGContextStrokePath(c);
		}];
	});
}

// 30 pt bar buttons: the pill (radius 5) 29 pt tall over a white .14 line; normal #6f9a5b / #4e7843 / #3a5f30 / #305226 with
// a white .22 inner top line; pressed #2c4a23 -> #1d3317 with a black .7 inner shadow; Done #93e267 / #5cbd36 / #46a826 /
// #3c9c1e (pressed #3c9a23 -> #4fb432); borders #0f1d0b / #1d4f0e
- (UIImage *)barButtonImageDone:(BOOL)done pressed:(BOOL)pressed {
	return ENShared([NSString stringWithFormat:@"bar%d%d", done, pressed], ^UIImage *{
		static const CGFloat gloss[] = { 0, 0.48f, 0.52f, 1 };
		NSArray *cols;
		if (done) cols = pressed ? @[ ENColor(0x3c9a23), ENColor(0x4fb432) ]
		                         : @[ ENColor(0x93e267), ENColor(0x5cbd36), ENColor(0x46a826), ENColor(0x3c9c1e) ];
		else cols = pressed ? @[ ENColor(0x2c4a23), ENColor(0x1d3317) ]
		                    : @[ ENColor(0x6f9a5b), ENColor(0x4e7843), ENColor(0x3a5f30), ENColor(0x305226) ];
		UIColor *border = ENColor(done ? 0x1d4f0e : 0x0f1d0b);
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(13, 30) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(0.5f, 0.5f, s.width - 1, s.height - 2) cornerRadius:5];
			ENGloss(c, p, cols, pressed ? NULL : gloss, border, pressed ? nil : ENGrey(1, 0.22f), ENGrey(1, 0.14f), pressed ? ENGrey(0, 0.7f) : nil);
		}];
		return ENStretch(img, UIEdgeInsetsMake(0, 6, 0, 6));
	});
}

// the back button: the bar button's skin with an 11.5 pt arrow point (mockup core.js backButton), caps L14 / R6
- (UIImage *)backButtonImagePressed:(BOOL)pressed {
	return ENShared(pressed ? @"back1" : @"back0", ^UIImage *{
		static const CGFloat gloss[] = { 0, 0.48f, 0.52f, 1 };
		NSArray *cols = pressed ? @[ ENColor(0x2c4a23), ENColor(0x1d3317) ]
		                        : @[ ENColor(0x6f9a5b), ENColor(0x4e7843), ENColor(0x3a5f30), ENColor(0x305226) ];
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(21, 30) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			CGFloat w = s.width, hh = s.height - 1;          // the shape spans 0.5 ... hh - 0.5; the highlight row under it
			UIBezierPath *p = [UIBezierPath bezierPath];
			[p moveToPoint:CGPointMake(1, hh / 2)];
			[p addLineToPoint:CGPointMake(11.5f, 0.5f)];
			[p addLineToPoint:CGPointMake(w - 5, 0.5f)];
			[p addQuadCurveToPoint:CGPointMake(w - 0.5f, 5) controlPoint:CGPointMake(w - 0.5f, 0.5f)];
			[p addLineToPoint:CGPointMake(w - 0.5f, hh - 5)];
			[p addQuadCurveToPoint:CGPointMake(w - 5, hh - 0.5f) controlPoint:CGPointMake(w - 0.5f, hh - 0.5f)];
			[p addLineToPoint:CGPointMake(11.5f, hh - 0.5f)];
			[p closePath];
			ENGloss(c, p, cols, pressed ? NULL : gloss, ENColor(0x0f1d0b), pressed ? nil : ENGrey(1, 0.22f), ENGrey(1, 0.13f), pressed ? ENGrey(0, 0.7f) : nil);
		}];
		return ENStretch(img, UIEdgeInsetsMake(0, 14, 0, 6));
	});
}

// the silver knob: a 34 pt radial (white / #e2e2e2 45 % / #b9b9b9 75 % / #9c9c9c from 50 % / 20 %; pressed #f0f0f0 ->
// #a7a7a7 from 50 % / 60 %), a black .7 shadow (0,1) 2 and a soft inner bottom edge
- (UIImage *)knobImageWithGlyph:(NSString *)glyph pressed:(BOOL)pressed {
	UIImage *gl = glyph.length ? [self glyphNamed:glyph size:18 color:self.knobGlyph] : nil;
	BOOL play = [glyph isEqualToString:@"play"];
	return ENShared([NSString stringWithFormat:@"knob/%@/%d", glyph ?: @"", pressed], ^UIImage *{
		return [ENTheme imageOfSize:CGSizeMake(38, 38) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			CGRect r = CGRectMake(2, 1, 34, 34);
			UIBezierPath *p = [UIBezierPath bezierPathWithOvalInRect:r];
			CGContextSaveGState(c);
			CGContextSetShadowWithColor(c, CGSizeMake(0, 1), 2, ENGrey(0, 0.7f).CGColor);
			[ENColor(0x9c9c9c) setFill];
			[p fill];
			CGContextRestoreGState(c);
			CGContextSaveGState(c);
			[p addClip];
			if (pressed) {
				ENRadial(c, CGPointMake(CGRectGetMidX(r), r.origin.y + r.size.height * 0.6f), r.size.height * 0.8f,
				         @[ ENColor(0xf0f0f0), ENColor(0xa7a7a7) ], NULL);
			} else {
				static const CGFloat locs[] = { 0, 0.45f, 0.75f, 1 };
				ENRadial(c, CGPointMake(CGRectGetMidX(r), r.origin.y + r.size.height * 0.2f), r.size.height,
				         @[ [UIColor whiteColor], ENColor(0xe2e2e2), ENColor(0xb9b9b9), ENColor(0x9c9c9c) ], locs);
			}
			CGContextRestoreGState(c);
			ENInnerShadow(c, p, CGSizeMake(0, -1), 1, ENGrey(0, 0.2f));
			if (gl) [gl drawAtPoint:CGPointMake(CGRectGetMidX(r) - 9 + (play ? 1 : 0), CGRectGetMidY(r) - 9)];
		}];
	});
}

// action sheet buttons (44 pt, radius 7, border #050a04, inner top white .25, outer bottom white .08): other #668556 /
// #47663b / #37552d / #2f4a26; Cancel #33452c / #1e2c19 / #0e170b; destructive #e86565 / #cf2323 / #bb1111 / #ad0c0c;
// pressed (every role) #55b337 -> #3a8e22
- (UIImage *)sheetButtonImage:(ENSheetButtonRole)role pressed:(BOOL)pressed {
	return ENShared([NSString stringWithFormat:@"sheetBtn%d%d", (int)role, pressed], ^UIImage *{
		static const CGFloat gloss[] = { 0, 0.48f, 0.52f, 1 };
		NSArray *cols;
		const CGFloat *locs = gloss;
		if (pressed) {
			cols = @[ ENColor(0x55b337), ENColor(0x3a8e22) ];
			locs = NULL;
		} else if (role == ENSheetButtonDestructive) {
			cols = @[ ENColor(0xe86565), ENColor(0xcf2323), ENColor(0xbb1111), ENColor(0xad0c0c) ];
		} else if (role == ENSheetButtonCancel) {
			cols = @[ ENColor(0x33452c), ENColor(0x1e2c19), ENColor(0x0e170b) ];
			locs = NULL;
		} else {
			cols = @[ ENColor(0x668556), ENColor(0x47663b), ENColor(0x37552d), ENColor(0x2f4a26) ];
		}
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(19, 45) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(0.5f, 0.5f, s.width - 1, s.height - 2) cornerRadius:7];
			ENGloss(c, p, cols, locs, ENColor(0x050a04), ENGrey(1, 0.25f), ENGrey(1, 0.08f), nil);
		}];
		return ENStretch(img, UIEdgeInsetsMake(9, 9, 9, 9));
	});
}

// the alert panel: a radial ellipse from the top centre (farthest corner), rgba(92,160,64,.97) -> rgba(16,46,10,.96) at 72 %;
// the gloss ellipse (80 pt wider, 200 tall, its bottom 40 pt inside) white .28 -> .08; a 2 pt white .85 border, radius 10
- (UIImage *)alertBackgroundImageOfSize:(CGSize)size {
	if (size.width < 30 || size.height < 30) return nil;
	NSString *key = [NSString stringWithFormat:@"%.0fx%.0f", size.width, size.height];
	if (!sAlertImages) sAlertImages = [NSMutableDictionary dictionary];
	UIImage *img = sAlertImages[key];
	if (img) return img;
	img = [ENTheme imageOfSize:size opaque:NO drawing:^(CGContextRef c, CGSize s) {
		UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(1, 1, s.width - 2, s.height - 2) cornerRadius:9];
		CGContextSaveGState(c);
		[p addClip];
		CGFloat rx = s.width / 2 * 1.4142f, ry = s.height * 1.4142f;
		CGContextSaveGState(c);
		CGContextTranslateCTM(c, s.width / 2, 0);
		CGContextScaleCTM(c, rx / ry, 1);
		static const CGFloat locs[] = { 0, 0.72f };
		ENRadial(c, CGPointZero, ry, @[ ENRGBA(0x5ca040, 0.97f), ENRGBA(0x102e0a, 0.96f) ], locs);
		CGContextRestoreGState(c);
		CGRect gl = CGRectMake(-40, -160, s.width + 80, 200);
		CGContextAddEllipseInRect(c, gl);
		CGContextClip(c);
		ENVGradient(c, gl, @[ ENGrey(1, 0.28f), ENGrey(1, 0.08f) ], NULL);
		CGContextRestoreGState(c);
		[ENGrey(1, 0.85f) setStroke];
		p.lineWidth = 2;
		[p stroke];
	}];
	if (img) sAlertImages[key] = img;
	return img;
}

- (UIImage *)statusDotImage:(BOOL)ok {
	return ENShared(ok ? @"dot1" : @"dot0", ^UIImage *{
		return [ENTheme imageOfSize:CGSizeMake(9, 9) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			UIBezierPath *p = [UIBezierPath bezierPathWithOvalInRect:CGRectMake(0, 0, s.width, s.height)];
			CGContextSaveGState(c);
			[p addClip];
			ENRadial(c, CGPointMake(4.5f, 2.7f), 7.74f, ok ? @[ ENColor(0x9cf07a), ENColor(0x39a51c) ] : @[ ENColor(0xff8d8d), ENColor(0xd01e1e) ], NULL);
			CGContextRestoreGState(c);
			ENInnerShadow(c, p, CGSizeMake(0, -1), 1, ENGrey(0, 0.3f));
		}];
	});
}

- (UIImage *)iconTileWithGlyph:(NSString *)glyph top:(UIColor *)top bottom:(UIColor *)bottom size:(CGFloat)side radius:(CGFloat)radius {
	if (side < 4 || !top || !bottom) return nil;
	CGFloat gpt = side < 40 ? roundf(side * 18 / 29) : roundf(side * 24 / 42);
	UIImage *g = glyph.length ? [self glyphNamed:glyph size:gpt color:[UIColor whiteColor]] : nil;
	NSString *key = [NSString stringWithFormat:@"tile/%@/%@/%@/%.1f/%.1f", glyph ?: @"", ENColorKey(top), ENColorKey(bottom), side, radius];
	return ENShared(key, ^UIImage *{
		return [ENTheme imageOfSize:CGSizeMake(side, side) opaque:(radius <= 0) drawing:^(CGContextRef c, CGSize s) {
			CGRect r = CGRectMake(0, 0, s.width, s.height);
			UIBezierPath *p = radius > 0 ? [UIBezierPath bezierPathWithRoundedRect:r cornerRadius:radius] : [UIBezierPath bezierPathWithRect:r];
			CGContextSaveGState(c);
			[p addClip];
			ENVGradient(c, r, @[ top, bottom ], NULL);
			if (radius > 0) {            // the inset 1 pt black .15 ring
				UIBezierPath *ring = [UIBezierPath bezierPathWithRoundedRect:CGRectInset(r, 0.5f, 0.5f) cornerRadius:(radius > 0.5f ? radius - 0.5f : 0)];
				[ENGrey(0, 0.15f) setStroke];
				ring.lineWidth = 1;
				[ring stroke];
			}
			CGContextRestoreGState(c);
			if (g) [g drawAtPoint:CGPointMake(floorf((s.width - g.size.width) / 2), floorf((s.height - g.size.height) / 2))];
		}];
	});
}

- (UIImage *)iconTileNamed:(NSString *)name size:(CGFloat)side {
	static NSDictionary *kinds;
	if (!kinds) kinds = @{
		@"album": @[ @"album", @0xf0a35a, @0xc9681e ],          // Library (today's gradients)
		@"artist": @[ @"artist", @0x6aa8ff, @0x2f62c9 ],
		@"recent": @[ @"clock", @0xb37be6, @0x7a3fc0 ],
		@"computer": @[ @"computer", @0x7a828c, @0x4d545d ],    // Settings (§1.3)
		@"wifi": @[ @"wifi", @0x6aa8ff, @0x2f62c9 ],
		@"statusOK": @[ @"check", @0x7fd35a, @0x3d9a22 ],
		@"statusBad": @[ @"check", @0xff8a8a, @0xc81e1e ],
		@"engine": @[ @"note", @0xf0a35a, @0xc9681e ],
		@"jam": @[ @"people", @0x7fd35a, @0x3d9a22 ],
		@"theme": @[ @"moon", @0x4b5a45, @0x1f2a1b ],
		@"folder": @[ @"folder", @0x8a8f96, @0x5d636b ],
		@"newPlaylist": @[ @"plus", @0x7fd35a, @0x3d9a22 ],
	};
	NSArray *k = name ? kinds[name] : nil;
	if (k.count != 3) return nil;
	return [self iconTileWithGlyph:k[0] top:ENColor((unsigned)[k[1] integerValue]) bottom:ENColor((unsigned)[k[2] integerValue])
	                          size:side radius:(side < 40 ? roundf(side * 6 / 29) : 0)];
}

- (UIImage *)tabIconAtIndex:(NSUInteger)i {
	if (i > 4) i = 4;
	NSString *name = [NSString stringWithFormat:@"tab%lu_v2", (unsigned long)i];
	return ENShared(name, ^UIImage *{ return ENCachedPNG(name, ^UIImage *{ return ENTabMask(i); }); });
}

- (UIImage *)finishedTabIconAtIndex:(NSUInteger)i selected:(BOOL)selected {
	if (i > 4) i = 4;
	NSString *name = [NSString stringWithFormat:@"tab%lu_%@_v3", (unsigned long)i, selected ? @"on" : @"off"];
	return ENShared(name, ^UIImage *{
		return ENCachedPNG(name, ^UIImage *{
			static const CGFloat onLocs[] = { 0, 0.45f, 0.55f, 1 };
			UIImage *mask = ENTabMask(i);
			UIImage *fill = selected ? ENTintedMask(mask, @[ ENColor(0xe5ffc9), ENColor(0xa6e46a), ENColor(0x6cc12c), ENColor(0x4da516) ], onLocs)
			                         : ENTintedMask(mask, @[ ENColor(0xb3caa5), ENColor(0x87a079), ENColor(0x67805c) ], NULL);
			UIImage *shadow = ENTintedMask(mask, @[ ENGrey(0, 0.9f), ENGrey(0, 0.9f) ], NULL);
			CGRect r = CGRectMake(0, 0, 30, 30);
			UIGraphicsBeginImageContextWithOptions(r.size, NO, 2);
			[shadow drawInRect:CGRectOffset(r, 0, -1)];      // the 1 pt black .9 shadow above (drop-shadow(0 -1px 0))
			[fill drawInRect:r];
			UIImage *img = UIGraphicsGetImageFromCurrentImageContext();
			UIGraphicsEndImageContext();
			return img;
		});
	});
}

#pragma mark - glyphs

- (UIImage *)glyphNamed:(NSString *)name size:(CGFloat)pt color:(UIColor *)color {
	if (!name.length || pt <= 0 || !color) return nil;
	NSString *key = [NSString stringWithFormat:@"%@/%.1f/%@", name, pt, ENColorKey(color)];
	UIImage *img = _glyphs[key];
	if (img) return img;
	img = [ENTheme imageOfSize:CGSizeMake(pt, pt) opaque:NO drawing:^(CGContextRef c, CGSize s) {
		CGContextScaleCTM(c, s.width / 24, s.height / 24);
		[color set];
		ENDrawGlyph(c, name);
	}];
	if (img) _glyphs[key] = img;
	return img;
}

#pragma mark - 0.6 Jam (chrome)

- (UIImage *)jamBarImage {
	return ENShared(@"jamBar", ^UIImage *{
		return ENStrip(18, 1, 0, ^(CGContextRef c, CGSize s) {
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(0x6fcb4d), ENColor(0x3b9c25) ], NULL);
			ENFill(c, CGRectMake(0, 0, s.width, 1), ENColor(0x8fdc72));
		});
	});
}

- (UIImage *)jamPillImage {
	return ENShared(@"jamPill", ^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(24, 21) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			CGRect r = CGRectMake(0.5f, 0.5f, s.width - 1, 19);
			UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:r cornerRadius:9.5f];
			CGContextSaveGState(c);
			CGContextSetShadowWithColor(c, CGSizeMake(0, 1), 1, ENGrey(0, 0.6f).CGColor);
			[ENColor(0x3d9a22) setFill];
			[p fill];
			CGContextRestoreGState(c);
			CGContextSaveGState(c);
			[p addClip];
			ENVGradient(c, r, @[ ENColor(0x7fd35a), ENColor(0x3d9a22) ], NULL);
			ENFill(c, CGRectMake(r.origin.x, r.origin.y, r.size.width, 1), ENRGBA(0xffffff, 0.35f));     // the inset highlight
			CGContextRestoreGState(c);
		}];
		return ENStretch(img, UIEdgeInsetsMake(0, 11, 0, 11));
	});
}

- (UIImage *)jamQueueHeaderImage {
	return ENShared(@"jamQueueHeader", ^UIImage *{ return ENBand(22, 0x5fae3e, 0x3d8a24, 0x7fc95c, 0x2f6e1b); });
}

- (UIImage *)jamHeroImageOfSize:(CGSize)size drawing:(void (^)(CGContextRef c, CGSize size))draw {
	return [ENTheme imageOfSize:size opaque:YES drawing:^(CGContextRef c, CGSize s) {
		CGRect r = CGRectMake(0, 0, s.width, s.height);
		// 135°: from the top-left corner towards the bottom-right, along the box's diagonal
		static const CGFloat locs[] = { 0, 0.55f, 1 };
		CGGradientRef g = ENGradientCreate(@[ ENColor(0x7bd34f), ENColor(0x3d9a22), ENColor(0x1f6e2a) ], locs);
		CGContextDrawLinearGradient(c, g, CGPointZero, CGPointMake(s.width, s.height), kCGGradientDrawsBeforeStartLocation | kCGGradientDrawsAfterEndLocation);
		CGGradientRelease(g);
		ENRadial(c, CGPointMake(s.width * 0.25f, s.height * 0.15f), MAX(s.width, s.height) * 0.45f, @[ ENRGBA(0xffffff, 0.28f), ENRGBA(0xffffff, 0) ], NULL);
		ENFill(c, CGRectMake(0, s.height - 2, s.width, 1), ENRGBA(0xffffff, 0.2f));
		ENFill(c, CGRectMake(0, s.height - 1, s.width, 1), ENColor(0x1d5a14));
		if (draw) {
			CGContextSaveGState(c);
			CGContextClipToRect(c, r);
			draw(c, s);
			CGContextRestoreGState(c);
		}
	}];
}

static NSUInteger ENAvatarIndex(NSString *key) {     // a stable hash (NSString -hash isn't promised to stay the same)
	NSUInteger h = 0;
	for (NSUInteger i = 0; i < key.length; i++) h = h * 31 + [key characterAtIndex:i];
	return h % 4;
}

static const unsigned ENAvatarPalette[4] = { 0x3fae3a, 0xe2557c, 0x6aa8ff, 0xf0a35a };

- (UIColor *)avatarColorForKey:(NSString *)key {
	return ENColor(ENAvatarPalette[ENAvatarIndex(key)]);
}

- (UIColor *)avatarShadeForKey:(NSString *)key {
	unsigned rgb = ENAvatarPalette[ENAvatarIndex(key)];
	return [UIColor colorWithRed:((rgb >> 16) & 0xff) * 0.62f / 255 green:((rgb >> 8) & 0xff) * 0.62f / 255 blue:(rgb & 0xff) * 0.62f / 255 alpha:1];
}

#pragma mark - 3b (B1): Now Playing chrome, the slider kit, pager dots, repeat-one

- (UIImage *)npStripBackground {
	return ENShared(@"npStrip", ^UIImage *{
		return ENStrip(82, 0, 1, ^(CGContextRef c, CGSize s) {
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(0x16250f), ENColor(0x060b05) ], NULL);
			ENFill(c, CGRectMake(0, s.height - 1, s.width, 1), ENColor(0x1d3016));
		});
	});
}

- (UIImage *)npTransportBackground {
	return ENShared(@"npTransport", ^UIImage *{
		return ENStrip(58, 1, 0, ^(CGContextRef c, CGSize s) {
			static const CGFloat locs[] = { 0, 0.5f, 0.51f, 1 };
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(0x304a26), ENColor(0x1c2e16), ENColor(0x0b1508), ENColor(0x030703) ], locs);
			ENFill(c, CGRectMake(0, 0, s.width, 1), ENRGBA(0xa0f06e, 0.25f));
		});
	});
}

- (UIImage *)npTransportSeparator {
	return ENShared(@"npSeparator", ^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(2, 1) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			ENFill(c, CGRectMake(0, 0, 1, 1), [UIColor blackColor]);
			ENFill(c, CGRectMake(1, 0, 1, 1), ENGrey(1, 0.07f));
		}];
		return ENStretch(img, UIEdgeInsetsZero);
	});
}

- (UIImage *)npTransportPressed {
	return ENShared(@"npPressed", ^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(1, 1) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			ENFill(c, CGRectMake(0, 0, 1, 1), ENGrey(1, 0.08f));
		}];
		return ENStretch(img, UIEdgeInsetsZero);
	});
}

- (UIImage *)npBottomBackground {
	return ENShared(@"npBottom", ^UIImage *{
		return ENStrip(44, 0, 0, ^(CGContextRef c, CGSize s) {
			ENVGradient(c, CGRectMake(0, 0, s.width, s.height), @[ ENColor(0x0b1309), ENColor(0x020402) ], NULL);
		});
	});
}

// (the 0.10 ENNowPlaceholder, moved: the same picture; the note is drawn straight into it instead of through the glyph cache,
// so no 128 pt glyph stays cached)
- (UIImage *)nowPlayingPlaceholderOfSide:(CGFloat)side {
	if (side < 1) return nil;
	return [ENTheme imageOfSize:CGSizeMake(side, side) opaque:YES drawing:^(CGContextRef c, CGSize s) {
		ENDGradient(c, CGRectMake(0, 0, s.width, s.height), ENColor(0x22361b), ENColor(0x0b130a));
		CGFloat g = s.width * 0.4f;
		CGContextTranslateCTM(c, floorf((s.width - g) / 2), floorf((s.height - g) / 2));
		CGContextScaleCTM(c, g / 24, g / 24);
		[ENColor(0x3d5a33) set];
		ENDrawGlyph(c, @"note");
	}];
}

// C9: an 11 x 11 track (see ENTheme.h): the pill's white .12 lower edge (the pill shape 1 pt lower, CSS 0 1px 0), then the
// pill's gradient, then its inner shadow: the track's from the top (inset 0 1px 2px black .9), the fill's from the bottom
// (inset 0 -1px 1px black .25)
static UIImage *ENSliderTrack(BOOL fill) {
	UIImage *img = [ENTheme imageOfSize:CGSizeMake(11, 11) opaque:NO drawing:^(CGContextRef c, CGSize s) {
		CGRect r = CGRectMake(0, 1, s.width, 9);
		UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:r cornerRadius:4.5f];
		CGContextSaveGState(c);
		CGContextTranslateCTM(c, 0, 1);
		[ENGrey(1, 0.12f) setFill];
		[p fill];
		CGContextRestoreGState(c);
		CGContextSaveGState(c);
		[p addClip];
		ENVGradient(c, r, fill ? @[ ENColor(0xa6ec74), ENColor(0x4fae2f) ] : @[ ENColor(0x0f0f0f), ENColor(0x3a3a3a) ], NULL);
		CGContextRestoreGState(c);
		if (fill) ENInnerShadow(c, p, CGSizeMake(0, -1), 1, ENGrey(0, 0.25f));
		else ENInnerShadow(c, p, CGSizeMake(0, 1), 2, ENGrey(0, 0.9f));
	}];
	return ENStretch(img, UIEdgeInsetsMake(5, 5, 5, 5));
}

- (UIImage *)sliderMinimumTrackImage {
	return ENShared(@"sliderMin", ^UIImage *{ return ENSliderTrack(YES); });
}

- (UIImage *)sliderMaximumTrackImage {
	return ENShared(@"sliderMax", ^UIImage *{ return ENSliderTrack(NO); });
}

// the 23 pt knob (mockup .slider .th): radial-gradient(circle at 50% 25%, ...) reaches its farthest corner, 20.7 pt away
- (UIImage *)sliderThumbImage {
	return ENShared(@"sliderThumb", ^UIImage *{
		return [ENTheme imageOfSize:CGSizeMake(29, 31) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			CGRect r = CGRectMake(3, 4, 23, 23);
			UIBezierPath *p = [UIBezierPath bezierPathWithOvalInRect:r];
			CGContextSaveGState(c);
			CGContextSetShadowWithColor(c, CGSizeMake(0, 1), 3, ENGrey(0, 0.8f).CGColor);
			[ENColor(0x9a9a9a) setFill];
			[p fill];
			CGContextRestoreGState(c);
			CGContextSaveGState(c);
			[p addClip];
			static const CGFloat locs[] = { 0, 0.4f, 0.8f, 1 };
			CGFloat rx = r.size.width / 2, ry = r.size.height * 0.75f;
			ENRadial(c, CGPointMake(CGRectGetMidX(r), r.origin.y + r.size.height * 0.25f), sqrtf(rx * rx + ry * ry),
			         @[ ENColor(0xffffff), ENColor(0xececec), ENColor(0xb4b4b4), ENColor(0x9a9a9a) ], locs);
			CGContextRestoreGState(c);
			ENInnerShadow(c, p, CGSizeMake(0, -1), 1, ENGrey(0, 0.2f));
		}];
	});
}

- (void)styleSlider:(UISlider *)slider {
	if (!slider) return;
	[slider setMinimumTrackImage:self.sliderMinimumTrackImage forState:UIControlStateNormal];
	[slider setMaximumTrackImage:self.sliderMaximumTrackImage forState:UIControlStateNormal];
	[slider setThumbImage:self.sliderThumbImage forState:UIControlStateNormal];
	[slider setThumbImage:self.sliderThumbImage forState:UIControlStateHighlighted];
}

- (UIImage *)pagerDotsImageWithCount:(NSUInteger)count current:(NSUInteger)index {
	if (count < 1 || count > 9) return nil;
	if (index >= count) index = count - 1;
	NSString *key = [NSString stringWithFormat:@"pager%lu.%lu", (unsigned long)count, (unsigned long)index];
	return ENShared(key, ^UIImage *{
		return [ENTheme imageOfSize:CGSizeMake(6 + 12 * count, 12) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			[ENGrey(0, 0.8f) setFill];
			[[UIBezierPath bezierPathWithRoundedRect:CGRectMake(0, 0, s.width, s.height) cornerRadius:6] fill];
			for (NSUInteger i = 0; i < count; i++) {
				[(i == index ? [UIColor whiteColor] : ENColor(0x6b6b6b)) setFill];
				CGContextFillEllipseInRect(c, CGRectMake(6 + 12 * i, 3, 6, 6));
			}
		}];
	});
}

- (UIImage *)repeatOneBadge {
	return ENShared(@"repeatOneBadge", ^UIImage *{
		UIFont *f = ENHN(YES, 9);
		return [ENTheme imageOfSize:CGSizeMake(12, 12) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			[ENColor(0x6fd14a) setFill];
			CGContextFillEllipseInRect(c, CGRectMake(0, 0, s.width, s.height));
			[[UIColor blackColor] set];
			CGFloat lh = ceilf(f.lineHeight);
			[@"1" drawInRect:CGRectMake(0, floorf((s.height - lh) / 2), s.width, lh) withFont:f lineBreakMode:NSLineBreakByClipping
			       alignment:NSTextAlignmentCenter];
		}];
	});
}

- (UIImage *)repeatOneImage {
	return ENShared(@"repeatOne34", ^UIImage *{
		UIImage *glyph = [self glyphNamed:@"repeat" size:22 color:self.npToggleOn], *badge = self.repeatOneBadge;
		return [ENTheme imageOfSize:CGSizeMake(34, 30) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			[glyph drawAtPoint:CGPointMake(6, 4)];
			[badge drawAtPoint:CGPointMake(22, 0)];
		}];
	});
}

#pragma mark - 3c (C1): the Setup screen (chrome)

// mockup .setup: repeating-linear-gradient(45deg, white .018 0 2px, clear 2px 5px) over radial-gradient(circle at 50% 22%,
// #35502b, #0d150a 72%); a circle's default size reaches the farthest corner
- (UIImage *)setupBackgroundImageOfSize:(CGSize)size {
	if (size.width < 1 || size.height < 1) return nil;
	return [ENTheme imageOfSize:size opaque:YES drawing:^(CGContextRef c, CGSize s) {
		ENFill(c, CGRectMake(0, 0, s.width, s.height), ENColor(0x0d150a));
		CGFloat cx = s.width * 0.5f, cy = s.height * 0.22f;
		CGFloat fx = MAX(cx, s.width - cx), fy = MAX(cy, s.height - cy);
		static const CGFloat locs[] = { 0, 0.72f };
		ENRadial(c, CGPointMake(cx, cy), sqrtf(fx * fx + fy * fy), @[ ENColor(0x35502b), ENColor(0x0d150a) ], locs);
		// the stripes: rotated -45° (y down), x runs along the CSS 45deg line (towards the top right); 2 pt bands every 5 pt
		CGFloat d = ceilf(sqrtf(s.width * s.width + s.height * s.height));
		CGContextSaveGState(c);
		CGContextRotateCTM(c, (CGFloat)-M_PI_4);
		[ENGrey(1, 0.018f) setFill];
		for (CGFloat x = -5 * ceilf(d / 5); x < d; x += 5) CGContextFillRect(c, CGRectMake(x, -d, 2, 2 * d));
		CGContextRestoreGState(c);
	}];
}

// mockup .setup .appicon: 76 pt, radius 16, box-shadow 0 3px 8px black .7
- (UIImage *)setupIconImage:(UIImage *)icon {
	UIImage *note = icon ? nil : [self glyphNamed:@"note" size:40 color:[UIColor whiteColor]];
	return [ENTheme imageOfSize:CGSizeMake(96, 96) opaque:NO drawing:^(CGContextRef c, CGSize s) {
		CGRect r = CGRectMake(10, 7, 76, 76);
		UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:r cornerRadius:16];
		CGContextSaveGState(c);
		CGContextSetShadowWithColor(c, CGSizeMake(0, 3), 8, ENGrey(0, 0.7f).CGColor);
		[[UIColor blackColor] setFill];
		[p fill];
		CGContextRestoreGState(c);
		CGContextSaveGState(c);
		[p addClip];
		if (icon) {
			[icon drawInRect:r];
		} else {               // a stand-in: the Jam tile's green with a white note
			ENVGradient(c, r, @[ ENColor(0x7fd35a), ENColor(0x3d9a22) ], NULL);
			[note drawAtPoint:CGPointMake(CGRectGetMidX(r) - 20, CGRectGetMidY(r) - 20)];
		}
		CGContextRestoreGState(c);
	}];
}

// mockup .setup .dfields: border 1px #000, radius 9, linear-gradient(#2c2c2c, #232323), box-shadow 0 1px 0 white .1 (under
// it) and inset 0 1px 0 white .06 (just inside the top)
- (UIImage *)setupFieldBoxImage {
	return ENShared(@"setupBox", ^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(21, 135) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(0.5f, 0.5f, s.width - 1, s.height - 2) cornerRadius:9];
			ENGloss(c, p, @[ ENColor(0x2c2c2c), ENColor(0x232323) ], NULL, [UIColor blackColor], ENGrey(1, 0.06f), ENGrey(1, 0.1f), nil);
		}];
		return ENStretch(img, UIEdgeInsetsMake(10, 10, 11, 10));
	});
}

// mockup .setup .df: border-top 1px #111 and inset 0 1px 0 white .05 (the line under it)
- (UIImage *)setupFieldSeparatorImage {
	return ENShared(@"setupSeparator", ^UIImage *{
		UIImage *img = [ENTheme imageOfSize:CGSizeMake(1, 2) opaque:NO drawing:^(CGContextRef c, CGSize s) {
			ENFill(c, CGRectMake(0, 0, s.width, 1), ENColor(0x111111));
			ENFill(c, CGRectMake(0, 1, s.width, 1), ENGrey(1, 0.05f));
		}];
		return ENStretch(img, UIEdgeInsetsZero);
	});
}

@end

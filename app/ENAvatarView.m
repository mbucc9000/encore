#import "ENAvatarView.h"
#import "ENImageCache.h"
#import "ENModel.h"
#import "ENTheme.h"

// bold, 0.46 x the side; the last one is kept (a list draws many avatars of one size)
static UIFont *ENAvatarFont(CGFloat side) {
	static UIFont *last;
	static CGFloat lastPt;
	CGFloat pt = floorf(side * 0.46f);
	if (!last || pt != lastPt) {
		last = [ENTheme fontOfSize:pt bold:YES];
		lastPt = pt;
	}
	return last;
}

@implementation ENAvatarView {
	NSString *_token, *_name, *_memberID;
	UIImage *_image;
	NSString *_pendingKey;     // the ENImageCache load still out (cancelled when the member changes)
}

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		self.opaque = NO;
		self.backgroundColor = [UIColor clearColor];
		self.contentMode = UIViewContentModeRedraw;
		self.userInteractionEnabled = NO;
	}
	return self;
}

- (void)dealloc {
	if (_pendingKey) [[ENImageCache shared] cancel:_pendingKey];
}

- (void)setMember:(ENJamMember *)member {
	_member = member;
	// (R2a) through the member's getters: no picture, the made-up name and a keyed colour while Anonymous Mode is on
	[self setImageToken:member.imageToken name:member.name memberID:member.avatarKey];
}

- (void)setImageToken:(NSString *)token name:(NSString *)name memberID:(NSString *)memberID {
	_name = [name copy];
	_memberID = [memberID copy];
	BOOL same = (token == _token) || [token isEqualToString:_token];
	if (!same) {
		if (_pendingKey) [[ENImageCache shared] cancel:_pendingKey];
		_pendingKey = nil;
		_token = [token copy];
		_image = token ? [[ENImageCache shared] memoryImage:token size:ENImg88 round:YES] : nil;
		if (token && !_image) {
			__weak ENAvatarView *w = self;
			_pendingKey = [[[ENImageCache shared] load:token size:ENImg88 round:YES done:^(UIImage *img, NSString *key) {
				ENAvatarView *s = w;
				if (!s || ![s->_pendingKey isEqualToString:key]) return;
				s->_pendingKey = nil;
				if (img) { s->_image = img; [s setNeedsDisplay]; }       // a dead picture (404) keeps the initials
			}] copy];
		}
	}
	[self setNeedsDisplay];
}

- (void)drawRect:(CGRect)rect {
	CGRect b = self.bounds;
	CGFloat side = MIN(b.size.width, b.size.height);
	CGRect r = CGRectMake(floorf((b.size.width - side) / 2), floorf((b.size.height - side) / 2), side, side);
	[ENAvatarView drawAvatarInRect:r image:_image name:_name memberID:_memberID];
}

+ (void)drawAvatarInRect:(CGRect)r image:(UIImage *)image name:(NSString *)name memberID:(NSString *)memberID {
	CGContextRef c = UIGraphicsGetCurrentContext();
	if (!c || r.size.width < 4) return;
	CGFloat side = r.size.width, ring = side <= 22 ? 1.5f : 2;
	ENTheme *th = [ENTheme current];
	if (image) {
		[image drawInRect:r];
	} else {
		NSString *key = memberID ?: name ?: @"";
		CGContextSaveGState(c);
		CGContextAddEllipseInRect(c, r);
		CGContextClip(c);
		CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
		NSArray *cols = @[ (__bridge id)[th avatarColorForKey:key].CGColor, (__bridge id)[th avatarShadeForKey:key].CGColor ];
		CGGradientRef g = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)cols, NULL);
		CGPoint ctr = CGPointMake(CGRectGetMidX(r), r.origin.y + side * 0.3f);     // radial-gradient(circle at 50% 30%)
		CGContextDrawRadialGradient(c, g, ctr, 0, ctr, side * 0.85f, kCGGradientDrawsAfterEndLocation);
		CGGradientRelease(g);
		CGColorSpaceRelease(cs);
		NSString *n = [name stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
		NSString *ini = n.length ? [[n substringWithRange:[n rangeOfComposedCharacterSequenceAtIndex:0]] uppercaseString] : @"?";
		UIFont *f = ENAvatarFont(side);
		CGContextSetShadowWithColor(c, CGSizeMake(0, -1), 0, th.avatarTextShadow.CGColor);
		[th.avatarText set];
		CGFloat th2 = f.lineHeight;
		[ini drawInRect:CGRectMake(r.origin.x, r.origin.y + floorf((side - th2) / 2), side, th2) withFont:f
		  lineBreakMode:NSLineBreakByClipping alignment:NSTextAlignmentCenter];
		CGContextRestoreGState(c);
	}
	[th.avatarRing setStroke];
	CGContextSetLineWidth(c, ring);
	CGContextStrokeEllipseInRect(c, CGRectInset(r, ring / 2, ring / 2));
}

@end

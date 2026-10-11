#import <UIKit/UIKit.h>

// A Jam member's round picture (app 0.6; owner: UI; DESIGN-4b §6.4): 40 pt in the Jam screen's hero, 30 pt in its member
// rows; Up Next's 22 pt ones are drawn by ENListCell itself with +drawAvatarInRect:... .
//   - the member's picture: ENImageCache 88 tier, round:YES (a baked circle, decoded off the main thread; 88 px covers 40 pt
//     at 2x); else the initials (bold, 0.46 x the size, white) on a radial gradient of the colour ENTheme hashes from the
//     member id (#3fae3a / #e2557c / #6aa8ff / #f0a35a -> 62 % shade);
//   - a white ring on top: 2 pt (1.5 pt at 22 pt and below).
// Everything is drawn in -drawRect: (no cornerRadius, masksToBounds or shadow*: the hero bakes its avatars' shadows into its
// own image). Not opaque (a circle). Main thread only.
// 0.10 (Drop 3a, DESIGN-5 §2.1 A2): the initials' font, colour and shadow and the ring come from ENTheme (avatarText,
// avatarTextShadow, avatarRing; +fontOfSize:bold:). The same in both themes (the colours hash from the member id).

@class ENJamMember;

@interface ENAvatarView : UIView

@property (nonatomic, strong) ENJamMember *member;     // sets the three fields below (nil = blank)
// The same without an ENJamMember. token nil -> initials of name. memberID picks the colour (never logged).
- (void)setImageToken:(NSString *)token name:(NSString *)name memberID:(NSString *)memberID;

// One avatar into the current context: image (already round) or the initials of name on memberID's colour, then the ring.
+ (void)drawAvatarInRect:(CGRect)r image:(UIImage *)image name:(NSString *)name memberID:(NSString *)memberID;

@end

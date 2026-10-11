#import <UIKit/UIKit.h>

// The green 18 pt bar over the tab bar while a Jam is on (app 0.6; owner: UI; DESIGN-4b §6.4). Generic on purpose: Phase 5's
// "Listening on X" Connect bar reuses it with another text and glyph.
//   ENTheme jamBarImage | a 14 pt white glyph (people by default) | bold 11 pt white text, one line, tail-truncated. One
//   opaque view drawn in -drawRect:. Tap -> onTap (ENTabBarController: -presentJam).
// 0.10 (Drop 3a, DESIGN-5 §2.1 A2; owner A2, then B3): the glyph and the text are centred together with a 5 pt gap (mockup
// .connect-bar), in ENTheme's chrome tokens (jamBarFill / jamBarText / jamBarTextShadow, +font = jamBarFont); -textWidth is
// the room the text has in that centred layout (what -[ENJam barTextFittingWidth:font:] fits to). ENTabBarController slides
// it with the mini player.
// 0.11 (Drop 3b, DESIGN-5 §2.2 B3; owner B3): a `mode`. Jam = the people glyph (14 pt), as before; Connect = the "Listening on
// <device>" bar (speakerHi, 13 pt; mockup .connect-bar) while another device plays. Setting the mode swaps the glyph (set
// `text` after it: -textWidth depends on the glyph); what a tap does is the owner's (onTap; ENTabBarController reads `mode`).
// Main thread only.

typedef enum {
	ENJamBarModeJam = 0,      // a Jam is on: people glyph; tap -> the Jam screen
	ENJamBarModeConnect,      // (3b) another device plays: speakerHi glyph, "Listening on <device>"; tap -> Now Playing
} ENJamBarMode;

@interface ENJamBar : UIView

+ (CGFloat)height;                               // 18
+ (UIFont *)font;                                // ENTheme jamBarFont (HelveticaNeue-Bold 11)

@property (nonatomic, copy) NSString *text;
@property (nonatomic, strong) UIImage *glyph;    // default: ENTheme's people glyph, 14 pt, white (-setMode: replaces it)
@property (nonatomic) ENJamBarMode mode;         // (3b) default ENJamBarModeJam; a change sets the mode's glyph and redraws
@property (nonatomic, copy) void (^onTap)(void);

- (CGFloat)textWidth;                            // the room the text has at the current width (8 pt margins, glyph + 5 pt gap)

@end

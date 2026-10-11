#import <UIKit/UIKit.h>

// The mini player above the tab bar (owner: UI; DESIGN-3 §5.5): 320 x 46 pt on ENTheme miniPlayerBackground.
//   36 pt art (88 tier of [ENPlayback shared].track img; placeholder otherwise) | artist line (miniSub, bold 12) over the
//   title (miniTitle, bold 15.5) | ♥ (an ENHeartButton with followsPlayback, 44 pt hit area, right of the title) |
//   play/pause (a spinner while loading) | a 2 pt progress line (ENTheme progress; 0.10: along the top, see below).
// 0.10 (Drop 3a, DESIGN-5 §2.1 A2): every colour, font and image is an ENTheme chrome token (the same in both themes; the
// art placeholder is the Light palette's): the art sits in miniArtFrame, the knob is knobImageWithGlyph: (glyph #2f7d1e, a
// pressed knob while touched), and the progress line (miniProgressImage: 2 pt #3f9e22 -> #8fdc5a plus a 5 pt glow below)
// runs along the TOP edge. ENTabBarController slides the whole bar in and out (.25 s).
// The progress line has its OWN 0.5 s timer, running only while the mini player is shown, the app is active and the song is
// playing. Tapping the art or the text calls onTap (ENTabBarController presents Now Playing).
// 0.8.1: swiping the art + text sideways skips like Spotify's mini player: they follow the finger (clipped to their own
// area, so they never slide under the ♥ or play/pause), and past 70 pt (or a quick flick) left = next, right = previous;
// they slide out, the command goes at once, and the next song's art + text slide in from the other side. Shorter drags
// spring back. A Jam guest without control gets a stiff rubber band and no skip (Now Playing's art-swipe rule).
// Main thread only.

@interface ENMiniPlayer : UIView

@property (nonatomic, copy) void (^onTap)(void);

- (void)refresh;                                 // redraw from [ENPlayback shared] (it also observes ENPlaybackChangedNotification)
- (void)setActive:(BOOL)active;                  // shown (ENTabBarController) -> starts / stops the progress timer as above

@end

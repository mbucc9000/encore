#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>

// (0.5 owner: UI.) didFinishLaunching: +[ENCatalog prepareAtLaunch] first, the green appearance, then the tabs when
// paired (no network before the first frame), else pairing. Its remoteControlReceivedWithEvent: stays as the last fallback
// (ENTabBarController is the first responder that normally gets them).
// 0.6 (DESIGN-4b §6.6): on becoming active, after -[ENPlayback appDidBecomeActive], the Jam clipboard watcher
// (+[ENJamActions offerClipboardJam]: no request). URLs: encore://play?uri= as before, and encore://open?u=<percent-encoded
// link> (the EncoreLinks form): a Jam link -> the join prompt, anything else -> playLink:.
// 0.10 (Drop 3a, DESIGN-5 §2.1 A1): +[ENTheme start] right after prepareAtLaunch, before any UI (it replaces the per-launch
// tint and title lines); showMain sets UIStatusBarStyleDefault and showSetup UIStatusBarStyleBlackOpaque (the status-bar
// spike, §4.4 D3a-2). ENColor's body now lives in ENTheme.m (declared here as before).
// 1.0 (Drop 3c, DESIGN-5 §2.3 C5): showMain right after pairing (Setup was the root) plays the .38 s launch zoom (scale
// .15 -> 1, opacity 0 -> 1, Core Animation only) on the tab controller's view; at launch and every other time, none.
@interface ENAppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
- (void)showMain;     // the ENTabBarController (after pairing, or at launch when paired); replaces 0.4's showPlayer
- (void)showSetup;    // pairing (after Unpair)
- (void)reloadInterface;   // Settings → Language: the tabs again in the new language (Settings selected); playback goes on
// (1.1) the tabs' status bar style (showMain; Now Playing puts it back): Default, which iOS 6 tints from the green nav bar;
// iOS 5 has no tinting (Default is the grey bar), so there BlackOpaque, the D3a-2 rule for a grey bar
+ (UIStatusBarStyle)mainStatusBarStyle;
@end

// shared look. ENColor (defined in ENTheme.m) is for ENTheme.m only from 0.10 on (DESIGN-5 P2).
// 1.0 (Drop 3c, C6): the Phase 2 EN_* palette macros (EN_BG … EN_SUB) are gone; a grep found no users after B4
// (Diagnostics) and C5 (Setup). Colours come from ENTheme tokens.
UIColor *ENColor(unsigned rgb);

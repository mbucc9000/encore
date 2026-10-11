#import <UIKit/UIKit.h>

// Phase 2 test player: now playing, transport, quality, play-by-link, and a debug readout.
// 0.5 (owner: UI): the Settings tab (titled "Settings", decided default until Phase 5), otherwise unchanged except that it
// no longer claims first responder (viewDidAppear / dismissKeyboard hand it to ENTabBarController), it keeps its scroll
// view's bottom inset clear of the mini player, and the debug card gains a "Simulate memory warning" button (posts
// UIApplicationDidReceiveMemoryWarningNotification; logs +[ENDiag residentMB] before and after, T-b4).
// 0.6 (DESIGN-4b §6.6, §6.11): a "Jam" row under the quality control (value [ENJam shared].label, tap -> presentJam; "Update
// the gateway to 0.6.0" while ENJam isn't available), and the link field routes a Jam link to ENJamActions' join prompt
// instead of playing it.
// 0.10 (Drop 3a, DESIGN-5 §2.1 A5): until the grouped Settings screen (3b, B4) replaces it as the tab's root, a right bar
// button "Appearance" pushes +[ENChoiceViewController appearanceViewController] (Theme, Text size; the keyboard is dismissed
// first and first responder handed back, as for the Jam row). Its two alerts ("Not a Spotify link", "Unpair this iPhone?")
// are ENAlertViews (same delegate and handling), and its per-screen tint lines are gone: the nav bar and the Auto switch take
// the chrome's appearance, and the quality control shows iOS 6's own bar style. Its EN_* palette stays until B4 (it becomes
// Diagnostics). A6 (0.10): with dark mode deferred (ENTheme.h EN_DARK_MODE 0) the pushed screen shows only Text size; the
// button still says "Appearance".
// 0.11 (Drop 3b, DESIGN-5 §2.2 B4; owner B4): this is now Settings → About → Diagnostics, pushed from ENSettingsViewController
// (B5 makes that the tab's root). Titled "Diagnostics" (the navigation item only, so the tab's own title is never touched);
// every control stays (art, transport, -15 / +30 s, the quality control and Auto, the Jam row, the link field, the debug card,
// Simulate memory warning, Unpair). The temporary Appearance button is gone (Settings → Appearance → Text Size replaces it).
// Its EN_* palette is gone too: a dark page in both themes from ENTheme's chrome tokens (windowBackground, miniPlayerFill
// cards with navTint borders, navTitle / npDeviceSub / npTimeText text, npToggleOn green, +queue's jamRed), the NP cover
// stand-in as the placeholder art and the slider kit (C9) on the scrubber; fonts from +[ENTheme fontOfSize:bold:] (the debug
// readout is Helvetica Neue 10.5 now: ENTheme has no monospaced token). Being pushed, its Unpair alert's assign delegate is
// cleared in dealloc.
@interface ENPlayerViewController : UIViewController <UITextFieldDelegate, UIAlertViewDelegate>
@end

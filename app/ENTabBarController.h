#import <UIKit/UIKit.h>

// The app's root after pairing (owner: UI; DESIGN-3 §5.1). Five UINavigationControllers (0.7), in this order: Home
// (ENHomeViewController, selected at launch), Search (ENSearchViewController), Playlists (ENPlaylistsViewController),
// Library (ENLibraryViewController), Settings (0.11, B5: ENSettingsViewController, titled "Settings"; the old
// ENPlayerViewController is its About → Diagnostics). Green-black tab bar (ENTheme tabBarBackground + tabSelectionIndicator);
// 0.10: finished icons from -[ENTheme finishedTabIconAtIndex:selected:] (the v3 PNG cache: lime gloss on, grey-green off) and
// the tabLabelOff / tabLabelOn / tabLabelFont tokens.
//   - Re-tapping the selected tab: UIKit pops to the root; already at the root -> the root's -scrollToTop
//     (detected in tabBarController:shouldSelectViewController:).
//   - Remote controls (lock screen, AirPods): canBecomeFirstResponder YES, remoteControlReceivedWithEvent: forwards to
//     [ENPlayback shared] handleRemoteEvent:, and it (re)becomes first responder in viewDidAppear:, whenever a keyboard hides
//     (UIKeyboardDidHideNotification: search bars, the link field, the New Playlist alert) and after Now Playing or the
//     Add-to picker is dismissed (-reclaimFirstResponder).
//   - The mini player (ENMiniPlayer, 46 pt) sits in this controller's view directly above the tab bar, shown whenever
//     [ENPlayback shared].track is non-nil; every show/hide posts ENMiniPlayerLayoutNotification. Tapping it presents Now
//     Playing modally from this controller.
//   - 0.6 (DESIGN-4b §6.4): while [ENJam shared].active, the 18 pt ENJamBar sits directly above the mini player (or above
//     the tab bar when the mini player is hidden), raised together with it; its tap -> -presentJam. The overlay height
//     (miniPlayerHeight) is then 0, 18, 46 or 64.
//   - 0.10 (Drop 3a, DESIGN-5 §2.1 A2; owner A2, then B3 / B5): both bars SLIDE in and out (.25 s, ease-out, from their
//     current state) behind the tab bar (the Jam bar behind the mini player while that one stays), and the layout
//     notification is posted inside that animation, so list insets move with them. `hidden` is set only when a hide has
//     finished (and no later show came), and cleared before a show. Raised = above the content, directly under the tab bar
//     (content < Jam bar < mini player < tab bar, the mockup's z-order), after tab switches as before. miniPlayerHeight is
//     the state being slid to. The Jam's navigation bar gets the global green appearance (no tint of its own).
//   - 0.11 (Drop 3b, DESIGN-5 §2.2 B3; owner B3, then B5): the same bar is also the Connect bar. It shows while ENJam is
//     active OR [ENPlayback shared].remoteDevice is set (another device plays, Encore idle); the Jam wins. Connect mode
//     (ENJamBarModeConnect): speakerHi 13 + "Listening on <device>"; its tap presents Now Playing (-presentNowPlaying, the
//     same rules: no modal up, a track; 0.11.1: the device page went with the pager). It
//     contributes 18 to miniPlayerHeight and slides with the mini player exactly like the Jam bar. The Jam text is fitted on
//     ENJamChangedNotification only; the Connect text follows ENPlaybackChangedNotification.
//   - First viewDidAppear: [[ENPlayback shared] start] and [[ENCatalog shared] start] (nothing touches the network before
//     the first frame, §5.7).
// Main thread only.

typedef enum { ENTabHome = 0, ENTabSearch, ENTabPlaylists, ENTabLibrary, ENTabSettings } ENTab;

extern NSString *const ENMiniPlayerLayoutNotification;     // object: the tab controller; userInfo @{ENMiniPlayerHeightKey: @(the
                                                           // overlay height: 0, 18, 46 or 64)}
extern NSString *const ENMiniPlayerHeightKey;

@class ENMiniPlayer;

@interface ENTabBarController : UITabBarController <UITabBarControllerDelegate>

- (id)initAfterLanguageChange;    // (Settings → Language) playback, the catalog and the Jam already run: not started again
+ (ENTabBarController *)shared;                            // the live instance (nil before pairing / after unpairing)

@property (nonatomic, readonly) ENMiniPlayer *miniPlayer;
@property (nonatomic, readonly) CGFloat miniPlayerHeight;   // the overlay over the tab bar: the mini player (46) plus the Jam /
                                                            // Connect bar (18) while each is shown, else 0 (what list insets use)
@property (nonatomic, readonly) UINavigationController *currentNavigationController;   // the selected tab's

- (void)selectTab:(ENTab)tab;
// Pushes vc onto the selected tab's navigation stack, first dismissing Now Playing / any modal if one is up (Now Playing's
// Album / Artist buttons, ••• Go to Album / Go to Artist).
- (void)showViewController:(UIViewController *)vc;
- (void)presentNowPlaying;                                 // the mini player's tap
// (0.6) The Jam screen (ENJamViewController in its own UINavigationController), from the top-most presented controller (Now
// Playing when it is up), else from this one: the Jam bar, Now Playing's pill and Jam button, Settings' Jam row. Nothing
// when one is already up. On its dismissal the controls come back here (reclaimFirstResponder).
- (void)presentJam;
- (void)reclaimFirstResponder;                             // becomeFirstResponder again (lock-screen / AirPods controls)

@end

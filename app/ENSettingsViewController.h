#import "ENGroupedViewController.h"

// The Settings tab (owner: UI; Drop 3b, DESIGN-5 §2.2 B4, 0.11.0; mockup screens.js Screens.settings, styles.css "grouped
// table (settings)"): an ENGroupedViewController titled "Settings" that B5 makes ENTabBarController's tab 4 root. The Phase 2
// screen it replaces lives on, with every control, as About → Diagnostics (ENPlayerViewController). Rows, in the mockup's order
// adapted to what exists (§2.5: no Play On, no separate Away Quality, no engine expiry):
//   - (update notice) Update Available: only while ENUpdateNotice has an update (the bridge's /v1/status `update` names a
//     newer Encore than this app or the bridge), its own section at the top (no header). Value: that version; small text:
//     what to update ("Encore", "Encore Bridge" or both). A tap: -[ENUpdateNotice showAlert] (the same alert as the
//     automatic one, with Open Cydia when this app is the older one). It comes and goes with the catalog-version note.
//   - Encore Bridge (the gateway; D7 names it so on screen): Home Address / Away Address (computer / wifi tiles; host:port). A tap opens an ENAlertView text input, prefilled:
//     Save trims, puts http:// in front when there is no scheme, accepts http or https with a host, then writes
//     -[ENGateway setHomeURL:] / -setAwayURL: and checks the route again (anything else: "Not an Address", nothing saved);
//     Cancel changes nothing. Status (statusOK / statusBad tile; a 9 pt dot before "Home · 14 ms" / "Away · 88 ms" /
//     "Offline"): ENGateway's probe picks the route, then one timed GET / on it gives the latency; on appear, on
//     ENGatewayRouteChangedNotification and on becoming active while shown, one check at a time. Engine (note tile;
//     "Connected" / "Not connected" from the player snapshot's engine.connected; a tap: an alert naming the engine
//     (go-librespot with Encore's patches) and the bridge version; the app is told no engine version).
//   - Playback: Jam (people tile; [ENJam label]; ENUpdateBridgeShortText while unavailable; tap → presentJam),
//     Streaming Quality (the tier's name; its bitrate and any automatic step-down, "· now Normal (auto)", as the small text;
//     → +[ENChoiceViewController qualityViewController]), Auto-Reduce Quality (autoQuality), Pause on Unplug (ENPlayback
//     pauseOnUnplug, default ON), Explicit Badges (+[ENTheme setShowsExplicitBadges:], default ON), Play a Link… (a text
//     alert prefilled from the clipboard when it holds a Spotify or Jam link: a Jam link → +[ENJamActions offerJoinLink:],
//     else -[ENPlayback playLink:], else "Not a Spotify link").
//   - Links (only in a build with EN_ENCORE_LINKS 1, off by default until EncoreLinks ships): Open Spotify Links: writes
//     the BOOL "openLinks" (absent = YES) into the app's own defaults domain (its bundle id) and synchronizes at once, for
//     the EncoreLinks tweak. The app itself never reads it.
//   - Appearance: "Text Size" (a list-glyph tile; Small / Default / Large) → +[ENChoiceViewController
//     appearanceViewController], which shows only Text size while ENTheme.h's EN_DARK_MODE is 0 (dark mode deferred). With
//     EN_DARK_MODE 1 the row is the mockup's "Theme" (moon tile; Light / Dark / Automatic; small "Dark from 7 PM to 7 AM"
//     when Automatic) into the same picker.
//   - Privacy (1.1.0, R2a; RELEASE-PLAN D5): Anonymous Mode (+[ENAnon setOn:]) and, only while it is on, Hide My Playlist
//     Names (+[ENAnon setHidePlaylistsSetting:]); both stored per phone and kept through Unpair. A switch posts
//     ENAnonChangedNotification and the theme note: every screen follows at once, these rows too (the second row comes and
//     goes). While Anonymous Mode is on the addresses show "Hidden" and a tap only says to turn it off first, Spotify shows
//     "Signed in" and This Device the model.
//   - Account: Spotify (your name: the library's me.n at once, then -[ENCatalog loadProfile:]; a tap: "Signed In on Your
//     Encore Bridge"), This Device (the UIDevice name).
//   - Unpair This iPhone (centred, red): "Unpair this iPhone?" [Cancel] [Unpair], then the 0.5 teardown order: this
//     screen's observers off, pause if playing, -[ENGateway unpair], -[ENAppDelegate showSetup] last.
//   - About: Version (the bundle's), Encore Bridge ([ENCatalog shared].gatewayVersion; profiles need 0.10.0), Diagnostics;
//     the mockup's footer plus the unofficial-client notice (D11).
// Updates: the values are rebuilt on playback, Jam, catalog-version and route changes (coalesced to one pass per run-loop
// turn), observed only while the screen is shown and acted on only while the app is active (SET8; becoming active rebuilds
// and checks the route), and applied IN PLACE to the visible rows (heights through beginUpdates / endUpdates) so a switch's
// own animation is never cut by a reload. A palette flip re-skins through the base; a text-size or Explicit Badges change
// (the same palette) only refreshes the values. On appear everything is rebuilt and reloaded. Alerts are ENAlertViews, one
// at a time, with this screen as their delegate (UIAlertView.delegate is assign: dealloc clears it). Remote controls (P6):
// the base hands first responder back to the tab controller in viewDidAppear; a text alert's keyboard ends with the tab
// controller's UIKeyboardDidHide reclaim. Nothing here logs a name, an address or a link. Main thread only.
@interface ENSettingsViewController : ENGroupedViewController <UIAlertViewDelegate>
@end

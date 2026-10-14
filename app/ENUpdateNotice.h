#import <UIKit/UIKit.h>

// The new-version notice (the owner's request of 2026-10-13: "a message in the encore app saying there is a new version
// (cydia and bridge)"). The bridge checks GitHub for new releases (gateway/src/update.js; on Windows the launcher does and
// the bridge relays it) and puts the result in /v1/status `update`: {latest: "X.Y.Z", bridge: true|false} only while it
// holds a signature-verified newer final release (latest = that version; bridge = it is newer than this bridge), else
// null (checks off or failing, nothing newer, a development bridge, an older bridge without the field). ENCatalog's
// version check hands it here with the bridge's own version (-takeStatus:bridgeVersion:).
//   - latest is compared numerically, part by part (1.10.0 > 1.9.0), with this app's CFBundleShortVersionString:
//     appOlder. bridgeOlder = `bridge`. An update applies while either holds; `latest` is then that version, else nil.
//   - A bridge on a final release newer than this app (it was updated first, as the guide says: its own update view
//     then has nothing newer, so `update` is null) counts too, whatever its checks: latest = the bridge's version (when
//     not older than `update`'s), appOlder, and bridgeOlder NO.
//   - The automatic alert comes once per version: dismissing it keeps its version in NSUserDefaults ("updateNoticeSeen"),
//     and only a newer one shows again. It shows only while the app is active, paired, with the tabs as the window's root
//     (never during Setup / pairing), nothing presented over them, no other alert or sheet up, and not before ENJam's
//     first state on a cold launch (the Jam clipboard prompt goes first); otherwise it waits for the next chance: the app
//     becoming active, the main window becoming key again (another alert went away), the tabs appearing again
//     (-mainScreenAppeared: a modal went away), a Jam change or the next status answer.
//       App older:          "Encore X is available" / "Update in Cydia: Changes, then Refresh."; when bridgeOlder too,
//                           the bridge sentence first: "Update Encore Bridge on its computer: …" / "Then update Encore
//                           in Cydia: Changes, then Refresh." (the guide: bridge first). [Later] [Open Cydia]
//                           (cydia://package/com.mbucc9000.encore; the button only when canOpenURL: says the phone takes it).
//       Only bridge older:  "Encore Bridge X is available" / "Update Encore Bridge on its computer: …" [OK].
//     The bridge sentence names no button: Windows has Update now (installer) or Download… (portable zip) on the Encore
//     Bridge icon; the admin page shows how on Docker.
//   - Settings shows an "Update Available" row (its own section, at the top) while an update applies; its tap calls
//     -showAlert: the same alert.
// Versions only: nothing personal is shown, stored or logged (Showcase / Anonymous Mode change nothing here). An ENAlertView
// (the green skin); iOS 5 and 6 alike. Main thread only.
@interface ENUpdateNotice : NSObject <UIAlertViewDelegate>

+ (instancetype)shared;

// /v1/status `update` as parsed (a dictionary; NSNull or nil = none) and `gateway.version` (nil = unknown). Called with
// every status answer; then the automatic alert's chance.
- (void)takeStatus:(id)update bridgeVersion:(NSString *)bridgeVersion;

@property (nonatomic, readonly, copy) NSString *latest;    // the newer version while an update applies, else nil
@property (nonatomic, readonly) BOOL appOlder;             // this app is older than `latest` (Cydia)
@property (nonatomic, readonly) BOOL bridgeOlder;          // the bridge is older than `latest`

// Settings' row: the alert now (nothing when no update applies or this notice's alert is already up). Its dismissal counts
// as seen, as the automatic one's does.
- (void)showAlert;

// ENTabBarController's viewDidAppear: (also after a modal over it went away): a waiting automatic alert may show now
- (void)mainScreenAppeared;

@end

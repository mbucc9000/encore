#import <UIKit/UIKit.h>

// Everything the user does to a Jam, with its prompts, alerts and HUDs (app 0.6; owner: ACTIONS; DESIGN-4b §6.5–§6.9). The
// screens only call these class methods; the state comes from [ENJam shared] (DATA). One live alert at a time per kind; the
// alert / composer delegates are small self-retaining helpers (UIAlertView and MFMessageComposeViewController delegates are
// assign). Nothing here logs a token, link or member id. Main thread only.
// 0.10 (Drop 3a, DESIGN-5 §2.1 A2): the alerts are ENAlertView (the green panel; buttons, field and guards as before), and
// the HUDs carry the C6 glyphs (people for Jam joins and starts, x for a removal, link for Link Copied; else the check).

@class ENJamMember;

@interface ENJamActions : NSObject

// ENTabBarController's first appearance: the guest-tap rule (ENJamGuestPlayNotification: Add to Jam with x.add and a song,
// else "You’re Listening Along" with [Leave Jam] only with x.sc, as the Jam screen's Leave) and the event HUDs of §6.5
// ("Sam joined your Jam", "Jam ended", "You were removed from Sam’s Jam", ...), shown while the app is active whatever
// screen is up; our own actions' echoes are skipped (the action shows its own HUD).
+ (void)startObserving;

// Start (§6.5 A): something loaded on Encore -> HUD "Starting…" + start; nothing loaded but another device plays -> "Play on
// Encore?" (Move = resume, then start once the snapshot shows engine.loaded, ≤ 10 s); nothing anywhere -> "Play Something
// First". 409 jam_elsewhere -> "Already in a Jam"; other failures -> "Couldn’t Start the Jam".
+ (void)startJamFrom:(UIViewController *)vc;
// "Join a Jam…": the paste alert (prefilled when the clipboard holds a Jam link) -> -joinLink:.
+ (void)promptJoin;
// The join flow (§6.6): hosting -> "Join This Jam?" / "Joining another Jam ends yours." first; a guest of another Jam joins
// with replace at once. HUD "Joining…", then "You joined <hn>’s Jam"; jam_active with r "host" -> the same confirmation and
// once more with replace, r "guest" -> once more with replace at once, no r (lim) -> "Couldn’t Join"; jam_not_found /
// bad_link / others -> their alerts. The link of the Jam this phone is in (-[ENJam isCurrentJamLink:]) is never sent:
// "Already in This Jam" / "You’re already in this Jam." (4b-c; joining it would end or leave ours first).
+ (void)joinLink:(NSString *)link;
// encore://open?u= and the Settings link field with a Jam link: "Join This Jam?" / "Open the Jam from this link? You’ll
// listen along on Encore." [Not Now] [Join] (hosting: the hosting confirmation instead; our own Jam's link: as -joinLink:).
+ (void)offerJoinLink:(NSString *)link;
// The clipboard watcher (ENAppDelegate, on becoming active): only when paired, the tabs exist, ENJam is available with
// x.sc, and no alert or sheet is up; -[ENJam clipboardJamLink] decides (no request). Before ENJam's first state has arrived
// (a cold launch), the check runs once when it does (within 30 s).
+ (void)offerClipboardJam;

+ (void)confirmEnd;                                  // "End the Jam?" ... [Cancel] [End] -> HUD "Jam ended"
+ (void)confirmLeave;                                // "Leave the Jam?" ... [Cancel] [Leave] -> HUD "You left the Jam"
+ (void)removeMember:(ENJamMember *)m;               // "Remove <name>?" / "They’ll leave your Jam." [Cancel] [Remove]
                                                     // -> HUD "Removing…" -> "Removed <name>" (4b-c: the captured kick)
+ (void)setGuestsCanControl:(BOOL)on done:(void (^)(BOOL ok))done;   // an alert on failure; done(ok) either way
+ (void)playOnEncore;                                // the away state's "Play on Encore": resume; a 409 jam_moved -> its message
                                                     // (a guest: an alert, since a guest's resume is never sent)

// Invite (§6.8). Message: MFMessageComposeViewController with "Join my Jam on Spotify: <l>" (guest: "Join Sam’s Jam on
// Spotify: <l>"), no recipients, presented from vc; can't send -> "Can’t Send Messages". Copy: the link on the pasteboard,
// -[ENJam noteCopiedLink], HUD "Link Copied".
+ (BOOL)canSendText;
+ (void)messageLinkFrom:(UIViewController *)vc;
+ (void)copyLink;

@end

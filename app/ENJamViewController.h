#import <UIKit/UIKit.h>

// The Jam screen (app 0.6; owner: UI; DESIGN-4b §6.5). Presented by -[ENTabBarController presentJam] in its own
// UINavigationController (green bar, title "Jam", "Done" on the left). A grouped table on #c2cfbb with a pre-rendered green
// hero as its header (rebuilt when the Jam changes; its member avatars are ENAvatarViews over it, their shadows baked in).
// What it shows follows [ENJam shared]:
//   A  no Jam, Start offered (x.sc): hero "Start a Jam"; green "Start a Jam", silver "Join a Jam…"; the Premium footer.
//   A′ no Jam, no x.sc: the same, buttons disabled; "Start a Jam in Spotify on your computer…" (+ the admin page's one-time
//      check while /v1/status jam.sc is still unknown).
//   B  host: avatars, title, "Hosting · N listening"; "Invite friends" (Spotify Code with x.code, Link, Message + Copy Link);
//      "Listening (N)" (avatar, name / You, Host, Remove with x.kick); "Settings" (Guests Can Control with x.gc); End Jam.
//   C  guest: "You’re listening along · N listening"; invite; members; Leave Jam; the fixed "a second or two" footer.
//   L  lim: "Jam on Encore" / "Started in Spotify"; "Show Up Next"; "End it in Spotify on your computer."
//   Away: "Your Jam is playing on another device."; a green "Play on Encore", then End Jam (host). A guest (its resume is
//      never sent, and the gateway refuses one): the Leave Jam row and "Playing on <host>’s Jam elsewhere." instead.
//   W  wait: "Spotify started the Jam but isn’t sending it to Encore yet."; the members when known; End Jam.
//   (4b-c) End Jam and Leave Jam (rows and the away button) only with x.sc: a session known from session_update pushes
//      alone shows its members and the invite, and "End it in Spotify on your computer." ("Leave it …" as a guest) in the
//      row's place. Remove asks first ("Remove <name>?"; the captured kick).
// Every action, alert and HUD is ENJamActions'. While shown: watch:YES (the 20 s lease), pull to refresh = refresh:YES, and it
// is first responder (lock screen / AirPods); on dismissal the controls go back ([ENTabBarController reclaimFirstResponder]).
// Flings run the ENDiag scroll meter ("scroll jam", §6.12).
//
// (0.9.3, DESIGN-JAM-UI.md) The Jam's songs, Spotify's Jam sheet: in B, C, L and Away, once Up Next's queue has answered
// (GET /v1/player/queue, [ENPlayback loadQueue:]; a 404 shows none), the sections after the hero are, each only when it
// has something to show:
//   "Now playing": the queue's `now` (ENJamSongCell: grouped row, 44 pt cover, title, "<artists> · added by <name | you>"
//      and the 22 pt avatar of who added it, the speaker and the green playing look); a tap opens Now Playing (closing
//      the sheet when Now Playing presented it, else after every sheet is down: [ENTabBarController presentNowPlaying]).
//   "Up next": `q` in the engine's order (the same rows, "added by" and avatars), then a green "+ Add songs" row with x.add.
//      Its header carries Edit / Done at the right (silver / green glossy) while this phone may edit.
//   "Next from <ctx.n>": `cq` (in a Jam the Jam's own list, where guests' adds most likely live), all of them as Up Next
//      shows them, the text greyed. Song rows do what Up Next's do on a tap: nothing. Autoplay rows aren't shown.
//   then Invite friends, Listening, Settings, End / Leave as above.
// Editing is Up Next's (DESIGN-4b §6.10), on these rows only: while the queue is `editable` (the gateway's `ed`: the host;
// a guest only while the host lets guests control, if the gateway ever sends it one), Edit turns on UITableView editing
// (the left Done hides): reorder inside a row's own section and the delete control (or a swipe) -> "Remove", on Up next's
// rows and on Next from's while shuffle is off (never Now playing or Add songs). Optimistic, one edit out at a time with
// the rev of the reply before (ENQueueEditor, shared with Up Next); a failure drops the edits behind it, ends edit mode
// (after a drag's drop), puts the gateway's order back and says why in the edited section's footer (for 8 s). Loads and
// rebuilds (Jam changes, the Code and QR arriving) wait while editing, a Remove button is up or an edit is out. Rows from
// an earlier Jam (or replies to its edits) never show in the next one: only once that Jam's own GET has answered.
// Loads: viewWillAppear, pull to refresh (with the Jam's refresh:YES), and while shown the `queue` event, a song change
// (ENPlaybackChangedNotification) and a Jam role change, debounced 300 ms; one more after retry_ms for x rows.
// "Add songs": ENSearchViewController -initForJam in its own UINavigationController over this one (its song taps add to
// the Jam and it stays open); it is closed when the Jam ends or stops taking adds (x.add), also when that happens
// while it slides up.
// (0.11, DESIGN-PROFILES §4.4; owner of this part: PROFILES-APP) While [ENCatalog profilesAvailable] a member row is tappable
// (it highlights): it pushes ENProfileViewController in the Jam's own navigation controller with ignoresMiniPlayer (anyone:
// -initWithUserURI:spotify:user:<member id> name: image:; "You": -init, the user's own profile). Nothing else here changed.
// 1.0 (Drop 3c, DESIGN-5 §2.3 C5; owner C5): looks only, every state and behaviour above unchanged. Every colour and font
// is an ENTheme token (P2: the grouped ones, jamPlayingFill / jamMuted…, the jamHero… ones, qrBorder; no literals): the grouped
// kit's table (the pinstripe, groupedBorder lines), rows as ENGroupedCell draws them (Bold 16.5 labels, values in
// groupedValue, the kit's chevron on Now playing), the green per-position selection instead of the blue one (on the same
// tappable rows), the C7 kit's buttons (wide 44 pt radius 9: Start / Join / Show Up Next / Play on Encore / End Jam; 34 pt
// Message and Copy Link; 28 pt Edit / Done and Remove), the refresh control in refreshTint and no per-screen tint (the switch
// and the "Add songs" bar take the appearance's). The QR card stays white inside qrBorder. Dark mode is off (EN_DARK_MODE
// 0): the screen reads +current when it builds its rows and doesn't observe ENThemeDidChangeNotification (re-skinning in
// place, or moving onto ENGroupedViewController, comes with the dark-mode drop).
// 1.1.0 (R2a, Anonymous Mode, ENAnon.h; RELEASE-PLAN D1): names and pictures come through ENJam and ENJamMember (made-up
// names, initials discs, "Your Jam"); while the mode is on, "Invite friends" holds one green "Show Invite" row (its footer
// says why) until it is tapped: then the QR, the Spotify Code, the Link and Message / Copy Link as before, for that link
// only (a new link, or a switch of the mode, hides them again). ENAnonChangedNotification rebuilds the screen.
// Main thread only.

@interface ENJamViewController : UITableViewController

- (id)init;

@end

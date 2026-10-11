#import "ENListViewController.h"

// Up Next (app 0.6; owner: UI; DESIGN-4b §6.10). Presented by Now Playing in its own UINavigationController (flip), or pushed
// by the Jam screen's "Show Up Next" (lim). Title "Up Next"; "Done" on the left when it is its navigation stack's root (0.11:
// the chevron and the cover button instead, and Edit / Done in a header; see the 0.11 notes below).
//   - A plain list of ENListCell song rows (48 pt, 44 pt thumbnail from the 88 tier) in up to four sections: "Now Playing";
//     the queue ("Jam queue: everyone can add" on the green Jam header in a Jam, else "Next in Queue"); "Next From: <ctx.n>";
//     "Autoplay: similar songs". Empty: "Nothing queued".
//   - In a Jam, a row with `by` reads "<artists> · added by <name | you>" with the member's 22 pt avatar before the •••.
//   - x rows show "Loading…"; the screen asks once more after retry_ms. ••• = the normal sheet (Add to Jam in a Jam).
//     Tapping a row does nothing in 4b (jumping is Phase 5).
//   - Loads: viewWillAppear, pull to refresh, and the `queue` event while visible (debounced 300 ms); a 304 changes nothing.
//     One asked for while a load is out runs once more after it.
//     No mini player inset (it is modal). While shown it is first responder (lock screen / AirPods).
//   - (4b-c, §6.10) Editing while the queue is `editable` (host, or no Jam; never a guest): Edit at the right (the left
//     Done hides while editing), reorder controls inside a row's own section, swipe or the delete control -> "Remove", on
//     the queue and "Next From" rows that have a uid ("Next From" only while the snapshot's shuffle is off; never Now
//     Playing or Autoplay). Optimistic: the rows change at once; the edits go out one at a time (ENPlayback
//     removeQueueRow: / moveQueueRow:), each with the rev of the reply before; a drop at the end of a section precedes the
//     first row a capped reply let in that the screen doesn't show yet.
//     Loads, queue events and the re-poll wait while editing, a Remove button is up or an edit is out, and the newest
//     queue is shown when that ends (never a reload under a drag); a GET sent before an edit is dropped whenever it
//     answers. A failure (queue_changed: a stale rev; or a reply showing more than this phone's own edit) drops the edits
//     behind it, shows a banner, ends edit mode and puts the gateway's order back (then one reload); during a drag it
//     waits for the drop (≤ 3 s), which is refused. Edits still waiting go out after Done / Back too (the screen lives on
//     until its FIFO drains). (0.9.3) The FIFO, rev and reply check are ENQueueEditor's, shared with the Jam screen.
// 0.11 (Drop 3b, DESIGN-5 §2.2 B3, §2.4 #6; owner B3): the dark "flip side". Still a modal UINavigationController (flip) on
// the global green bar; small title "Up Next".
//   - Root (from Now Playing): left a glossy chevDown that closes Up Next AND Now Playing (dismissed from Now Playing's
//     presenter, sliding down; then -[ENTabBarController reclaimFirstResponder]); right a 32 pt glossy button with the
//     playing song's 28 pt cover (88 tier of track.img, else ENPlayback artwork, else the placeholder) that flips back (the
//     0.10 "Done"). Pushed by the Jam screen: the back button, as before.
//   - Edit / Done is the action of the "Next in Queue" header (else of "Next From"; the Jam screen's pattern). While editing
//     the chevron and the cover button (or the back button) hide, so that Done is the only one; a removal that empties the
//     last section able to carry it ends edit mode.
//   - Rows and headers use +[ENTheme queue] (dark in both themes; the Jam queue header keeps jamQueueHeaderImage), and so do
//     the table, its indicator, the refresh tint, the busy spinner and the empty state ("Nothing queued"; this class draws
//     those two itself, overriding -setBusy: and -setEmptyTitle:message:, because the base draws them in +current). Rows
//     show their length (ENListCell showsDuration); queued rows a QUEUE tag and autoplay rows an AUTOPLAY tag, unless a Jam
//     member's avatar takes that place. Tapping a row still does nothing (no jump route, §2.5).
// Main thread only.

@interface ENQueueViewController : ENListViewController

- (id)init;

@end

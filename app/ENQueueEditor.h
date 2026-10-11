#import <Foundation/Foundation.h>

// The Up Next edit queue (4b-c, DESIGN-4b §4.4, §6.10; owner: UI), shared by Up Next (ENQueueViewController) and the Jam
// screen's Up next (0.9.3, DESIGN-JAM-UI.md). The screen applies a remove or a move to its own rows at once (optimistic),
// then hands it here with the q and cq rows it shows after it (+keysForQueued:context:).
//   - One edit out at a time, in order, each with the rev of the reply before it (the first one with the shown queue's,
//     -showing:): a change from elsewhere since then (a guest's add, a skip) changes the rev, so the next edit is refused
//     as stale rather than applied to a list the user didn't see.
//   - A reply may show this phone's own edit and nothing else, or its rev would let the next edit through on a list the
//     user never saw: its q and cq rows must be the ones shown once the edit was applied; only a reply at the 32-row cap whose
//     last rows are q or cq may have more at the end (each removal lets the next row in). Those extra rows are kept
//     (the screen doesn't show them while edits are busy): a move dropped at the end of its section precedes the first
//     of them, so it lands where the screen showed it.
//   - A failed edit, or a reply showing more than the edit, drops every edit behind it and calls the delegate's
//     -queueEditor:didFail: (the screen shows why and puts the gateway's order back from `latest`).
//   - The reply block holds the editor and its delegate strongly: the screen lives on until the FIFO drains, so edits still
//     waiting go out after Done or Back too (their rows are already gone or moved on screen). No cycle: neither keeps the
//     block, and ENPlayback and ENGateway let it go once it has been called.
// No uid, rev or uri is ever logged. Main thread only.

@class ENQueue, ENTrack, ENQueueEditor;

@protocol ENQueueEditorDelegate <NSObject>
// A reply matched: the rows stay as the screen shows them. Called before the next waiting edit goes out (editor.busy is
// then still YES); with none waiting, the edits have settled.
- (void)queueEditorDidApply:(ENQueueEditor *)editor;
// The edits behind it are already dropped. e nil: a reply that showed more than this phone's own edit (handled as
// queue_changed); else the ENCatalogErrorDomain error.
- (void)queueEditor:(ENQueueEditor *)editor didFail:(NSError *)e;
@end

@interface ENQueueEditor : NSObject

@property (nonatomic, weak) id<ENQueueEditorDelegate> delegate;
@property (nonatomic, readonly, strong) ENQueue *latest;     // the gateway's newest queue: the shown one (-showing:), or the
                                                             // last edit reply's (a mismatching one too)
@property (nonatomic, readonly) BOOL busy;                   // an edit is out or waiting
@property (nonatomic, readonly) NSUInteger generation;       // bumped by every edit: a GET sent before it may predate it, so
                                                             // the screen drops its answer

// q and cq rows in order as "q:<uid>" / "c:<uid>": what an edit's reply is compared with
+ (NSArray *)keysForQueued:(NSArray *)queued context:(NSArray *)context;

// The screen now shows q's rows (nil: none): latest = q, the next edit carries its rev, no row past the shown ones.
- (void)showing:(ENQueue *)q;

// context: the row is a "Next From" (cq) row. shown: the keys of the q and cq rows the screen shows with the edit applied.
- (void)remove:(ENTrack *)row context:(BOOL)context shown:(NSArray *)shown;
// before: the row of the same section it now precedes on screen; nil = the end of its section as shown.
- (void)move:(ENTrack *)row before:(ENTrack *)before context:(BOOL)context shown:(NSArray *)shown;

@end

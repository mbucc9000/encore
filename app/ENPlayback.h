#import <UIKit/UIKit.h>
#import "ENStreamPlayer.h"

// The app's player: sends commands to the gateway, opens the stream for each new generation, follows what other
// Spotify devices (PC, Jam guests, the admin page) do to the Encore speaker, and drives the lock screen / AirPods.
// (0.5 owner: DATA.) Main thread only.
// 0.11 (Drop 3b, DESIGN-5 §2.2 B4, one stored flag; owner of this addition: UI B4): `pauseOnUnplug`, Settings → Pause on Unplug.

@class ENTrack, ENQueue;

extern NSString *const ENPlaybackChangedNotification;     // state, track, or artwork changed (main thread; often — compare
                                                           // playingURI yourself to react to song changes only)
extern NSString *const ENTierNames[4];                     // very_high, high, normal, low
extern NSString *const ENQueueChangedNotification;         // (0.6) the gateway's `queue` event: Up Next refetches while visible
extern NSString *const ENPlaybackCommandFailedNotification;   // (0.6) a generation command failed; userInfo: ENPlaybackCommandKey
                                                           // (play / resume / next / prev / seek) and the ENCatalogErrorDomain
                                                           // NSError under ENPlaybackErrorKey (the Jam screen's "Play on Encore"
                                                           // shows a 409 jam_moved's message)
extern NSString *const ENPlaybackCommandKey;
extern NSString *const ENPlaybackErrorKey;

@interface ENPlayback : NSObject <ENStreamPlayerDelegate>

+ (instancetype)shared;

// The song to show: the one being heard (stream marker), else what another device plays, else the paused / engine one.
// Keys: uri, name, artists[], album, cover, duration_ms, context_uri, and from gateway 0.5 img (cover token), album_uri,
// artist_uris[], context_track_uri (the context entry the engine played; absent when unknown). The snapshot's copy also
// has liked (1/0); the stream marker's doesn't.
@property (nonatomic, readonly) NSDictionary *track;
@property (nonatomic, readonly) double positionMs;
@property (nonatomic, readonly) double durationMs;
@property (nonatomic, readonly) BOOL playing;             // play/pause button state
@property (nonatomic, readonly) BOOL loading;             // waiting for a command or the first audio
@property (nonatomic, readonly) BOOL commandPending;      // 0.5: a player command was sent and hasn't answered yet (ENImageCache
                                                          // then keeps to 1 download so the reply never waits for a connection)
@property (nonatomic, readonly) BOOL shuffle;
@property (nonatomic, readonly) NSString *repeatMode;     // off | context | track
@property (nonatomic, readonly) NSDictionary *engine;     // last gateway player snapshot
@property (nonatomic, readonly) NSString *remoteDevice;   // e.g. LIVING-ROOM-PC when another device has playback (Encore idle)
@property (nonatomic, readonly) ENStreamPlayer *stream;
@property (nonatomic, readonly) UIImage *artwork;         // 0.5: the 640 tier from ENImageCache when track has img (held
                                                          // strongly; also the lock screen's); else the old /v1/image?u= path
@property (nonatomic, readonly) NSString *message;        // last problem, for the UI
@property (nonatomic, copy) NSString *tier;               // persisted: the user's pick = the ceiling for automatic quality
@property (nonatomic) BOOL autoQuality;                   // persisted, default YES: step down on a bad network, back up when it recovers
@property (nonatomic, readonly) NSString *activeTier;     // what is streaming now (<= tier)
// (3b) Settings → Pause on Unplug: persisted in NSUserDefaults "encore.pauseOnUnplug", default YES (= the behaviour before
// 0.11). When headphones or AirPods disconnect (route change OldDeviceUnavailable) a playing stream pauses only while YES;
// NO keeps playing on the speaker.
@property (nonatomic) BOOL pauseOnUnplug;

- (void)start;
- (void)appDidBecomeActive;

- (BOOL)playLink:(NSString *)linkOrURI;                   // NO if it doesn't look like a Spotify link
- (void)togglePlayPause;
- (void)pause;
- (void)resume;
- (void)next;
- (void)previous;
- (void)seekTo:(double)ms;
- (void)skipBy:(double)deltaMs;
- (void)toggleShuffle;
- (void)cycleRepeat;

// ---- 0.5 plays (DESIGN-3 §3.5). Each is a generation command like playLink (the old stream closes, loading shows, the new
// generation opens); context plays use a 30 s timeout (the engine may walk the context for 10 s first).
// A list row: {"context_uri": ctx, "offset_uri": uri} — uri MUST be the row's own u from that same list. uri nil = the
// header's Play button ({"context_uri": ctx}: the shuffle mode stays as it is).
- (void)playContext:(NSString *)ctx offsetURI:(NSString *)uri;
- (void)shufflePlayContext:(NSString *)ctx;               // the Shuffle button: {"context_uri": ctx, "shuffle": true}
- (void)playURI:(NSString *)uri;                          // one song (search, Popular, Top Result): {"uri"}; autoplay continues
// ••• Add to Queue: POST /v1/player/queue {"uri"} (not a generation command; 15 s). done(nil) on 200; otherwise an NSError
// in ENCatalogErrorDomain (code = status; 409 + ENCatalogErrorCodeKey "not_active" when nothing is loaded on Encore —
// the caller then offers to play it instead, DESIGN-3 §5.5). done may be nil.
- (void)addToQueue:(NSString *)uri done:(void (^)(NSError *error))done;

// ---- the song being heard (likes, adds, Now Playing ⊕ and ♥, the playing row)
- (NSString *)playingURI;                                 // track.context_track_uri ?: track.uri; nil when there is no track
- (ENTrack *)playingTrack;                                // +[ENTrack trackWithPlaybackTrack:track] (same object until the song
                                                          // changes); nil when there is no track
- (BOOL)isPlayingRow:(ENTrack *)row;                      // row.uri == context_track_uri, or == uri, or the same songKey
                                                          // (name|round(s)); cheap (keys cached per song): cellForRow uses it

- (void)handleRemoteEvent:(UIEvent *)event;               // lock screen / headset. 0.5: from Bluetooth, play / pause / toggle
                                                          // are a plain toggle again (the 0.4.2 press counting is gone)

+ (NSString *)uriFromLink:(NSString *)link;               // 0.6: nil for spotify:socialsession: and spotify:list:jam-list:

// ---- 0.6 Jam (DESIGN-4b §6.3). [ENJam shared] says whether a Jam is on and our role; these rules follow it:
//   - a guest's -pause only stops listening here (the Jam goes on; nothing is sent), and the phone doesn't follow the
//     engine again until the user taps play; a guest's -resume opens the live generation and never sends resume;
//   - an outside pause in any Jam stops here without the played_ms correction (never rewinds the Jam);
//   - a foreign end (ev end with n, or one that isn't our own End's echo), kicked or leave stops the stream at once (no
//     play-out of the lead); our own End keeps it;
//   - a guest without canControl: next / previous / seekTo: / skipBy: / toggleShuffle / cycleRepeat do nothing (logged
//     once), so the lock screen's and AirPods' next / previous are ignored too;
//   - a guest's plays (playContext:offsetURI:, shufflePlayContext:, playURI:, playLink:) send nothing and post
//     ENJamGuestPlayNotification with the song's uri (the offset row's, else the context's).
@property (nonatomic, readonly) BOOL engineLoaded;        // the snapshot's engine.loaded: Encore has something to play (Start)
@property (nonatomic, readonly) BOOL queueMissing;        // GET /v1/player/queue answered 404 (no engine patch 3): no Up Next

// The gen of a Join or End reply (and the End reply's state): opened like a genCommand reply (DATA-internal, ENJam).
- (void)openReplyGeneration:(NSInteger)gen state:(NSDictionary *)state;

// Up Next: GET /v1/player/queue (If-None-Match with the last ETag; 15 s; parsed on ENCatalog's parse queue). done on the
// main thread: (queue, NO, nil) for a new body; (the last queue, YES, nil) for a 304; (nil, NO, error) otherwise
// (ENCatalogErrorDomain; a 404 also sets queueMissing). done may be nil.
- (void)loadQueue:(void (^)(ENQueue *q, BOOL notModified, NSError *e))done;

// ---- 4b-c Up Next edits (DESIGN-4b §4.4, §6.3): engine-local, no Spotify request of their own. POSTs with a 15 s timeout,
// sent once (ENGateway -sendOnceMethod:…: never resent after a network error, which goes to done as it is);
// the reply's `queue` is parsed on ENCatalog's parse queue like loadQueue:'s and becomes the last queue (the next GET is a
// full one: an edit's reply carries no ETag). done on the main thread: (the new queue, with its new rev, nil) or (nil,
// ENCatalogErrorDomain error): 409 queue_changed (a stale rev: reload), not_editable, not_host, unsupported, not_active,
// 503 jam_unavailable, ... A row without a uid, a before without one or a nil rev is never sent (a 400 error, nothing
// requested). No ENLog line carries a uid, rev or uri. done may be nil.
// POST /v1/jam/queue/remove {"uid","rev"}
- (void)removeQueueRow:(ENTrack *)row rev:(NSString *)rev
                  done:(void (^)(ENQueue *q, NSError *e))done;
// POST /v1/jam/queue/move {"uid","before","rev"}: before = the row of the same section it is to precede; nil -> "" (the
// end of that section)
- (void)moveQueueRow:(ENTrack *)row before:(ENTrack *)before rev:(NSString *)rev
                done:(void (^)(ENQueue *q, NSError *e))done;

@end

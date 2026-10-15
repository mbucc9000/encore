#import "ENPlayback.h"
#import "ENCompat.h"
#import "ENGateway.h"
#import "ENDiag.h"
#import "ENCatalog.h"
#import "ENImageCache.h"
#import "ENModel.h"
#import "ENJam.h"
#import "ENUtil.h"
#import "ENAnon.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <MediaPlayer/MediaPlayer.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import "ENL.h"
#include <netinet/in.h>
#include <notify.h>

NSString *const ENPlaybackChangedNotification = @"ENPlaybackChanged";
NSString *const ENTierNames[4] = { @"very_high", @"high", @"normal", @"low" };
NSString *const ENQueueChangedNotification = @"ENQueueChanged";
NSString *const ENPlaybackCommandFailedNotification = @"ENPlaybackCommandFailed";
NSString *const ENPlaybackCommandKey = @"command";
NSString *const ENPlaybackErrorKey = @"error";
static const NSInteger ENTierKbps[4] = { 320, 256, 160, 96 };     // until a stream header says otherwise
static NSString *const ENPauseOnUnplugKey = @"encore.pauseOnUnplug";   // (3b) NSUserDefaults BOOL; absent = YES

static NSString *ENStr(id v) { return [v isKindOfClass:[NSString class]] && [v length] ? v : nil; }
static NSTimeInterval ENNow(void) { return [NSDate timeIntervalSinceReferenceDate]; }

static NSInteger ENTierIndex(NSString *t) {     // 0 = very_high ... 3 = low, -1 = unknown
	for (NSInteger i = 0; i < 4; i++) if ([ENTierNames[i] isEqualToString:t]) return i;
	return -1;
}

typedef enum { ENWantPause = 0, ENWantPlay } ENIntent;

// (1.1, iOS 5) the session's interruptions arrive through its delegate there (the AVAudioSession notifications are iOS 6)
@interface ENPlayback () <AVAudioSessionDelegate>
- (void)routeChangedForReason:(NSUInteger)reason;
- (void)mediaServicesWereReset;
@end

@implementation ENPlayback {
	BOOL _started;
	ENIntent _intent;
	NSInteger _genCmdSeq;          // newest gen-changing command; older replies are ignored
	NSInteger _genCmdInFlight;
	double _loadingPos;            // what to show while a command loads
	NSTimeInterval _ownPauseAt;
	NSTimeInterval _streamOpenedAt;
	NSTimeInterval _engineAt;
	double _pausedPos;             // < 0: none
	NSDictionary *_pausedTrack;
	BOOL _externalPauseScheduled;
	NSInteger _openRetries;

	long long _cursor;
	BOOL _polling, _pollPrimed;
	NSMutableDictionary *_genSeenAt;

	BOOL _interrupted, _resumeAfterInterruption;
	UIBackgroundTaskIdentifier _bgTask;

	NSString *_artURL;             // what _artwork shows: "img:<token>" (640 tier) or the legacy cover URL
	NSString *_artKey;             // ENImageCache key of the 640 load still out for _artURL (cancelled when the song changes)
	NSString *_npURI;
	BOOL _npPlaying;
	double _npPos;
	NSTimeInterval _npAt;
	UIImage *_npArt;
	NSTimer *_heartbeat;

	// automatic quality: _tier is the ceiling, _activeTier what's streaming
	NSString *_activeTier;
	double _upWait;                // s of full buffer before a step up (20; doubles when a step up doesn't hold)
	NSTimeInterval _lastDownAt, _lastUpAt, _lastStallAt, _fullSince;
	double _bufHist[9];            // buffered seconds at 1 Hz: now and the 8 s before
	NSUInteger _bufHistN;

	NSInteger _cmdPending;         // player requests sent and not answered (-commandPending)
	// the song being heard, as an ENTrack (-playingTrack) and as match keys for the playing row (-isPlayingRow:)
	NSDictionary *_ptSrc, *_matchSrc;
	NSString *_ptKey;
	ENTrack *_pt;
	NSString *_matchCtx, *_matchURI, *_matchSongKey;

	// 0.6 Jam (DESIGN-4b §6.3)
	BOOL _jamListenOff;            // a guest stopped listening here: the engine plays the Jam on, the phone doesn't follow it
	BOOL _guestBlockLogged;        // "ignored" logged once per Jam
	NSTimeInterval _noFollowUntil; // after a foreign end / kicked / leave: no automatic listening for a few seconds
	ENQueue *_queue;               // Up Next: the last body and its ETag
	NSString *_queueTag;
	NSString *_jamMessage;         // a Jam error's text set as _message (it can name the host) and its code: while _message
	NSString *_jamMessageCode;     // is that text, /v1/diag gets the code instead (§4.1). (R2a) Any bridge text that can name
	                               // a person, a device or a playlist (+[ENAnon codeNamesSomeone:message:]) is kept the same
	                               // way: never logged, and -message shows the app's own text while Anonymous Mode is on
}

@synthesize message = _message;      // (R2a) its getter is our own

+ (instancetype)shared {
	static ENPlayback *p;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ p = [[ENPlayback alloc] init]; });
	return p;
}

- (instancetype)init {
	if ((self = [super init])) {
		NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
		_tier = [ud stringForKey:@"tier"] ?: @"very_high";
		if (ENTierIndex(_tier) < 0) _tier = @"very_high";
		_autoQuality = [ud objectForKey:@"autoQuality"] ? [ud boolForKey:@"autoQuality"] : YES;
		_pauseOnUnplug = [ud objectForKey:ENPauseOnUnplugKey] ? [ud boolForKey:ENPauseOnUnplugKey] : YES;     // (3b) absent = YES
		_activeTier = _tier;
		_upWait = 20;
		_pausedPos = -1;
		_repeatMode = @"off";
		_bgTask = UIBackgroundTaskInvalid;
		_genSeenAt = [NSMutableDictionary dictionary];
	}
	return self;
}

#pragma mark - startup

- (void)start {
	if (_started) return;
	_started = YES;
	[UIDevice currentDevice].batteryMonitoringEnabled = YES;
	[ENDiag setStatsProvider:^NSDictionary *{ return [self diagStats]; }];
	[ENDiag start];
	[self setupAudioSession];
	[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(jamChanged:) name:ENJamChangedNotification object:nil];
	[[ENJam shared] startObserving];      // its first GET waits for the gateway version (ENCatalog's /v1/status)
	_heartbeat = [NSTimer timerWithTimeInterval:1 target:self selector:@selector(heartbeat) userInfo:nil repeats:YES];
	[[NSRunLoop mainRunLoop] addTimer:_heartbeat forMode:NSRunLoopCommonModes];
	[[ENGateway shared] probe:^(BOOL ok) {
		if (!ok) self->_message = ENL(@"Can't reach your Encore Bridge.");
		[self refreshState];
		[self poll];
	}];
}

- (void)appDidBecomeActive {
	if (!_started) return;
	[[ENGateway shared] probe:^(BOOL ok) {
		[self refreshState];
		[self poll];
	}];
}

- (void)refreshState {
	if (![ENGateway shared].paired) return;
	[[ENGateway shared] sendMethod:@"GET" path:@"/v1/player/state" json:nil timeout:10 completion:^(id j, NSInteger st, NSError *err) {
		if (st == 200 && [j isKindOfClass:[NSDictionary class]]) {
			if ([self->_message hasPrefix:@"Can't reach"] || [self->_message isEqualToString:ENL(@"Can't reach your Encore Bridge.")]
				|| [self->_message isEqualToString:ENL(@"Can't reach your Encore Bridge at either address.")]) self->_message = nil;
			[self takeEngine:j];
			[self followEngine];
		} else {
			[self takeErrorText:j status:st error:err];
		}
		[self changed];
	}];
}

#pragma mark - events long-poll

- (void)poll {
	if (_polling || ![ENGateway shared].paired) return;
	_polling = YES;
	// first call: a cursor past the end makes the gateway answer at once with its current position ('reset')
	long long cur = _pollPrimed ? _cursor : 999999999999LL;
	NSString *path = [NSString stringWithFormat:@"/v1/events?cursor=%lld&timeout=25", cur];
	[[ENGateway shared] sendMethod:@"GET" path:path json:nil timeout:40 completion:^(id j, NSInteger st, NSError *err) {
		self->_polling = NO;
		if (st == 200 && [j isKindOfClass:[NSDictionary class]]) {
			BOOL first = !self->_pollPrimed;
			self->_pollPrimed = YES;
			self->_cursor = [j[@"cursor"] longLongValue];
			if (!first) for (NSDictionary *e in j[@"events"]) if ([e isKindOfClass:[NSDictionary class]]) [self handleEvent:e];
			[self poll];
		} else {
			[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(poll) object:nil];
			[self performSelector:@selector(poll) withObject:nil afterDelay:(st == 401 ? 15 : 3)];
		}
	}];
}

- (void)handleEvent:(NSDictionary *)e {
	NSString *type = ENStr(e[@"type"]);
	NSDictionary *d = [e[@"data"] isKindOfClass:[NSDictionary class]] ? e[@"data"] : nil;
	if ([type isEqualToString:@"reset"]) {          // the gateway restarted
		[self refreshState];
		[[ENCatalog shared] handleEvent:e];
		[[ENJam shared] refresh:NO];
	} else if ([type isEqualToString:@"jam"]) {      // 0.6: the JAM object + ev (DESIGN-4b §4.5)
		[[ENJam shared] handleEvent:e];
	} else if ([type isEqualToString:@"queue"]) {    // 0.6: the engine's queue changed; Up Next refetches while visible
		[[NSNotificationCenter defaultCenter] postNotificationName:ENQueueChangedNotification object:self];
	} else if ([type isEqualToString:@"playlists"] || [type isEqualToString:@"playlist"] || [type isEqualToString:@"liked"] ||
	           [type isEqualToString:@"albums"]) {
		[[ENCatalog shared] handleEvent:e];          // 0.5 catalog events (DESIGN-3 §3.6); 0.9 albums (DESIGN-0.9 §1)
	} else if ([type isEqualToString:@"gen"]) {
		NSInteger g = [d[@"gen"] integerValue];
		_genSeenAt[@(g)] = @(ENNow());
		// someone else (another phone, the admin page) played/seeked/skipped while we're listening: follow
		if (_stream && g > _stream.gen && _genCmdInFlight == 0) [self openGen:g live:NO];
	} else if ([type isEqualToString:@"player"]) {
		[self takeEngine:d];
		[self followEngine];
		[self changed];
	} else if ([type isEqualToString:@"engine_error"]) {
		_message = ENL(@"Spotify couldn't play that.");
		ENLog(@"engine error: %@", ENStr(d[@"message"]) ?: @"?");
		[self changed];
	} else if ([type isEqualToString:@"notice"]) {
		// (R2a) a notice can name a device (jam_away): only its code is logged
		NSString *m = ENStr(d[@"message"]), *code = ENStr(d[@"code"]) ?: @"notice";
		if (m) {
			_message = m;
			_jamMessage = m;
			_jamMessageCode = code;
		}
		ENLog(@"gateway notice: %@", code);
		[self changed];
	}
}

- (void)takeEngine:(NSDictionary *)s {
	if (![s isKindOfClass:[NSDictionary class]]) return;
	_engine = s;
	_engineAt = ENNow();
	_shuffle = [s[@"shuffle"] boolValue];
	_repeatMode = ENStr(s[@"repeat"]) ?: @"off";
	// the snapshot's song carries its saved state (`liked`, 1/0) since gateway 0.5: the hearts' cache
	if ([s[@"track"] isKindOfClass:[NSDictionary class]]) [[ENCatalog shared] noteSnapshotTrack:s[@"track"]];
	[[ENJam shared] noteSnapshot:ENJDict(s[@"jam"])];     // 0.6: a Jam appeared, changed or ended -> GET /v1/jam
}

// The Encore speaker is this phone. When another device (a computer, a Jam guest) starts or stops it, do the same here.
- (void)followEngine {
	if (_genCmdInFlight > 0 || _interrupted || ![ENGateway shared].paired) return;
	NSString *st = ENStr(_engine[@"status"]);
	BOOL enginePlaying = [st isEqualToString:@"playing"] || [st isEqualToString:@"loading"];   // loading = a command is running
	NSTimeInterval now = ENNow();
	if (_stream) {
		if (!enginePlaying && now - _streamOpenedAt > 3 && !_externalPauseScheduled) {
			_externalPauseScheduled = YES;
			// Paused elsewhere or moved to another device: stop right away (after a short debounce).
			// The queue simply ran out: the buffer still holds the end of the last song (up to the whole lead), so let it play out.
			double delay = [self engineRanOut] ? MIN(_stream.bufferedSeconds + 0.5, MAX(15.0, _stream.leadSeconds + 3.0)) : 0.6;
			[self performSelector:@selector(externalPauseCheck) withObject:nil afterDelay:delay];
		}
		return;
	}
	if (enginePlaying && now - _ownPauseAt > 2.5 && ![self holdFollow]) {
		NSInteger g = [_engine[@"gen"] integerValue];
		NSNumber *seen = _genSeenAt[@(g)];
		BOOL fresh = seen && now - seen.doubleValue < 6;     // a brand-new generation: hear it from its start
		[self openGen:g live:!fresh];
	}
}

- (BOOL)engineGone {     // another device took playback: Encore's player has nothing loaded
	NSDictionary *e = [_engine[@"engine"] isKindOfClass:[NSDictionary class]] ? _engine[@"engine"] : nil;
	return e && ![e[@"loaded"] boolValue] && ![e[@"active"] boolValue];
}

- (BOOL)engineRanOut { return [ENStr(_engine[@"status"]) isEqualToString:@"stopped"] && ![self engineGone]; }

// Is more audio coming? Not once the queue ended or it was paused elsewhere: then the buffer drains on purpose.
- (BOOL)engineFeeding {
	NSString *st = ENStr(_engine[@"status"]);
	return [st isEqualToString:@"playing"] || [st isEqualToString:@"loading"];
}

- (void)externalPauseCheck {
	_externalPauseScheduled = NO;
	NSString *st = ENStr(_engine[@"status"]);
	if (!_stream || _genCmdInFlight || [st isEqualToString:@"playing"] || [st isEqualToString:@"loading"]) return;
	BOOL gone = [self engineGone], ranOut = [self engineRanOut];
	ENLog(@"%@", gone ? @"playback moved to another device: stopping here" : ranOut ? @"the queue ended" : @"paused from another device");
	// paused elsewhere: put the engine back to what we actually heard. 0.6: never in a Jam, where that seek would move the
	// whole Jam back (DESIGN-4b §0, §6.3)
	[self pauseTellingGateway:!gone && !ranOut && ![ENJam shared].active];
}

#pragma mark - 0.6 Jam rules (DESIGN-4b §6.3)

- (BOOL)jamGuest {
	ENJam *jam = [ENJam shared];
	return jam.active && jam.guest;
}

// A guest without playback control: transport commands do nothing here (the gateway would refuse them anyway, §4.4).
- (BOOL)guestBlocked:(NSString *)what {
	ENJam *jam = [ENJam shared];
	if (!jam.active || !jam.guest || jam.canControl) return NO;
	if (!_guestBlockLogged) {
		_guestBlockLogged = YES;
		ENLog(@"jam: %@ ignored (a guest without playback control)", what);
	}
	return YES;
}

// A guest's play sends nothing: ENJamActions offers Add to Jam or Leave (§6.9).
- (BOOL)guestPlays:(NSString *)uri {
	if (![self jamGuest]) return NO;
	ENLog(@"jam: a guest's play goes to Add to Jam / Leave");
	[[NSNotificationCenter defaultCenter] postNotificationName:ENJamGuestPlayNotification object:self
	                                                  userInfo:(uri ? @{ ENJamURIKey: uri } : nil)];
	return YES;
}

// Don't start listening on our own while a guest chose to stop, or right after a Jam ended under us.
- (BOOL)holdFollow {
	if (ENNow() < _noFollowUntil) return YES;
	return _jamListenOff && [ENJam shared].active;
}

- (void)jamChanged:(NSNotification *)n {
	if (![ENJam shared].active) {
		_jamListenOff = NO;
		_guestBlockLogged = NO;
	}
	NSDictionary *ev = [n.userInfo[ENJamEventKey] isKindOfClass:[NSDictionary class]] ? n.userInfo[ENJamEventKey] : nil;
	NSString *k = ENStr(ev[@"k"]);
	BOOL own = [n.userInfo[ENJamOwnEventKey] boolValue];
	// a Jam ended elsewhere, being removed, or leaving: stop at once, no play-out of the lead (§5.6). An end carries n only
	// when we were a guest; one that isn't the echo of our own End (a host's or a lim Jam's, ended from Spotify on another device)
	// is foreign too. Our own End keeps the music going (§5.7 End).
	BOOL stop = [k isEqualToString:@"kicked"] || [k isEqualToString:@"leave"]
		|| ([k isEqualToString:@"end"] && (ENStr(ev[@"n"]) || !own));
	if (!stop) return;
	_noFollowUntil = ENNow() + 15;
	if (_stream || _genCmdInFlight) {
		ENLog(@"jam %@: stopping here", k);
		[self pauseTellingGateway:NO];
	}
}

- (void)openReplyGeneration:(NSInteger)gen state:(NSDictionary *)state {
	if ([state isKindOfClass:[NSDictionary class]]) [self takeEngine:state];
	_jamListenOff = NO;
	_noFollowUntil = 0;
	if (gen > 0 && !_genCmdInFlight) {
		_loadingPos = 0;
		[self openGen:gen live:NO];
		return;
	}
	[self changed];
}

- (BOOL)engineLoaded {
	NSDictionary *e = [_engine[@"engine"] isKindOfClass:[NSDictionary class]] ? _engine[@"engine"] : nil;
	return [e[@"loaded"] boolValue];
}

- (void)loadQueue:(void (^)(ENQueue *q, BOOL notModified, NSError *e))done {
	void (^d)(ENQueue *, BOOL, NSError *) = [done copy];
	NSString *tag = _queue ? _queueTag : nil;
	[[ENGateway shared] fetchData:@"/v1/player/queue" etag:tag timeout:15 completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		if (st == 304) {
			if (d) d(self->_queue, YES, nil);
			return;
		}
		if (st == 200 && data.length) {
			[[ENCatalog shared] parseOnQueue:^{
				ENQueue *q = [ENQueue queueWithJSON:[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL]];
				dispatch_async(dispatch_get_main_queue(), ^{
					if (!q) {
						if (d) d(nil, NO, [ENCatalog errorWithJSON:nil status:502 error:nil]);
						return;
					}
					self->_queue = q;
					self->_queueTag = [etag copy];
					if (self->_queueMissing) { self->_queueMissing = NO; [self changed]; }
					if (d) d(q, NO, nil);
				});
			}];
			return;
		}
		id j = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
		NSError *e = [ENCatalog errorWithJSON:j status:st error:err];
		if (st == 404 && !self->_queueMissing) {
			self->_queueMissing = YES;        // an engine without patch 3 (or an older gateway): Now Playing hides Up Next
			ENLog(@"up next: not available (404)");
			[self changed];
		}
		if (d) d(nil, NO, e);
	}];
}

// 4b-c Up Next edits (DESIGN-4b §4.4): the reply's queue replaces the last one. Its ETag isn't known (the reply has none),
// so the next loadQueue: is a full GET rather than a 304 that would hand back this reply under another body's tag. Sent
// once (-sendOnceMethod:…): a network error is never resent with the same rev (a done edit would come back as a false
// queue_changed); Up Next's rollback and reload settle it.
- (void)removeQueueRow:(ENTrack *)row rev:(NSString *)rev done:(void (^)(ENQueue *q, NSError *e))done {
	NSString *uid = ENStr(row.uid);
	[self editQueue:@"remove" body:(uid && ENStr(rev) ? @{ @"uid": uid, @"rev": rev } : nil) done:done];
}

- (void)moveQueueRow:(ENTrack *)row before:(ENTrack *)before rev:(NSString *)rev done:(void (^)(ENQueue *q, NSError *e))done {
	NSString *uid = ENStr(row.uid), *b = before ? ENStr(before.uid) : @"";
	[self editQueue:@"move" body:(uid && b && ENStr(rev) ? @{ @"uid": uid, @"before": b, @"rev": rev } : nil) done:done];
}

// (DESIGN-QUEUE §4.2) Play Next: the reply is {queue, uid}; uid is the row's uid now (a cq / ap row gets a new q<n> one)
- (void)topQueueRow:(ENTrack *)row rev:(NSString *)rev done:(void (^)(ENQueue *q, NSString *uid, NSError *e))done {
	void (^d)(ENQueue *, NSString *, NSError *) = [done copy];
	NSString *uid = ENStr(row.uid);
	[self editQueue:@"top" body:(uid && ENStr(rev) ? @{ @"uid": uid, @"rev": rev } : nil) reply:^(ENQueue *q, id j, NSError *e) {
		if (!d) return;
		if (!q) {
			d(nil, nil, e);
			return;
		}
		ENTrack *first = q.queued.count ? q.queued[0] : nil;     // (iOS 6 SDK: no -firstObject)
		d(q, ENStr(ENJDict(j)[@"uid"]) ?: ENStr(first.uid), nil);
	}];
}

- (void)editQueue:(NSString *)op body:(NSDictionary *)body done:(void (^)(ENQueue *q, NSError *e))done {
	void (^d)(ENQueue *, NSError *) = [done copy];
	[self editQueue:op body:body reply:^(ENQueue *q, id j, NSError *e) {
		if (d) d(q, e);
	}];
}

// body nil: a row (or before) without a uid, or no rev: nothing is sent. done gets the reply's whole JSON too (top's uid).
- (void)editQueue:(NSString *)op body:(NSDictionary *)body reply:(void (^)(ENQueue *q, id j, NSError *e))done {
	void (^d)(ENQueue *, id, NSError *) = [done copy];
	if (!body) {
		NSDictionary *j = @{ @"error": @{ @"code": @"bad_request", @"message": ENL(@"This song can’t be moved or removed.") } };
		NSError *e = [ENCatalog errorWithJSON:j status:400 error:nil];
		ENLog(@"up next: %@ not sent (no uid or rev)", op);
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(nil, nil, e); });
		return;
	}
	NSTimeInterval t0 = ENNow();
	[self commandBegan];
	[[ENGateway shared] sendOnceMethod:@"POST" path:[@"/v1/jam/queue/" stringByAppendingString:op] json:body timeout:15
	                        completion:^(id j, NSInteger st, NSError *err) {
		[self commandEnded];
		NSDictionary *qj = st == 200 ? ENJDict(ENJDict(j)[@"queue"]) : nil;
		if (qj) {
			[[ENCatalog shared] parseOnQueue:^{
				ENQueue *q = [ENQueue queueWithJSON:qj];
				dispatch_async(dispatch_get_main_queue(), ^{
					if (!q) {
						if (d) d(nil, nil, [ENCatalog errorWithJSON:nil status:502 error:nil]);
						return;
					}
					ENLog(@"up next: %@ ok in %.0f ms", op, (ENNow() - t0) * 1000);     // no uid, rev or uri
					self->_queue = q;
					self->_queueTag = nil;
					if (d) d(q, j, nil);
				});
			}];
			return;
		}
		NSError *e = [ENCatalog errorWithJSON:(st == 200 ? nil : j) status:(st == 200 ? 502 : st) error:err];
		ENLog(@"up next: %@ failed: %ld %@", op, (long)st, [ENCatalog codeOfError:e] ?: @"");
		if (d) d(nil, nil, e);
	}];
}

// (DESIGN-QUEUE §5.1) tap to jump: a generation command like next, addressed by the row's uid (never logged)
- (BOOL)jumpToRow:(ENTrack *)row done:(void (^)(NSError *e))done {
	NSString *uid = ENStr(row.uid);
	if (!uid || [self jamGuest]) {
		ENLog(@"up next: jump not sent (%@)", uid ? @"a Jam guest" : @"no uid");
		return NO;
	}
	_loadingPos = 0;
	[self genCommand:@"jump" body:@{ @"uid": uid } timeout:20 done:done];
	return YES;
}

#pragma mark - commands

// (R2a) the bridge's error text as _message; one that can name someone is marked (its code goes to logs and /v1/diag, and
// -message shows the app's own text while Anonymous Mode is on)
- (void)takeErrorText:(id)j status:(NSInteger)st error:(NSError *)err {
	NSString *text = [self errorText:j status:st error:err];
	NSDictionary *e = [j isKindOfClass:[NSDictionary class]] && [j[@"error"] isKindOfClass:[NSDictionary class]] ? j[@"error"] : nil;
	NSString *code = ENStr(e[@"code"]);
	_message = text;
	BOOL named = text && [ENAnon codeNamesSomeone:code message:text];
	_jamMessage = named ? text : nil;
	_jamMessageCode = named ? code : nil;
}

// (R2a) what the UI shows: a marked bridge text as the app's own words while Anonymous Mode is on
- (NSString *)message {
	if (_message && _message == _jamMessage && [ENAnon on]) return [ENAnon bridgeText:_message code:_jamMessageCode];
	return _message;
}

- (NSString *)errorText:(id)j status:(NSInteger)st error:(NSError *)err {
	NSString *m = [j isKindOfClass:[NSDictionary class]] && [j[@"error"] isKindOfClass:[NSDictionary class]] ? ENStr(j[@"error"][@"message"]) : nil;
	if (st == 401) return ENL(@"Your Encore Bridge doesn't know this phone any more. Unpair and pair again.");
	if (m) return m;
	if (err) return [ENGateway shared].baseURL ? ENL(@"Can't reach your Encore Bridge.") : err.localizedDescription;
	return [NSString stringWithFormat:ENL(@"Encore Bridge error %ld"), (long)st];
}

// 0.5: commandPending covers every player request, so ENImageCache keeps to one download and the reply never waits for a
// free connection (T-b6); when the last one is answered, held-back covers start.
- (BOOL)commandPending { return _cmdPending > 0; }

- (void)commandBegan { _cmdPending++; }

- (void)commandEnded {
	if (_cmdPending > 0) _cmdPending--;
	if (!_cmdPending) [[ENImageCache shared] pump];
}

- (void)genCommand:(NSString *)name body:(NSDictionary *)body timeout:(NSTimeInterval)timeout {
	[self genCommand:name body:body timeout:timeout done:nil];
}

// done (may be nil): once the reply is in, nil on success or when a newer command superseded this one, else the error
// (DESIGN-QUEUE: Up Next's jump waits for it)
- (void)genCommand:(NSString *)name body:(NSDictionary *)body timeout:(NSTimeInterval)timeout done:(void (^)(NSError *e))done {
	void (^fin)(NSError *) = [done copy];
	// the song we're actually hearing: the gateway's player runs ahead of us and may already be on the next one
	NSString *audible = ENStr(self.track[@"uri"]);
	NSTimeInterval t0 = ENNow();
	NSInteger seq = ++_genCmdSeq;
	_genCmdInFlight++;
	_intent = ENWantPlay;
	_loading = YES;
	_message = nil;
	_pausedPos = -1;
	_pausedTrack = nil;
	[self closeStream];
	[self activateSession];
	[self beginBackgroundTask];
	[self changed];
	NSMutableDictionary *b = [NSMutableDictionary dictionaryWithDictionary:body ?: @{}];
	b[@"q"] = [self tierToOpen];      // lets the gateway warm up this quality's encoder before the new audio starts
	if (audible && ![name isEqualToString:@"play"]) b[@"uri"] = audible;
	[self commandBegan];
	[[ENGateway shared] sendMethod:@"POST" path:[@"/v1/player/" stringByAppendingString:name] json:b timeout:timeout completion:^(id j, NSInteger st, NSError *err) {
		self->_genCmdInFlight--;
		[self commandEnded];
		if (seq != self->_genCmdSeq) {           // superseded by a newer tap
			if (fin) fin(nil);
			return;
		}
		if (st != 200 || ![j isKindOfClass:[NSDictionary class]]) {
			NSError *e = [ENCatalog errorWithJSON:j status:st error:err];
			NSString *code = [ENCatalog codeOfError:e];
			// 0.6: a Jam error's text can name the host (jam_no_control, in_jam): ENLog and /v1/diag get its code (§4.1);
			// (R2a) so does any other bridge text that can name someone
			NSString *text = [self errorText:j status:st error:err];
			BOOL jamText = [code hasPrefix:@"jam_"] || [code isEqualToString:@"in_jam"] || [ENAnon codeNamesSomeone:code message:text];
			// (DESIGN-QUEUE §5.1) a refused jump mostly comes from the bridge's pre-check or its cut mode, where the engine
			// never paused: its text is Up Next's (not put on Now Playing), and while the snapshot says the engine still
			// plays, the phone listens to it again instead of stopping
			BOOL jump = [name isEqualToString:@"jump"];
			self->_loading = NO;
			self->_intent = ENWantPause;
			if (!jump) {
				self->_message = text;
				self->_jamMessage = jamText ? self->_message : nil;
				self->_jamMessageCode = jamText ? code : nil;
			}
			ENLog(@"command %@ failed after %.0f ms: %ld %@", name, (ENNow() - t0) * 1000, (long)st,
				(jamText || jump) ? (code ?: @"") : self->_message);
			[ENDiag flushSoon];
			NSInteger live = jump && [self engineFeeding] && !self->_stream ? [self->_engine[@"gen"] integerValue] : 0;
			if (live > 0) {
				[self openGen:live live:YES];
			} else {
				[self endBackgroundTask];
				[self changed];
			}
			[[NSNotificationCenter defaultCenter] postNotificationName:ENPlaybackCommandFailedNotification object:self
			                                                  userInfo:@{ ENPlaybackCommandKey: name, ENPlaybackErrorKey: e }];
			if (fin) fin(e);
			return;
		}
		ENLog(@"command %@ -> gen %@ in %.0f ms", name, j[@"gen"], (ENNow() - t0) * 1000);
		[self takeEngine:j[@"state"]];
		[self openGen:[j[@"gen"] integerValue] live:NO];
		if (fin) fin(nil);
	}];
}

- (void)openGen:(NSInteger)gen live:(BOOL)live {
	if (gen <= 0) return;
	if (_stream && _stream.gen == gen && _stream.state != ENStreamFailed) return;
	[self closeStream];
	[self activateSession];
	[self beginBackgroundTask];
	ENGateway *gw = [ENGateway shared];
	NSString *tier = [self tierToOpen];
	_activeTier = tier;
	_fullSince = 0;
	_bufHistN = 0;
	// Start fast (the gateway bursts its whole 10-20 s lead right away); after running dry, wait for more before restarting.
	_stream = [[ENStreamPlayer alloc] initWithGen:gen tier:tier live:live prebuffer:(gw.away ? 2.0 : 1.0) rebuffer:(gw.away ? 4.0 : 2.5)];
	_stream.delegate = self;
	_streamOpenedAt = ENNow();
	_intent = ENWantPlay;
	_loading = YES;
	_pausedPos = -1;
	_pausedTrack = nil;
	ENLog(@"opening gen %ld%@ (%@%@, %@, %@)", (long)gen, live ? @" live" : @"", tier, [tier isEqualToString:_tier] ? @"" : @" auto",
		gw.away ? @"away" : @"home", [self networkType]);
	[_stream start];
	[self changed];
}

- (void)closeStream {
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(externalPauseCheck) object:nil];
	_externalPauseScheduled = NO;
	_stream.delegate = nil;
	[_stream stop];
	_stream = nil;
}

- (BOOL)playing { return _intent == ENWantPlay; }

- (void)togglePlayPause {
	if (_intent == ENWantPlay) [self pause];
	else [self resume];
}

- (void)pause {
	if ([self jamGuest]) {             // 0.6: a guest stops listening; the Jam goes on without this phone (nothing is sent)
		_jamListenOff = YES;
		[self pauseTellingGateway:NO];
		return;
	}
	[self pauseTellingGateway:YES];
}

- (void)pauseTellingGateway:(BOOL)tell {
	double pos = self.positionMs;           // what was actually heard, before the stream goes away
	NSDictionary *t = self.track;
	BOOL hadAudio = _stream.hasPosition;
	_genCmdSeq++;                           // any command still loading is moot now
	_intent = ENWantPause;
	_loading = NO;
	_ownPauseAt = ENNow();
	[self closeStream];
	_pausedPos = pos;
	_pausedTrack = t;
	[self endBackgroundTask];
	[self changed];
	if (!tell) return;
	NSMutableDictionary *body = [NSMutableDictionary dictionary];
	if (hadAudio) {
		// the gateway's player is ahead of us by our buffer; this puts it back to where we stopped hearing it
		body[@"played_ms"] = @(round(pos));
		if (ENStr(t[@"uri"])) body[@"uri"] = t[@"uri"];
	}
	[self commandBegan];
	[[ENGateway shared] sendMethod:@"POST" path:@"/v1/player/pause" json:body timeout:15 completion:^(id j, NSInteger st, NSError *err) {
		[self commandEnded];
		if (st == 200 && [j isKindOfClass:[NSDictionary class]]) [self takeEngine:j[@"state"]];
		else [self takeErrorText:j status:st error:err];
		[self changed];
	}];
}

- (void)resume {
	if (_intent == ENWantPlay && (_stream || _genCmdInFlight)) return;
	_jamListenOff = NO;
	_noFollowUntil = 0;
	if (!_stream && [ENStr(_engine[@"status"]) isEqualToString:@"playing"]) {   // already playing (started elsewhere): just listen
		[self openGen:[_engine[@"gen"] integerValue] live:YES];
		return;
	}
	if ([self jamGuest]) {             // 0.6: a guest never sends resume: the Jam plays when its host says so
		if (!_stream && [self engineFeeding]) { [self openGen:[_engine[@"gen"] integerValue] live:YES]; return; }
		// no names: _message goes to /v1/diag (§4.1)
		_message = [ENJam shared].away ? ENL(@"Your Jam is playing on another device.") : ENL(@"The Jam is paused.");
		[self changed];
		return;
	}
	if (!self.track) { _message = ENL(@"Nothing to resume yet. Paste a Spotify link below."); [self changed]; return; }
	_loadingPos = self.positionMs;
	[self genCommand:@"resume" body:nil timeout:20];
}

- (void)next {
	if ([self guestBlocked:@"next"]) return;
	_loadingPos = 0;
	[self genCommand:@"next" body:nil timeout:20];
}

- (void)previous {
	if ([self guestBlocked:@"previous"]) return;
	double pos = self.positionMs;
	if (pos > 3000) { [self seekTo:0]; return; }   // like Spotify: first press restarts the song
	_loadingPos = 0;
	[self genCommand:@"prev" body:@{ @"played_ms": @(round(pos)) } timeout:20];
}

- (void)seekTo:(double)ms {
	if ([self guestBlocked:@"seek"]) return;
	double dur = self.durationMs;
	if (dur > 0) ms = MIN(ms, dur - 1000);
	ms = MAX(0, ms);
	if (_intent == ENWantPause && !_genCmdInFlight) {   // stay paused, just move
		_pausedPos = ms;
		[self changed];
		NSMutableDictionary *b = [NSMutableDictionary dictionaryWithObject:@(round(ms)) forKey:@"position_ms"];
		b[@"paused"] = @YES;
		if (ENStr(self.track[@"uri"])) b[@"uri"] = self.track[@"uri"];
		[self commandBegan];
		[[ENGateway shared] sendMethod:@"POST" path:@"/v1/player/seek" json:b timeout:15 completion:^(id j, NSInteger st, NSError *err) {
			[self commandEnded];
			if (st == 200 && [j isKindOfClass:[NSDictionary class]]) [self takeEngine:j[@"state"]];
			[self changed];
		}];
		return;
	}
	_loadingPos = ms;
	[self genCommand:@"seek" body:@{ @"position_ms": @(round(ms)) } timeout:20];
}

- (void)skipBy:(double)deltaMs { [self seekTo:self.positionMs + deltaMs]; }

- (void)toggleShuffle {
	if ([self guestBlocked:@"shuffle"]) return;
	BOOL on = !_shuffle;
	_shuffle = on;
	[self changed];
	[self commandBegan];
	[[ENGateway shared] sendMethod:@"POST" path:@"/v1/player/shuffle" json:@{ @"on": @(on) } timeout:15 completion:^(id j, NSInteger st, NSError *err) {
		[self commandEnded];
		if (st == 200 && [j isKindOfClass:[NSDictionary class]]) [self takeEngine:j[@"state"]];
		[self changed];
	}];
}

- (void)cycleRepeat {
	if ([self guestBlocked:@"repeat"]) return;
	NSString *m = [_repeatMode isEqualToString:@"off"] ? @"context" : [_repeatMode isEqualToString:@"context"] ? @"track" : @"off";
	_repeatMode = m;
	[self changed];
	[self commandBegan];
	[[ENGateway shared] sendMethod:@"POST" path:@"/v1/player/repeat" json:@{ @"mode": m } timeout:15 completion:^(id j, NSInteger st, NSError *err) {
		[self commandEnded];
		if (st == 200 && [j isKindOfClass:[NSDictionary class]]) [self takeEngine:j[@"state"]];
		[self changed];
	}];
}

+ (NSString *)uriFromLink:(NSString *)link {
	NSString *s = [link stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	if ([s hasPrefix:@"spotify:"]) {
		if ([s hasPrefix:@"spotify:episode:"] || [s hasPrefix:@"spotify:show:"]) return nil;   // no podcasts
		// 0.6: a Jam is joined (ENJamActions), never played; a Jam's list answers 403 to anyone outside it
		if ([s hasPrefix:@"spotify:socialsession:"] || [s hasPrefix:@"spotify:list:jam-list:"]) return nil;
		// a profile (spotify:user:<id>) isn't something to play (its legacy :playlist: and :collection uris are)
		if (ENUserIDFromURI(s)) return nil;
		return s;
	}
	NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:
		@"open\\.spotify\\.com/(?:intl-[A-Za-z-]+/)?(?:embed/)?(track|album|playlist|artist)/([A-Za-z0-9]{22})" options:0 error:NULL];
	NSTextCheckingResult *m = [re firstMatchInString:s options:0 range:NSMakeRange(0, s.length)];
	if (!m) return nil;
	return [NSString stringWithFormat:@"spotify:%@:%@", [s substringWithRange:[m rangeAtIndex:1]], [s substringWithRange:[m rangeAtIndex:2]]];
}

- (BOOL)playLink:(NSString *)link {
	NSString *uri = [ENPlayback uriFromLink:link];
	if (!uri) return NO;
	if ([self guestPlays:uri]) return YES;
	_loadingPos = 0;
	BOOL track = [uri hasPrefix:@"spotify:track:"];
	[self genCommand:@"play" body:(track ? @{ @"uri": uri } : @{ @"context_uri": uri }) timeout:(track ? 20 : 30)];
	return YES;
}

#pragma mark - 0.5 plays (DESIGN-3 §3.5)

// A list row ({context_uri, offset_uri}: the row's own u) or the Play button (no offset: the shuffle mode stays). The
// engine may walk the context for up to 10 s first, and the gateway waits up to 15 s for the new song: 30 s here.
- (void)playContext:(NSString *)ctx offsetURI:(NSString *)uri {
	if (!ENStr(ctx)) return;
	if ([self guestPlays:(ENStr(uri) ?: ctx)]) return;
	_loadingPos = 0;
	NSMutableDictionary *b = [NSMutableDictionary dictionaryWithObject:ctx forKey:@"context_uri"];
	if (ENStr(uri)) b[@"offset_uri"] = uri;
	[self genCommand:@"play" body:b timeout:30];
}

- (void)shufflePlayContext:(NSString *)ctx {
	if (!ENStr(ctx)) return;
	if ([self guestPlays:ctx]) return;
	_loadingPos = 0;
	[self genCommand:@"play" body:@{ @"context_uri": ctx, @"shuffle": @YES } timeout:30];    // a JSON boolean, not 1
}

- (void)playURI:(NSString *)uri {
	if (!ENStr(uri)) return;
	if ([self guestPlays:uri]) return;
	_loadingPos = 0;
	[self genCommand:@"play" body:@{ @"uri": uri } timeout:20];
}

// Not a generation command: the song goes after the current one, nothing restarts.
- (void)addToQueue:(NSString *)uri done:(void (^)(NSError *error))done {
	void (^d)(NSError *) = [done copy];
	if (!ENStr(uri)) {
		NSError *e = [ENCatalog errorWithJSON:nil status:400 error:nil];
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(e); });
		return;
	}
	[self commandBegan];
	// send-once: a resend after a route change (LAN <-> away) could add the song twice, in a Jam for everyone
	[[ENGateway shared] sendOnceMethod:@"POST" path:@"/v1/player/queue" json:@{ @"uri": uri } timeout:15 completion:^(id j, NSInteger st, NSError *err) {
		[self commandEnded];
		if (st == 200 && [j isKindOfClass:[NSDictionary class]]) {
			ENLog(@"added a song to the queue");
			[self takeEngine:j[@"state"]];
			[self changed];
			if (d) d(nil);
			return;
		}
		NSError *e = [ENCatalog errorWithJSON:j status:st error:err];
		ENLog(@"add to queue failed: %ld %@", (long)st, [ENCatalog codeOfError:e] ?: @"");
		if (d) d(e);
	}];
}

#pragma mark - quality

// The user's pick: the ceiling AND what plays now. A seamless switch of the stream (same generation, next frame, every
// tier numbers its frames the same), never an engine seek, so the Spotify app doesn't jump.
- (void)setTier:(NSString *)t {
	if (ENTierIndex(t) < 0 || ([t isEqualToString:_tier] && [t isEqualToString:self.activeTier])) return;
	_tier = [t copy];
	[[NSUserDefaults standardUserDefaults] setObject:_tier forKey:@"tier"];
	[self switchStreamTo:_tier why:@"picked"];
	[self changed];
}

- (void)setAutoQuality:(BOOL)on {
	if (on == _autoQuality) return;
	_autoQuality = on;
	[[NSUserDefaults standardUserDefaults] setBool:on forKey:@"autoQuality"];
	ENLog(@"automatic quality %@", on ? @"on" : @"off");
	if (!on) [self switchStreamTo:_tier why:@"auto off"];
	[self changed];
}

- (NSString *)activeTier { return _stream.tier ?: _activeTier; }

// (3b) Settings → Pause on Unplug; routeChange: reads it when a device goes away
- (void)setPauseOnUnplug:(BOOL)on {
	if (on == _pauseOnUnplug) return;
	_pauseOnUnplug = on;
	[[NSUserDefaults standardUserDefaults] setBool:on forKey:ENPauseOnUnplugKey];
	ENLog(@"pause on unplug %@", on ? @"on" : @"off");
}

- (NSInteger)kbpsOfTier:(NSInteger)i {
	id k = _stream.tierKbps[ENTierNames[i]];
	return [k respondsToSelector:@selector(integerValue)] && [k integerValue] > 0 ? [k integerValue] : ENTierKbps[i];
}

// New generations open at the ceiling, unless auto quality stepped down in the last 2 minutes (the network is still bad).
- (NSString *)tierToOpen {
	if (_autoQuality && _lastDownAt > 0 && ENNow() - _lastDownAt < 120 && ENTierIndex(_activeTier) > ENTierIndex(_tier)) return _activeTier;
	return _tier;
}

// Reconnect the stream at tier t from its next frame; the AudioQueue plays on from what's buffered. NO if it can't.
- (BOOL)switchStreamTo:(NSString *)t why:(NSString *)why {
	ENStreamPlayer *sp = _stream;
	_fullSince = 0;
	if (!sp) { _activeTier = t; return YES; }
	if ([sp.tier isEqualToString:t]) return YES;
	NSString *from = sp.tier;
	double buf = sp.bufferedSeconds;
	NSInteger rx = sp.rx8Kbps;
	if (![sp switchToTier:t]) {
		ENLog(@"quality %@ -> %@ (%@): can't switch this stream, applies from the next one", from, t, why);
		return NO;
	}
	_activeTier = t;
	ENLog(@"quality %@ -> %@ (%@, rx %ld kbps, %.1f s buffered)", from, t, why, (long)rx, buf);
	[ENDiag flushSoon];
	return YES;
}

// One or more steps down: the best quality that fits in 3/4 of what actually arrived over the last 8 s.
- (void)autoDown:(NSString *)why {
	ENStreamPlayer *sp = _stream;
	NSInteger cur = ENTierIndex(sp.tier);
	if (!_autoQuality || !sp.globalFrames || cur < 0 || cur >= 3) return;
	NSInteger rx = sp.rx8Kbps, pick = cur + 1;
	if (rx > 0) {
		pick = 3;
		for (NSInteger i = cur + 1; i < 4; i++) if ([self kbpsOfTier:i] <= 0.75 * rx) { pick = i; break; }
	}
	if (![self switchStreamTo:ENTierNames[pick] why:why]) return;
	NSTimeInterval now = ENNow();
	_lastDownAt = now;
	if (_lastUpAt > 0 && now - _lastUpAt < 45) {      // the last step up didn't hold: be slower to try again
		_upWait = MIN(_upWait * 2, 300);
		_lastUpAt = 0;
		ENLog(@"auto quality: next step up after %.0f s of full buffer", _upWait);
	}
}

// 1 Hz, from the heartbeat
- (void)autoQualityTick {
	ENStreamPlayer *sp = _stream;
	NSTimeInterval now = ENNow();
	if (_upWait > 20 && now - _lastDownAt >= 600) _upWait = 20;     // 10 minutes without a step down
	if (!sp) return;
	double buf = sp.bufferedSeconds;
	_bufHist[_bufHistN++ % 9] = buf;
	double ago = _bufHist[_bufHistN >= 9 ? _bufHistN % 9 : 0];      // 8 s ago (or the oldest sample there is)
	if (!_autoQuality || !sp.globalFrames || _intent != ENWantPlay || sp.state != ENStreamPlaying || ![self engineFeeding]) { _fullSince = 0; return; }
	NSInteger cur = ENTierIndex(sp.tier), top = ENTierIndex(_tier);
	if (cur < 0) return;
	double lead = sp.leadSeconds;
	// down before it runs dry: low and draining, and the network isn't delivering this tier's rate
	if (now - _lastDownAt >= 6 && buf < 0.35 * lead && ago - buf >= 2 && sp.rx8Kbps < 1.1 * [self kbpsOfTier:cur]) {
		[self autoDown:@"buffer draining"];
		return;
	}
	// up one step: the buffer stayed full for _upWait s, and no stall or step down in the last minute
	if (buf >= lead - 2) { if (!_fullSince) _fullSince = now; }
	else _fullSince = 0;
	if (cur > top && _fullSince > 0 && now - _fullSince >= _upWait && now - _lastStallAt >= 60 && now - _lastDownAt >= 60) {
		if ([self switchStreamTo:ENTierNames[cur - 1] why:[NSString stringWithFormat:@"buffer full for %.0f s", _upWait]]) _lastUpAt = now;
	}
}

#pragma mark - what to show

// Another device (the laptop, a Jam host) has playback and Encore is idle: what it's playing. Play takes it over.
- (NSDictionary *)remote {
	if (_stream || _genCmdInFlight) return nil;
	NSDictionary *r = _engine[@"remote"];
	return [r isKindOfClass:[NSDictionary class]] && [r[@"track"] isKindOfClass:[NSDictionary class]] ? r : nil;
}

// (R2a) masked while Anonymous Mode is on: "another device", or its kind from the bridge's remote.type (H1, "your computer")
- (NSString *)remoteDevice {
	NSDictionary *r = self.remote;
	return [ENAnon deviceName:ENStr(r[@"device"]) type:ENStr(r[@"type"])];
}

- (NSDictionary *)track {
	if (_stream.track) return _stream.track;
	NSDictionary *r = self.remote;
	if (r) return r[@"track"];
	if (_intent == ENWantPause && _pausedTrack) return _pausedTrack;
	NSDictionary *t = _engine[@"track"];
	return [t isKindOfClass:[NSDictionary class]] ? t : nil;
}

- (double)enginePosition {
	double p = [_engine[@"position_ms"] doubleValue];
	if ([ENStr(_engine[@"status"]) isEqualToString:@"playing"]) p += (ENNow() - _engineAt) * 1000.0;
	double d = self.durationMs;
	return d > 0 ? MIN(p, d) : p;
}

- (double)positionMs {
	if (_stream.hasPosition) return _stream.positionMs;
	if (_intent == ENWantPause && _pausedPos >= 0) return _pausedPos;
	if (_loading) return _loadingPos;
	NSDictionary *r = self.remote;
	if (r) {
		double p = [r[@"position_ms"] doubleValue];
		if ([r[@"is_playing"] boolValue]) p += (ENNow() - _engineAt) * 1000.0;
		double d = self.durationMs;
		return d > 0 ? MIN(p, d) : p;
	}
	return [self enginePosition];
}

- (double)durationMs {
	id d = self.track[@"duration_ms"];
	return [d respondsToSelector:@selector(doubleValue)] ? [d doubleValue] : 0;
}

#pragma mark - ENStreamPlayerDelegate

- (void)streamPlayerStateChanged:(ENStreamPlayer *)sp {
	if (sp != _stream) return;
	if (sp.state == ENStreamPlaying) {
		_loading = NO;
		_openRetries = 0;
		if ([_message hasPrefix:@"Lost"] || [_message hasPrefix:@"Can't reach"] || [_message isEqualToString:ENL(@"Lost the stream (Encore Bridge unreachable).")]
			|| [_message isEqualToString:ENL(@"Can't reach your Encore Bridge.")]
			|| [_message isEqualToString:ENL(@"Can't reach your Encore Bridge at either address.")]) _message = nil;
		[self endBackgroundTask];
	} else if (sp.state == ENStreamStalled || sp.state == ENStreamBuffering || sp.state == ENStreamConnecting) {
		_loading = YES;
	}
	// a stall just started (changes are reported once): step down right away, unless the engine has nothing left to send
	if (sp.state == ENStreamStalled && [self engineFeeding]) {
		_lastStallAt = ENNow();
		[self autoDown:@"stall"];
	}
	[self changed];
}

- (void)streamPlayer:(ENStreamPlayer *)sp trackChanged:(NSDictionary *)track {
	if (sp != _stream) return;
	[self changed];
}

- (void)streamPlayer:(ENStreamPlayer *)sp generationEnded:(NSInteger)newGen {
	if (sp != _stream) return;
	if (_genCmdInFlight) { [self closeStream]; return; }     // our own command will open the right one
	if (newGen > 0) [self openGen:newGen live:(newGen < sp.gen)];   // smaller = the gateway restarted
	else { [self closeStream]; [self refreshState]; }
}

- (void)streamPlayer:(ENStreamPlayer *)sp failedWithStatus:(NSInteger)status message:(NSString *)message {
	if (sp != _stream) return;
	double pos = self.positionMs;
	NSDictionary *t = self.track;
	[self closeStream];
	_intent = ENWantPause;
	_loading = NO;
	_pausedPos = pos;
	_pausedTrack = t;
	_message = message;
	[self endBackgroundTask];
	[self changed];
	if (_openRetries++ < 2) {
		// maybe we changed networks: find the gateway again and rejoin if it's still playing
		[[ENGateway shared] probe:^(BOOL ok) { if (ok) [self refreshState]; }];
	}
}

#pragma mark - diagnostics

- (NSString *)networkType {
	static SCNetworkReachabilityRef reach;
	if (!reach) {
		struct sockaddr_in a;
		memset(&a, 0, sizeof a);
		a.sin_len = sizeof a;
		a.sin_family = AF_INET;
		reach = SCNetworkReachabilityCreateWithAddress(NULL, (const struct sockaddr *)&a);
	}
	SCNetworkReachabilityFlags f = 0;
	if (!reach || !SCNetworkReachabilityGetFlags(reach, &f) || !(f & kSCNetworkReachabilityFlagsReachable)) return @"offline";
	return (f & kSCNetworkReachabilityFlagsIsWWAN) ? @"cellular" : @"wifi";
}

- (NSString *)audioOutput {
	// the iOS 6 C API: route names like "Speaker", "Headphone", "HeadphonesBT" (AirPods)
	CFStringRef route = NULL;
	UInt32 size = sizeof route;
	if (AudioSessionGetProperty(kAudioSessionProperty_AudioRoute, &size, &route) != noErr || !route) return @"unknown";
	return (__bridge_transfer NSString *)route;
}

- (NSDictionary *)diagStats {
	NSMutableDictionary *d = [NSMutableDictionary dictionary];
	UIApplicationState as = [UIApplication sharedApplication].applicationState;
	d[@"app"] = as == UIApplicationStateActive ? @"foreground" : as == UIApplicationStateBackground ? @"background" : @"inactive";
	d[@"playing"] = @(self.playing);
	d[@"loading"] = @(_loading);
	d[@"tier"] = _tier ?: @"";
	d[@"active_tier"] = self.activeTier ?: @"";
	d[@"auto"] = @(_autoQuality);
	d[@"route"] = [ENGateway shared].away ? @"away" : @"home";
	d[@"net"] = [self networkType];
	d[@"out"] = [self audioOutput];
	UIDevice *dev = [UIDevice currentDevice];
	d[@"battery"] = @((int)round(dev.batteryLevel * 100));
	d[@"charging"] = @(dev.batteryState == UIDeviceBatteryStateCharging || dev.batteryState == UIDeviceBatteryStateFull);
	d[@"engine"] = ENStr(_engine[@"status"]) ?: @"?";
	ENJam *jam = [ENJam shared];     // 0.6: the role only (no ids, names, tokens or links, DESIGN-4b §4.1)
	if (jam.active) d[@"jam"] = jam.hosting ? @"host" : jam.guest ? @"guest" : jam.limited ? @"lim" : @"on";
	if (ENStr(self.track[@"name"])) d[@"track"] = self.track[@"name"];
	if (_message) d[@"msg"] = _message == _jamMessage ? (_jamMessageCode ?: @"jam") : _message;     // never a Jam error's text
	ENStreamPlayer *sp = _stream;
	if (sp) {
		static const char *names[] = { "idle", "connecting", "buffering", "playing", "paused", "stalled", "failed" };
		d[@"gen"] = @(sp.gen);
		d[@"stream"] = @(names[sp.state]);
		d[@"buffered_s"] = @(round(sp.bufferedSeconds * 10) / 10);
		d[@"stalls"] = @(sp.stalls);
		d[@"reconnects"] = @(sp.reconnects);
		d[@"start_s"] = @(round(sp.startLatency * 100) / 100);
		d[@"lead_s"] = @(round(sp.leadSeconds * 10) / 10);
		d[@"rx8_kbps"] = @(sp.rx8Kbps);
		d[@"switches"] = @(sp.switches);
		[d addEntriesFromDictionary:[sp takeNetStats]];
	}
	return d;
}

#pragma mark - audio session, interruptions, remote control

// Logs the system volume as it changes: shows whether AirPods volume gestures reach iOS 6 at all.
static void ENVolumeChanged(void *ctx, AudioSessionPropertyID pid, UInt32 size, const void *data) {
	if (pid != kAudioSessionProperty_CurrentHardwareOutputVolume || size < sizeof(Float32) || !data) return;
	ENLog(@"volume %.2f (out %@)", *(const Float32 *)data, [(__bridge ENPlayback *)ctx audioOutput]);
}

- (void)setupAudioSession {
	AVAudioSession *s = [AVAudioSession sharedInstance];
	NSError *e = nil;
	if (![s setCategory:AVAudioSessionCategoryPlayback error:&e]) ENLog(@"setCategory failed: %@", e);
	static BOOL volumeWatched;
	if (!volumeWatched) {
		OSStatus st = AudioSessionAddPropertyListener(kAudioSessionProperty_CurrentHardwareOutputVolume, ENVolumeChanged, (__bridge void *)self);
		volumeWatched = st == noErr;
		if (st != noErr) ENLog(@"can't watch the volume (%d)", (int)st);
	}
	if (!ENHasAudioSessionNotifications()) {
		[self watchLegacySession:s];      // (1.1) iOS 5: the same three events by the iOS 5 routes (a nil name would observe all)
		return;
	}
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(interruption:) name:AVAudioSessionInterruptionNotification object:s];
	[nc addObserver:self selector:@selector(routeChange:) name:AVAudioSessionRouteChangeNotification object:s];
	[nc addObserver:self selector:@selector(mediaReset:) name:AVAudioSessionMediaServicesWereResetNotification object:s];
}

// (1.1, iOS 5) interruptions: the session's delegate (-beginInterruption / -endInterruptionWithFlags:); a route change and
// the media server's death: the C API's 'roch' and 'died' property listeners (registered once: the session they listen on
// is the one AVAudioSession set up; never AudioSessionInitialize here). Each feeds the same handling as iOS 6's notifications.
static void ENLegacyRouteChanged(void *ctx, AudioSessionPropertyID pid, UInt32 size, const void *data) {
	if (pid != kAudioSessionProperty_AudioRouteChange || !data) return;
	CFNumberRef num = CFDictionaryGetValue((CFDictionaryRef)data, CFSTR(kAudioSession_AudioRouteChangeKey_Reason));
	SInt32 reason = 0;
	if (num) CFNumberGetValue(num, kCFNumberSInt32Type, &reason);
	[(__bridge ENPlayback *)ctx routeChangedForReason:(NSUInteger)reason];      // (the values are AVAudioSession's)
}

static void ENLegacyServerDied(void *ctx, AudioSessionPropertyID pid, UInt32 size, const void *data) {
	if (pid != kAudioSessionProperty_ServerDied) return;
	[(__bridge ENPlayback *)ctx mediaServicesWereReset];
}

- (void)watchLegacySession:(AVAudioSession *)s {
	s.delegate = self;
	static BOOL routeWatched, deathWatched;
	if (!routeWatched) {
		OSStatus st = AudioSessionAddPropertyListener(kAudioSessionProperty_AudioRouteChange, ENLegacyRouteChanged, (__bridge void *)self);
		routeWatched = st == noErr;
		if (st != noErr) ENLog(@"can't watch route changes (%d)", (int)st);
	}
	if (!deathWatched) {
		OSStatus st = AudioSessionAddPropertyListener(kAudioSessionProperty_ServerDied, ENLegacyServerDied, (__bridge void *)self);
		deathWatched = st == noErr;
		if (st != noErr) ENLog(@"can't watch the media server (%d)", (int)st);
	}
}

- (void)beginInterruption {
	dispatch_async(dispatch_get_main_queue(), ^{ [self interruptionBegan]; });
}

- (void)endInterruptionWithFlags:(NSUInteger)flags {
	BOOL resume = (flags & AVAudioSessionInterruptionFlags_ShouldResume) != 0;
	dispatch_async(dispatch_get_main_queue(), ^{ [self interruptionEndedShouldResume:resume]; });
}

// (1.1) iOS 5's 'died' listener fires when the media server dies, not (as iOS 6's notification) once it is back, so the
// category it sets may not stick: there every activation sets Playback again first (the same category: no change otherwise)
- (void)activateSession {
	AVAudioSession *s = [AVAudioSession sharedInstance];
	NSError *e = nil;
	if (!ENHasAudioSessionNotifications() && ![s setCategory:AVAudioSessionCategoryPlayback error:&e]) ENLog(@"setCategory failed: %@", e);
	e = nil;
	if (![s setActive:YES error:&e]) ENLog(@"setActive failed: %@", e);
}

- (void)interruption:(NSNotification *)n {
	NSDictionary *info = n.userInfo;
	dispatch_async(dispatch_get_main_queue(), ^{
		NSUInteger type = [info[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
		if (type == AVAudioSessionInterruptionTypeBegan) {
			[self interruptionBegan];
		} else {
			NSUInteger opts = [info[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue];
			[self interruptionEndedShouldResume:(opts & AVAudioSessionInterruptionOptionShouldResume) != 0];
		}
	});
}

// (1.1) the two halves of an interruption, from iOS 6's notification or iOS 5's delegate calls (main thread)
- (void)interruptionBegan {
	ENLog(@"audio interruption began");
	_interrupted = YES;
	_resumeAfterInterruption = self.playing;
	if (self.playing) [self pause];
}

- (void)interruptionEndedShouldResume:(BOOL)shouldResume {
	ENLog(@"audio interruption ended");
	_interrupted = NO;
	if (_resumeAfterInterruption && shouldResume) {
		[self activateSession];
		[self resume];
	}
	_resumeAfterInterruption = NO;
}

// AVAudioSessionRouteChangeReasonOldDeviceUnavailable (iOS 6) = kAudioSessionRouteChangeReason_OldDeviceUnavailable (iOS 5)
static const NSUInteger ENRouteReasonOldDeviceUnavailable = 2;

static NSString *ENRouteReason(NSUInteger r) {
	switch (r) {
		case 1: return @"new device";
		case 2: return @"old device gone";
		case 3: return @"category";
		case 4: return @"override";
		case 6: return @"wake";
		case 7: return @"no route";
		case 8: return @"config change";
		default: return [NSString stringWithFormat:@"reason %lu", (unsigned long)r];
	}
}

- (void)routeChange:(NSNotification *)n {
	[self routeChangedForReason:[n.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue]];
}

// (1.1) from iOS 6's notification or iOS 5's 'roch' listener: the reason values are the same (2 = the old device went away)
- (void)routeChangedForReason:(NSUInteger)reason {
	dispatch_async(dispatch_get_main_queue(), ^{
		ENLog(@"audio route changed (%@): now %@", ENRouteReason(reason), [self audioOutput]);
		// headphones pulled / AirPods disconnected: pause instead of blasting the speaker (3b: unless Settings → Pause on
		// Unplug is off)
		if (reason == ENRouteReasonOldDeviceUnavailable && self.playing) {
			if (self->_pauseOnUnplug) [self pause];
			else ENLog(@"output went away: playing on (pause on unplug is off)");
		}
	});
}

- (void)mediaReset:(NSNotification *)n {
	[self mediaServicesWereReset];
}

// (1.1) from iOS 6's notification or iOS 5's 'died' listener
- (void)mediaServicesWereReset {
	dispatch_async(dispatch_get_main_queue(), ^{
		ENLog(@"media services were reset");
		BOOL was = self.playing;
		[self closeStream];
		[self setupAudioSession];
		if (was) { self->_intent = ENWantPause; [self refreshState]; }
	});
}

// SpringBoard's notify state: 1/0, or -1 if unknown. Registered once per name.
static int ENSpringBoardState(const char *name, int *token) {
	if (*token < 0) {
		int t;
		if (notify_register_check(name, &t) != NOTIFY_STATUS_OK) return -1;
		*token = t;
	}
	uint64_t v = 0;
	if (notify_get_state(*token, &v) != NOTIFY_STATUS_OK) return -1;
	return v ? 1 : 0;
}

// Where did a remote command come from? iOS doesn't say, so guess from the screen / lock / app state.
- (void)logRemoteEvent:(UIEventSubtype)st {
	static int lockToken = -1, blankToken = -1;
	NSString *what;
	switch (st) {
		case UIEventSubtypeRemoteControlTogglePlayPause: what = @"toggle"; break;
		case UIEventSubtypeRemoteControlPlay: what = @"play"; break;
		case UIEventSubtypeRemoteControlPause: what = @"pause"; break;
		case UIEventSubtypeRemoteControlStop: what = @"stop"; break;
		case UIEventSubtypeRemoteControlNextTrack: what = @"next"; break;
		case UIEventSubtypeRemoteControlPreviousTrack: what = @"prev"; break;
		default: what = [NSString stringWithFormat:@"subtype %d", (int)st]; break;
	}
	int locked = ENSpringBoardState("com.apple.springboard.lockstate", &lockToken);
	int blank = ENSpringBoardState("com.apple.springboard.hasBlankedScreen", &blankToken);
	UIApplicationState as = [UIApplication sharedApplication].applicationState;
	NSString *guess = blank == 1 ? @"AirPods/headset" : locked == 1 ? @"lock screen (or AirPods)"
		: as != UIApplicationStateActive ? @"multitasking bar (or AirPods)" : @"AirPods/headset (app open)";
	ENLog(@"remote %@ via %@ [screen %@, %@, app %@, out %@]", what, guess, blank < 0 ? @"?" : blank ? @"off" : @"on",
		locked < 0 ? @"lock ?" : locked ? @"locked" : @"unlocked",
		as == UIApplicationStateActive ? @"fg" : as == UIApplicationStateBackground ? @"bg" : @"inactive", [self audioOutput]);
}

- (void)handleRemoteEvent:(UIEvent *)event {
	if (event.type != UIEventTypeRemoteControl) return;
	[self logRemoteEvent:event.subtype];
	// AirPods on iOS 6 never learn that we're playing, so every tap arrives as "play" (and could arrive as "pause"
	// while paused). From Bluetooth, or while audio is audibly rolling, treat both as a toggle. The lock screen only
	// offers "play" when it shows us stopped (stalled / loading), so there "play" while playing stays a no-op.
	BOOL bt = [[self audioOutput] hasSuffix:@"BT"];     // HeadphonesBT (AirPods), HeadsetBT
	BOOL rolling = _intent == ENWantPlay && _stream.state == ENStreamPlaying;
	switch (event.subtype) {
		case UIEventSubtypeRemoteControlTogglePlayPause: [self togglePlayPause]; break;
		case UIEventSubtypeRemoteControlPlay: if (self.playing && (bt || rolling)) [self pause]; else [self resume]; break;
		case UIEventSubtypeRemoteControlPause: if (self.playing) [self pause]; else if (bt) [self resume]; break;
		case UIEventSubtypeRemoteControlStop: if (self.playing) [self pause]; break;
		case UIEventSubtypeRemoteControlNextTrack: [self next]; break;
		case UIEventSubtypeRemoteControlPreviousTrack: [self previous]; break;
		default: break;
	}
	[ENDiag flushSoon];
}

- (void)beginBackgroundTask {
	if (_bgTask != UIBackgroundTaskInvalid) return;
	_bgTask = [[UIApplication sharedApplication] beginBackgroundTaskWithExpirationHandler:^{ [self endBackgroundTask]; }];
}

- (void)endBackgroundTask {
	if (_bgTask == UIBackgroundTaskInvalid) return;
	[[UIApplication sharedApplication] endBackgroundTask:_bgTask];
	_bgTask = UIBackgroundTaskInvalid;
}

#pragma mark - artwork, lock screen, change notifications

- (void)changed {
	[self updateArtwork];
	[self updateNowPlaying];
	[[NSNotificationCenter defaultCenter] postNotificationName:ENPlaybackChangedNotification object:self];
}

- (void)heartbeat {
	[self updateNowPlaying];
	// a command that never produced audio (gateway hiccup): don't spin forever
	if (_loading && _stream && _stream.startLatency == 0 && ENNow() - _streamOpenedAt > 20) {
		[self streamPlayer:_stream failedWithStatus:0 message:ENL(@"No audio from your Encore Bridge.")];
	}
	[self autoQualityTick];
}

// 0.5: the 640 tier from ENImageCache when the track has an image token (memory, disk, then the gateway; held here
// strongly, also the lock screen's); a gateway 0.4 track only has `cover`: the old /v1/image?u= path.
- (void)updateArtwork {
	NSDictionary *t = self.track;
	NSString *img = ENStr(t[@"img"]), *cover = ENStr(t[@"cover"]);
	NSString *u = img ? [@"img:" stringByAppendingString:img] : cover;
	if ((u == nil && _artURL == nil) || [u isEqualToString:_artURL]) return;
	_artURL = u;
	_artwork = nil;
	if (_artKey) {                 // skipped on before it came: don't download / decode a cover nobody will see
		[[ENImageCache shared] cancel:_artKey];
		_artKey = nil;
	}
	if (!u) return;
	if (img) {
		UIImage *m = [[ENImageCache shared] memoryImage:img size:ENImg640 round:NO];
		if (m) { _artwork = m; return; }
		_artKey = [[ENImageCache shared] load:img size:ENImg640 round:NO done:^(UIImage *image, NSString *key) {
			if (![self->_artURL isEqualToString:u]) return;
			self->_artKey = nil;        // answered: nothing left to cancel
			if (image) { self->_artwork = image; [self changed]; }
			else if (cover) [self loadLegacyArtwork:cover forKey:u];
		}];
		return;
	}
	[self loadLegacyArtwork:cover forKey:u];
}

- (void)loadLegacyArtwork:(NSString *)cover forKey:(NSString *)u {
	[[ENGateway shared] getData:[@"/v1/image?u=" stringByAppendingString:[ENGateway escape:cover]] completion:^(NSData *data, NSInteger st) {
		UIImage *img = (st == 200 && data.length) ? [UIImage imageWithData:data] : nil;
		if ([self->_artURL isEqualToString:u] && img) {
			self->_artwork = img;
			[self changed];
		}
	}];
}

#pragma mark - the song being heard (0.5)

- (NSString *)playingURI {
	NSDictionary *t = self.track;
	return ENStr(t[@"context_track_uri"]) ?: ENStr(t[@"uri"]);
}

// One ENTrack per song (the same object until the song changes), whichever dictionary track came from.
- (ENTrack *)playingTrack {
	NSDictionary *t = self.track;
	if (!t) return nil;
	if (t == _ptSrc) return _pt;
	_ptSrc = t;
	NSString *key = [NSString stringWithFormat:@"%@|%@|%@|%@", [self playingURI] ?: @"", ENStr(t[@"name"]) ?: @"", ENStr(t[@"img"]) ?: @"",
		t[@"duration_ms"] ?: @""];
	if (![key isEqualToString:_ptKey]) {
		_ptKey = key;
		_pt = [ENTrack trackWithPlaybackTrack:t];
	}
	return _pt;
}

// cellForRow calls this for every visible row: the keys are worked out once per track dictionary.
- (BOOL)isPlayingRow:(ENTrack *)row {
	NSString *u = row.uri;
	NSDictionary *t = self.track;
	if (!u || !t) return NO;
	if (t != _matchSrc) {
		_matchSrc = t;
		_matchCtx = ENStr(t[@"context_track_uri"]);
		_matchURI = ENStr(t[@"uri"]);
		NSString *name = ENStr(t[@"name"]);
		double d = [t[@"duration_ms"] respondsToSelector:@selector(doubleValue)] ? [t[@"duration_ms"] doubleValue] : 0;
		// the gateway's songKey: name + whole seconds (Spotify relinks: the same song under another id)
		_matchSongKey = name && d > 0 ? [NSString stringWithFormat:@"%@|%ld", name, (long)floor(d / 1000.0 + 0.5)] : nil;
	}
	if ([u isEqualToString:_matchCtx] || [u isEqualToString:_matchURI]) return YES;
	return _matchSongKey && row.durationMs > 0 && [row.songKey isEqualToString:_matchSongKey];
}

- (void)updateNowPlaying {
	NSDictionary *t = self.track;
	NSString *name = ENStr(t[@"name"]);
	MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
	if (!name) {
		if (_npURI) { center.nowPlayingInfo = nil; _npURI = nil; }
		return;
	}
	BOOL rolling = _intent == ENWantPlay && _stream.state == ENStreamPlaying;
	double pos = self.positionMs;
	NSTimeInterval now = ENNow();
	double expected = _npPos + (_npPlaying ? (now - _npAt) * 1000.0 : 0);
	if ([_npURI isEqualToString:ENStr(t[@"uri"]) ?: name] && _npPlaying == rolling && fabs(expected - pos) < 1500 && _npArt == _artwork) return;

	NSMutableDictionary *info = [NSMutableDictionary dictionary];
	info[MPMediaItemPropertyTitle] = name;
	NSArray *artists = [t[@"artists"] isKindOfClass:[NSArray class]] ? t[@"artists"] : nil;
	if (artists.count) info[MPMediaItemPropertyArtist] = [artists componentsJoinedByString:@", "];
	if (ENStr(t[@"album"])) info[MPMediaItemPropertyAlbumTitle] = t[@"album"];
	double dur = self.durationMs;
	if (dur > 0) info[MPMediaItemPropertyPlaybackDuration] = @(dur / 1000.0);
	info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(pos / 1000.0);
	info[MPNowPlayingInfoPropertyPlaybackRate] = @(rolling ? 1.0 : 0.0);
	if (_artwork) info[MPMediaItemPropertyArtwork] = [[MPMediaItemArtwork alloc] initWithImage:_artwork];
	center.nowPlayingInfo = info;
	_npURI = ENStr(t[@"uri"]) ?: name;
	_npPlaying = rolling;
	_npPos = pos;
	_npAt = now;
	_npArt = _artwork;
}

@end

#import "ENStreamPlayer.h"
#import "ENGateway.h"
#import "ENDiag.h"
#import <AudioToolbox/AudioToolbox.h>
#import "ENL.h"

#define kNumBufs     32        // AudioQueue buffers
#define kBufBytes    32768     // each; a 320k AAC frame averages ~930 bytes, worst case ~1.5 KB
#define kPktsPerBuf  24        // ~0.56 s per buffer
#define kMaxAttempts 6
#define kRxSecs      8         // rx8Kbps window
#define kHeardEvery  10        // s between playhead reports while playing or stalled

@interface ENStreamPlayer ()
@property (nonatomic, readwrite) ENStreamState state;
- (void)handleProperty:(AudioFileStreamPropertyID)pid;
- (void)handlePackets:(UInt32)n bytes:(const void *)data descs:(AudioStreamPacketDescription *)descs total:(UInt32)total;
- (void)bufferDone:(AudioQueueBufferRef)buf;
@end

static void ENPropListener(void *ctx, AudioFileStreamID afs, AudioFileStreamPropertyID pid, UInt32 *flags) {
	[(__bridge ENStreamPlayer *)ctx handleProperty:pid];
}

static void ENPacketsProc(void *ctx, UInt32 nBytes, UInt32 nPackets, const void *data, AudioStreamPacketDescription *descs) {
	[(__bridge ENStreamPlayer *)ctx handlePackets:nPackets bytes:data descs:descs total:nBytes];
}

static void ENOutputProc(void *ctx, AudioQueueRef aq, AudioQueueBufferRef buf) {
	[(__bridge ENStreamPlayer *)ctx bufferDone:buf];
}

@implementation ENStreamPlayer {
	// network + demux
	NSURLConnection *_conn;
	NSInteger _httpStatus;
	NSMutableData *_in;
	BOOL _gotHeader;
	BOOL _live;
	long long _nextFrame;          // gateway frame number of the next 'A' record (-1 until the first header)
	NSUInteger _attempts;
	BOOL _ended;                   // 'Z' seen
	BOOL _stopped;
	NSTimeInterval _openedAt;
	double _prebuffer, _rebuffer;
	NSTimeInterval _lastDataAt, _windowStart, _stallStartedAt;
	double _maxGap;
	NSUInteger _gaps1, _gaps3;
	long long _windowBytes;
	BOOL _switching;               // this connection is a quality switch (log label, until its header arrives)
	NSMutableArray *_segs;         // one per connection: {k: its first packet index, f: that packet's global frame}
	long long _rxBytes[kRxSecs + 1];   // bytes received per wall-clock second (ring)
	long long _rxSec, _rxFrom;     // current second, second the stream opened

	// playhead reports (POST /v1/player/heard): one in flight, a newer one is sent when it returns
	BOOL _heardBusy, _heardAgain, _heardWarned;
	NSTimeInterval _heardAt;

	// decode + output
	AudioFileStreamID _afs;
	AudioQueueRef _aq;
	AudioQueueBufferRef _bufs[kNumBufs];
	BOOL _inUse[kNumBufs];
	UInt32 _bufPkts[kNumBufs];
	NSUInteger _inUseCount;
	AudioStreamPacketDescription _descs[kPktsPerBuf];
	NSMutableArray *_fifo;         // NSData per AAC packet, waiting for a free buffer
	double _fpp, _rate;
	BOOL _queueStarted;
	BOOL _userPaused;

	// timeline: packet index k = k-th 'A' record of this generation
	long long _aCount;             // 'A' records received
	long long _enqueued;           // packets handed to the AudioQueue
	long long _stallAt;
	double _corr;                  // queue sample time (in packets) minus packets heard
	double _lastPlayed;
	NSMutableArray *_markers;      // {k, t, d} not yet heard
	double _anchorMs;
	long long _anchorPkt;
	NSTimer *_tick;
	NSString *_lastError;
}

- (instancetype)initWithGen:(NSInteger)gen tier:(NSString *)tier live:(BOOL)live prebuffer:(double)prebuffer rebuffer:(double)rebuffer {
	if ((self = [super init])) {
		_gen = gen;
		_tier = [tier copy];
		_live = live;
		_prebuffer = prebuffer;
		_rebuffer = rebuffer;
		_windowStart = [NSDate timeIntervalSinceReferenceDate];
		_nextFrame = -1;
		_fpp = 1024;
		_rate = 44100;
		_in = [NSMutableData data];
		_fifo = [NSMutableArray array];
		_markers = [NSMutableArray array];
		_segs = [NSMutableArray array];
		_leadSeconds = [ENGateway shared].away ? 20 : 10;
	}
	return self;
}

- (void)dealloc {
	[self teardown];
}

#pragma mark - lifecycle

- (void)setState:(ENStreamState)s {
	if (_state == s) return;
	_state = s;
	if (!_stopped) [_delegate streamPlayerStateChanged:self];
}

- (void)start {
	if (_stopped || _conn) return;
	if (!_afs) {
		OSStatus e = AudioFileStreamOpen((__bridge void *)self, ENPropListener, ENPacketsProc, kAudioFileAAC_ADTSType, &_afs);
		if (e) { [self failStatus:0 message:[NSString stringWithFormat:@"AudioFileStreamOpen %d", (int)e]]; return; }
	}
	_openedAt = [NSDate timeIntervalSinceReferenceDate];
	_rxSec = _rxFrom = (long long)floor(_openedAt);
	[self connect];
	_tick = [NSTimer timerWithTimeInterval:0.25 target:self selector:@selector(tick) userInfo:nil repeats:YES];
	[[NSRunLoop mainRunLoop] addTimer:_tick forMode:NSRunLoopCommonModes];
}

- (void)connect {
	if (_stopped) return;
	NSMutableString *path = [NSMutableString stringWithFormat:@"/v1/stream?gen=%ld&q=%@", (long)_gen, [ENGateway escape:_tier]];
	if (_nextFrame >= 0) [path appendFormat:@"&from=%lld", _nextFrame];
	else if (_live) [path appendString:@"&live=1"];
	if (_switching) [path appendString:@"&switch=1"];
	[path appendFormat:@"&lead=%d", [ENGateway shared].away ? 20 : 10];     // seconds of buffer the gateway may build up here
	NSMutableURLRequest *r = [[ENGateway shared] requestWithMethod:@"GET" path:path body:nil];
	r.timeoutInterval = [ENGateway shared].away ? 15 : 8;     // idle timeout
	_httpStatus = 0;
	_gotHeader = NO;
	[_in setLength:0];
	_conn = [[NSURLConnection alloc] initWithRequest:r delegate:self startImmediately:NO];
	[_conn scheduleInRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
	[_conn start];
	if (_state == ENStreamIdle) self.state = ENStreamConnecting;
}

- (void)reconnectLater {
	[_conn cancel];
	_conn = nil;
	if (_stopped || _ended) return;
	if (++_attempts > kMaxAttempts) { [self failStatus:0 message:ENL(@"Lost the stream (Encore Bridge unreachable).")]; return; }
	static const double delays[] = { 0.2, 0.8, 1.5, 2.5, 4, 6 };
	double d = delays[MIN(_attempts - 1, (NSUInteger)5)];
	_reconnects++;
	ENLog(@"stream gen %ld: reconnecting in %.1f s (attempt %lu, from frame %lld, %.1f s buffered, %@)", (long)_gen, d, (unsigned long)_attempts, _nextFrame, self.bufferedSeconds, _lastError ?: @"closed");
	[self performSelector:@selector(connect) withObject:nil afterDelay:d inModes:@[NSRunLoopCommonModes]];
}

- (void)failStatus:(NSInteger)status message:(NSString *)msg {
	if (_stopped) return;
	ENLog(@"stream gen %ld failed: %ld %@", (long)_gen, (long)status, msg);
	[ENDiag flushSoon];
	[self teardown];
	_state = ENStreamFailed;
	[_delegate streamPlayer:self failedWithStatus:status message:msg];
}

// for errors raised inside AudioFileStream callbacks: don't close the parser while it's on the stack
- (void)failSoon:(NSString *)msg {
	dispatch_async(dispatch_get_main_queue(), ^{ [self failStatus:0 message:msg]; });
}

- (void)stop {
	if (_stopped) return;
	[self teardown];
	_state = ENStreamIdle;
}

- (void)teardown {
	_stopped = YES;
	[NSObject cancelPreviousPerformRequestsWithTarget:self];
	[_tick invalidate];
	_tick = nil;
	[_conn cancel];
	_conn = nil;
	if (_aq) {
		AudioQueueStop(_aq, true);
		AudioQueueDispose(_aq, true);
		_aq = NULL;
	}
	if (_afs) {
		AudioFileStreamClose(_afs);
		_afs = NULL;
	}
	[_fifo removeAllObjects];
}

- (void)pause {
	_userPaused = YES;
	if (_aq && _state == ENStreamPlaying) AudioQueuePause(_aq);
	if (_state == ENStreamPlaying || _state == ENStreamBuffering || _state == ENStreamStalled) self.state = ENStreamPaused;
}

- (void)resume {
	if (!_userPaused) return;
	_userPaused = NO;
	if (_state != ENStreamPaused) return;
	if (_queueStarted && _aq && AudioQueueStart(_aq, NULL) == noErr) self.state = ENStreamPlaying;
	else { self.state = ENStreamBuffering; [self maybeStart]; }
}

- (BOOL)switchToTier:(NSString *)tier {
	if (_stopped || _ended || _state == ENStreamFailed || !tier) return NO;
	if ([tier isEqualToString:_tier]) return YES;
	if (_nextFrame >= 0 && !_globalFrames) return NO;     // an older gateway numbers frames per tier: from= would land elsewhere
	_tier = [tier copy];
	if ([_tierKbps[tier] respondsToSelector:@selector(integerValue)]) _kbps = [_tierKbps[tier] integerValue];   // the header confirms it
	// drop the current connection (a partial record in _in goes with it; _nextFrame only counts whole 'A' records)
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(connect) object:nil];
	[_conn cancel];
	_conn = nil;
	_attempts = 0;
	_switching = YES;
	_switches++;
	[self connect];
	[self heardSoon];
	return YES;
}

#pragma mark - NSURLConnection

- (void)connection:(NSURLConnection *)c didReceiveResponse:(NSURLResponse *)resp {
	if (c != _conn) return;
	_httpStatus = [(NSHTTPURLResponse *)resp statusCode];
	[_in setLength:0];
	if (_httpStatus == 401) [[ENGateway shared] adoptServerClockFrom:(NSHTTPURLResponse *)resp];
}

- (NSCachedURLResponse *)connection:(NSURLConnection *)c willCacheResponse:(NSCachedURLResponse *)r { return nil; }

- (void)connection:(NSURLConnection *)c didReceiveData:(NSData *)data {
	if (c != _conn || _stopped) return;
	NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
	if (_lastDataAt > 0 && _gotHeader) {
		double gap = now - _lastDataAt;
		if (gap > _maxGap) _maxGap = gap;
		if (gap > 1) _gaps1++;
		if (gap > 3) _gaps3++;
		if (gap > 1.5) ENLog(@"stream gen %ld: no data for %.1f s (%.1f s still buffered)", (long)_gen, gap, self.bufferedSeconds);
	}
	_lastDataAt = now;
	_windowBytes += data.length;
	_bytesReceived += data.length;
	[self rxRoll:now];
	_rxBytes[_rxSec % (kRxSecs + 1)] += data.length;
	[_in appendData:data];
	if (_httpStatus != 200) return;      // error body, handled when it finishes
	[self demux];
}

- (void)connectionDidFinishLoading:(NSURLConnection *)c {
	if (c != _conn || _stopped) return;
	_conn = nil;
	if (_httpStatus == 200) {
		_lastError = @"server closed the stream";
		if (!_ended) [self reconnectLater];   // the gateway closed without 'Z' (restart, or we fell too far behind)
		return;
	}
	NSDictionary *j = [NSJSONSerialization JSONObjectWithData:_in options:0 error:NULL];
	NSInteger serverGen = [j isKindOfClass:[NSDictionary class]] ? [j[@"gen"] integerValue] : 0;
	NSString *code = [j isKindOfClass:[NSDictionary class]] ? j[@"error"][@"code"] : nil;
	if (_httpStatus == 410 || (_httpStatus == 400 && [code isEqualToString:@"bad_gen"])) {
		// stale (someone else changed what's playing) or the gateway restarted and its counter reset
		_ended = YES;
		[self teardown];
		[_delegate streamPlayer:self generationEnded:serverGen];
		return;
	}
	if (_httpStatus == 503 || _httpStatus == 401 || _httpStatus >= 502) { [self reconnectLater]; return; }
	[self failStatus:_httpStatus message:code ?: [NSString stringWithFormat:@"HTTP %ld", (long)_httpStatus]];
}

- (void)connection:(NSURLConnection *)c didFailWithError:(NSError *)error {
	if (c != _conn || _stopped) return;
	_lastError = [NSString stringWithFormat:@"%@ %ld", error.domain, (long)error.code];
	_conn = nil;
	if (_ended) return;
	[self reconnectLater];
}

#pragma mark - ENC1 demux

static uint32_t be32(const uint8_t *b) { return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3]; }

- (void)demux {
	const uint8_t *b = _in.bytes;
	NSUInteger n = _in.length, off = 0;
	if (!_gotHeader) {
		if (n < 8) return;
		if (memcmp(b, "ENC1", 4) != 0) { [self failStatus:200 message:@"not an Encore stream"]; return; }
		uint32_t hl = be32(b + 4);
		if (hl > 65536) { [self failStatus:200 message:@"bad stream header"]; return; }
		if (n < 8 + hl) return;
		NSDictionary *h = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:b + 8 length:hl] options:0 error:NULL];
		long long sf = [h[@"start_frame"] longLongValue];
		NSString *how = _switching ? [@"switched to " stringByAppendingString:_tier] : nil;
		if (_nextFrame >= 0 && sf != _nextFrame) ENLog(@"stream gen %ld %@ at frame %lld (wanted %lld): %lld frames skipped", (long)_gen, how ?: @"resumed", sf, _nextFrame, sf - _nextFrame);
		else if (_nextFrame >= 0) ENLog(@"stream gen %ld %@ at frame %lld, nothing lost", (long)_gen, how ?: @"reconnected", sf);
		[self addSegmentAt:_aCount frame:sf];
		_nextFrame = sf;
		_kbps = [h[@"kbps"] integerValue];
		_globalFrames = [h[@"frames"] isEqual:@"global"];
		double lead = [h[@"lead_ms"] respondsToSelector:@selector(doubleValue)] ? [h[@"lead_ms"] doubleValue] : 0;
		_leadSeconds = lead > 0 ? lead / 1000 : 10;          // an older gateway ignores lead= and keeps its 10 s
		if ([h[@"tiers"] isKindOfClass:[NSDictionary class]]) _tierKbps = h[@"tiers"];
		if (!_startHow) _startHow = [h[@"start"] copy];
		_gotHeader = YES;
		_attempts = 0;
		_switching = NO;
		off = 8 + hl;
		if (_state == ENStreamConnecting) self.state = ENStreamBuffering;
	}
	NSMutableData *feed = nil;
	NSInteger zGen = -1;
	while (n - off >= 4) {
		uint8_t type = b[off];
		uint32_t len = ((uint32_t)b[off + 1] << 16) | ((uint32_t)b[off + 2] << 8) | b[off + 3];
		if (n - off - 4 < len) break;
		const uint8_t *pl = b + off + 4;
		if (type == 'A') {
			if (!feed) feed = [NSMutableData dataWithCapacity:n];
			[feed appendBytes:pl length:len];
			_aCount++;
			_nextFrame++;
		} else {
			id j = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:pl length:len] options:0 error:NULL];
			if (![j isKindOfClass:[NSDictionary class]]) j = @{};
			if (type == 'M' || type == 'P') [_markers addObject:@{ @"k": @(_aCount), @"t": @(type), @"d": j }];
			else if (type == 'Z') zGen = [j[@"gen"] integerValue];
		}
		off += 4 + len;
	}
	if (off) [_in replaceBytesInRange:NSMakeRange(0, off) withBytes:NULL length:0];
	if (feed && _afs) {
		OSStatus e = AudioFileStreamParseBytes(_afs, (UInt32)feed.length, feed.bytes, 0);
		if (e) ENLog(@"AudioFileStreamParseBytes error %d", (int)e);
	}
	[self pump];
	if (zGen >= 0 && !_stopped) {
		_ended = YES;
		[_conn cancel];
		_conn = nil;
		[_delegate streamPlayer:self generationEnded:zGen];
	}
}

#pragma mark - AudioFileStream

- (void)handleProperty:(AudioFileStreamPropertyID)pid {
	if (pid != kAudioFileStreamProperty_ReadyToProducePackets || _aq || _stopped) return;
	AudioStreamBasicDescription asbd;
	UInt32 sz = sizeof asbd;
	OSStatus e = AudioFileStreamGetProperty(_afs, kAudioFileStreamProperty_DataFormat, &sz, &asbd);
	if (e) { [self failSoon:[NSString stringWithFormat:@"no audio format (%d)", (int)e]]; return; }
	if (asbd.mFramesPerPacket) _fpp = asbd.mFramesPerPacket;
	if (asbd.mSampleRate > 0) _rate = asbd.mSampleRate;
	e = AudioQueueNewOutput(&asbd, ENOutputProc, (__bridge void *)self, CFRunLoopGetMain(), kCFRunLoopCommonModes, 0, &_aq);
	if (e) { _aq = NULL; [self failSoon:[NSString stringWithFormat:@"AudioQueueNewOutput %d", (int)e]]; return; }
	UInt32 policy = kAudioQueueHardwareCodecPolicy_PreferHardware;
	AudioQueueSetProperty(_aq, kAudioQueueProperty_HardwareCodecPolicy, &policy, sizeof policy);
	UInt32 cs = 0;
	Boolean writable;
	if (AudioFileStreamGetPropertyInfo(_afs, kAudioFileStreamProperty_MagicCookieData, &cs, &writable) == noErr && cs) {
		void *cookie = malloc(cs);
		if (AudioFileStreamGetProperty(_afs, kAudioFileStreamProperty_MagicCookieData, &cs, cookie) == noErr)
			AudioQueueSetProperty(_aq, kAudioQueueProperty_MagicCookie, cookie, cs);
		free(cookie);
	}
	for (int i = 0; i < kNumBufs; i++) {
		if (AudioQueueAllocateBuffer(_aq, kBufBytes, &_bufs[i])) { [self failSoon:@"AudioQueueAllocateBuffer"]; return; }
		_inUse[i] = NO;
	}
}

- (void)handlePackets:(UInt32)n bytes:(const void *)data descs:(AudioStreamPacketDescription *)descs total:(UInt32)total {
	if (_stopped) return;
	if (!descs) {   // shouldn't happen for AAC, but don't lose audio if it does
		[_fifo addObject:[NSData dataWithBytes:data length:total]];
		return;
	}
	for (UInt32 i = 0; i < n; i++) {
		if (descs[i].mDataByteSize == 0 || descs[i].mDataByteSize > kBufBytes) continue;
		[_fifo addObject:[NSData dataWithBytes:(const char *)data + descs[i].mStartOffset length:descs[i].mDataByteSize]];
	}
}

#pragma mark - AudioQueue

- (int)freeBuffer {
	for (int i = 0; i < kNumBufs; i++) if (!_inUse[i]) return i;
	return -1;
}

- (void)pump {
	if (!_aq || _stopped) return;
	while (_fifo.count) {
		double queued = (_enqueued - [self playedPackets]) * _fpp / _rate;
		if (!(_fifo.count >= kPktsPerBuf || queued < 0.6 || _ended)) break;     // batch up while there's plenty queued
		int i = [self freeBuffer];
		if (i < 0) break;
		AudioQueueBufferRef b = _bufs[i];
		UInt32 off = 0, np = 0;
		while (np < kPktsPerBuf && _fifo.count) {
			NSData *p = _fifo[0];
			if (off + p.length > b->mAudioDataBytesCapacity) break;
			memcpy((char *)b->mAudioData + off, p.bytes, p.length);
			_descs[np].mStartOffset = off;
			_descs[np].mDataByteSize = (UInt32)p.length;
			_descs[np].mVariableFramesInPacket = 0;
			off += p.length;
			np++;
			[_fifo removeObjectAtIndex:0];
		}
		if (!np) break;
		b->mAudioDataByteSize = off;
		OSStatus e = AudioQueueEnqueueBuffer(_aq, b, np, _descs);
		if (e) { ENLog(@"AudioQueueEnqueueBuffer error %d", (int)e); break; }
		_inUse[i] = YES;
		_bufPkts[i] = np;
		_inUseCount++;
		_enqueued += np;
	}
	[self maybeStart];
}

- (void)maybeStart {
	if (_stopped || !_aq || _userPaused) return;
	if (_state != ENStreamBuffering && _state != ENStreamStalled) return;
	if (self.bufferedSeconds < (_state == ENStreamStalled ? _rebuffer : _prebuffer) && !_ended) return;
	if (_inUseCount == 0) return;
	if (_state == ENStreamStalled) {
		double t = [self rawQueuePackets];
		if (t >= 0 && t - _corr > _stallAt) _corr = t - _stallAt;   // the queue clock ran on while it had nothing to play
		ENLog(@"stream gen %ld: playing again after a %.1f s stall (%.1f s buffered)", (long)_gen,
			[NSDate timeIntervalSinceReferenceDate] - _stallStartedAt, self.bufferedSeconds);
	}
	OSStatus e = AudioQueueStart(_aq, NULL);
	if (e) { [self failStatus:0 message:[NSString stringWithFormat:@"AudioQueueStart %d (audio session?)", (int)e]]; return; }
	if (!_queueStarted) {
		_queueStarted = YES;
		_startLatency = [NSDate timeIntervalSinceReferenceDate] - _openedAt;
		ENLog(@"stream gen %ld %@ started %.2f s after opening (%ld kbps, %.1f s buffered, start %@)", (long)_gen, _tier, _startLatency, (long)_kbps, self.bufferedSeconds, _startHow);
	}
	self.state = ENStreamPlaying;
	[self applyMarkers];
	[self heardSoon];      // started, or playing again after a stall
}

- (void)bufferDone:(AudioQueueBufferRef)buf {
	if (_stopped) return;
	for (int i = 0; i < kNumBufs; i++) {
		if (_bufs[i] == buf && _inUse[i]) { _inUse[i] = NO; _inUseCount--; break; }
	}
	[self pump];
	if (_state == ENStreamPlaying && _inUseCount == 0 && _fifo.count == 0 && !_ended) {
		AudioQueuePause(_aq);
		_stallAt = _enqueued;
		_stalls++;
		_stallStartedAt = [NSDate timeIntervalSinceReferenceDate];
		ENLog(@"STALL gen %ld: ran dry, last data %.1f s ago, connection %@, %lu reconnects so far", (long)_gen,
			_lastDataAt > 0 ? _stallStartedAt - _lastDataAt : -1.0, _conn ? @"open" : @"down", (unsigned long)_reconnects);
		[ENDiag flushSoon];
		self.state = ENStreamStalled;
		[self heardSoon];  // the gateway's clock holds here until we play again
	}
}

#pragma mark - timeline

// queue time in packets, or -1
- (double)rawQueuePackets {
	if (!_aq || !_queueStarted) return -1;
	AudioTimeStamp ts;
	memset(&ts, 0, sizeof ts);
	if (AudioQueueGetCurrentTime(_aq, NULL, &ts, NULL) != noErr) return -1;
	if (!(ts.mFlags & kAudioTimeStampSampleTimeValid)) return -1;
	return ts.mSampleTime / _fpp;
}

- (double)playedPackets {
	double raw = [self rawQueuePackets];
	if (raw < 0) return _lastPlayed;
	double p = raw - _corr;
	if (p < _lastPlayed - 0.5) { _corr = raw - _lastPlayed; p = _lastPlayed; }   // the queue's timeline restarted (route change)
	if (p > _enqueued) p = _enqueued;
	if (p < _lastPlayed) p = _lastPlayed;
	_lastPlayed = p;
	return p;
}

- (void)applyMarkers {
	long long heard = (long long)floor([self playedPackets] + 1e-6);
	NSDictionary *newTrack = nil;
	while (_markers.count) {
		NSDictionary *m = _markers[0];
		long long k = [m[@"k"] longLongValue];
		if (k > heard) break;
		[_markers removeObjectAtIndex:0];
		NSDictionary *d = m[@"d"];
		if ([m[@"t"] intValue] == 'P') {
			_anchorMs = [d[@"position_ms"] doubleValue];
			_anchorPkt = k;
			_hasPosition = YES;
		} else {
			newTrack = d;
		}
	}
	if (newTrack && ![newTrack isEqual:_track]) {
		BOOL sameSong = [newTrack[@"uri"] isEqual:_track[@"uri"]];
		_track = newTrack;
		[self heardSoon];
		if (!sameSong && !_stopped) [_delegate streamPlayer:self trackChanged:_track];
	}
}

// packet k (the k-th 'A' record of this generation) -> global frame, across reconnects and quality switches
- (void)addSegmentAt:(long long)k frame:(long long)f {
	if (_segs.count && [[_segs lastObject][@"k"] longLongValue] == k) [_segs removeLastObject];   // that connection brought no audio
	[_segs addObject:@{ @"k": @(k), @"f": @(f) }];
	long long heard = (long long)floor([self playedPackets] + 1e-6);
	while (_segs.count > 1 && [_segs[1][@"k"] longLongValue] <= heard) [_segs removeObjectAtIndex:0];     // already played past
}

- (long long)frameForPacket:(long long)k {
	NSDictionary *seg = _segs.count ? _segs[0] : nil;
	for (NSDictionary *s in _segs) {
		if ([s[@"k"] longLongValue] > k) break;
		seg = s;
	}
	return seg ? [seg[@"f"] longLongValue] + (k - [seg[@"k"] longLongValue]) : -1;
}

- (void)tick {
	if (_stopped) return;
	[self applyMarkers];
	if (_state == ENStreamBuffering || _state == ENStreamStalled) [self pump];
	if ((_state == ENStreamPlaying || _state == ENStreamStalled) && [NSDate timeIntervalSinceReferenceDate] - _heardAt >= kHeardEvery) [self reportHeard];
}

#pragma mark - playhead reports

- (void)heardSoon {
	if (_stopped) return;
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(reportHeard) object:nil];
	[self performSelector:@selector(reportHeard) withObject:nil afterDelay:0 inModes:@[NSRunLoopCommonModes]];
}

// Where this phone is: the gateway paces the engine by it (it never runs more than `lead` ahead) and keeps Spotify's
// position honest. Newest wins: while one is in flight, the next is sent (with fresh numbers) when it returns.
- (void)reportHeard {
	if (_stopped || !_globalFrames || ![ENGateway shared].paired) return;
	if (_state != ENStreamPlaying && _state != ENStreamStalled) return;
	if (_heardBusy) { _heardAgain = YES; return; }
	long long frame = [self frameForPacket:(long long)floor([self playedPackets] + 1e-6)];
	if (frame < 0) return;
	_heardBusy = YES;
	_heardAgain = NO;
	_heardAt = [NSDate timeIntervalSinceReferenceDate];
	NSDictionary *b = @{ @"gen": @(_gen), @"frame": @(frame), @"stalled": @(_state == ENStreamStalled), @"buffered_s": @(round(self.bufferedSeconds * 10) / 10),
	                     @"tier": _tier ?: @"", @"kbps": @(_kbps) };
	[[ENGateway shared] sendMethod:@"POST" path:@"/v1/player/heard" json:b timeout:8 completion:^(id j, NSInteger st, NSError *err) {
		self->_heardBusy = NO;
		if (self->_stopped) return;
		if (st == 200) {
			double lead = [j isKindOfClass:[NSDictionary class]] && [j[@"lead_ms"] respondsToSelector:@selector(doubleValue)] ? [j[@"lead_ms"] doubleValue] : 0;
			if (lead > 0) self->_leadSeconds = lead / 1000;
		} else if (!self->_heardWarned) {
			self->_heardWarned = YES;
			ENLog(@"stream gen %ld: playhead report failed (%ld %@)", (long)self->_gen, (long)st, err ? [NSString stringWithFormat:@"%@ %ld", err.domain, (long)err.code] : @"");
		}
		if (self->_heardAgain) [self reportHeard];
	}];
}

- (double)positionMs {
	if (!_hasPosition) return 0;
	double ms = _anchorMs + ([self playedPackets] - _anchorPkt) * _fpp * 1000.0 / _rate;
	double dur = [_track[@"duration_ms"] doubleValue];
	if (dur > 0 && ms > dur) ms = dur;
	return ms < 0 ? 0 : ms;
}

- (NSDictionary *)takeNetStats {
	NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
	double window = now - _windowStart;
	double sinceData = _lastDataAt > 0 ? now - _lastDataAt : -1;
	NSDictionary *d = @{ @"max_gap_s": @(round(MAX(_maxGap, sinceData) * 100) / 100), @"gaps_over_1s": @(_gaps1), @"gaps_over_3s": @(_gaps3),
	                     @"rx_kbps": @(window > 0 ? round(_windowBytes * 8 / window / 1000) : 0) };
	_maxGap = 0;
	_gaps1 = _gaps3 = 0;
	_windowBytes = 0;
	_windowStart = now;
	return d;
}

// advance the per-second ring to `now`, zeroing the seconds that got no data
- (void)rxRoll:(NSTimeInterval)now {
	long long s = (long long)floor(now);
	for (long long i = _rxSec + 1; i <= s && i <= _rxSec + kRxSecs + 1; i++) _rxBytes[i % (kRxSecs + 1)] = 0;
	if (s > _rxSec) _rxSec = s;
}

// what the network actually delivered over the last 8 whole seconds (independent of the diag window)
- (NSInteger)rx8Kbps {
	[self rxRoll:[NSDate timeIntervalSinceReferenceDate]];
	long long full = MIN((long long)kRxSecs, _rxSec - _rxFrom);
	if (full <= 0) return 0;
	long long sum = 0;
	for (long long i = 1; i <= full; i++) sum += _rxBytes[(_rxSec - i) % (kRxSecs + 1)];
	return (NSInteger)llround(sum * 8.0 / full / 1000.0);
}

- (double)bufferedSeconds {
	double q = _fifo.count + (_enqueued - [self playedPackets]);
	return q * _fpp / _rate;
}

@end

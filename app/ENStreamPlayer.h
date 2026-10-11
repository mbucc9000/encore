#import <Foundation/Foundation.h>

// One generation of the gateway's live stream (GET /v1/stream?gen=N): ENC1 demux -> AudioFileStream (ADTS) -> AudioQueue.
// Track/position markers ride along in the stream and are applied when the audio they belong to is actually heard.
// Network blips are handled here (reconnect with from=<next frame>, the queue keeps playing what it has).
// A quality change is the same trick: reconnect at the new tier from the next frame (gateway 0.4 numbers frames the same
// in every tier). The playhead (global frame being heard) is reported to the gateway (POST /v1/player/heard) so it never
// runs more than `lead` seconds ahead of this phone.

typedef enum {
	ENStreamIdle = 0,
	ENStreamConnecting,
	ENStreamBuffering,
	ENStreamPlaying,
	ENStreamPaused,
	ENStreamStalled,
	ENStreamFailed,
} ENStreamState;

@class ENStreamPlayer;

@protocol ENStreamPlayerDelegate <NSObject>
- (void)streamPlayerStateChanged:(ENStreamPlayer *)sp;
- (void)streamPlayer:(ENStreamPlayer *)sp trackChanged:(NSDictionary *)track;
// The gateway moved on to a newer generation ('Z' or 410). newGen may be 0 if unknown.
- (void)streamPlayer:(ENStreamPlayer *)sp generationEnded:(NSInteger)newGen;
- (void)streamPlayer:(ENStreamPlayer *)sp failedWithStatus:(NSInteger)status message:(NSString *)message;
@end

@interface ENStreamPlayer : NSObject

// prebuffer: seconds to collect before starting; rebuffer: before restarting after running dry
- (instancetype)initWithGen:(NSInteger)gen tier:(NSString *)tier live:(BOOL)live prebuffer:(double)prebuffer rebuffer:(double)rebuffer;

@property (nonatomic, weak) id<ENStreamPlayerDelegate> delegate;
@property (nonatomic, readonly) NSInteger gen;
@property (nonatomic, readonly) NSString *tier;               // streaming now (changes with switchToTier:)
@property (nonatomic, readonly) ENStreamState state;
@property (nonatomic, readonly) NSDictionary *track;          // what is audible right now
@property (nonatomic, readonly) BOOL hasPosition;
@property (nonatomic, readonly) double positionMs;            // within the track, of the audio being heard
@property (nonatomic, readonly) double bufferedSeconds;       // received but not yet heard
@property (nonatomic, readonly) long long bytesReceived;
@property (nonatomic, readonly) NSInteger kbps;
@property (nonatomic, readonly) double startLatency;          // stream opened -> audio started (s), 0 until then
@property (nonatomic, readonly) NSUInteger stalls;
@property (nonatomic, readonly) NSUInteger reconnects;
@property (nonatomic, readonly) NSString *startHow;           // 'audio' | 'silence' | 'start' (from the header)
@property (nonatomic, readonly) BOOL globalFrames;            // header said "frames":"global" (gateway 0.4): seamless switches + reports
@property (nonatomic, readonly) NSDictionary *tierKbps;       // header "tiers" {very_high: 320, ...}, nil from an older gateway
@property (nonatomic, readonly) double leadSeconds;           // how far the gateway runs ahead of this phone (= the full buffer)
@property (nonatomic, readonly) NSInteger rx8Kbps;            // kbps received over the last 8 s (0 = nothing yet)
@property (nonatomic, readonly) NSUInteger switches;

// network health since the last call: max gap between data arrivals, gaps > 1 s / > 3 s, kbps actually received
- (NSDictionary *)takeNetStats;

- (void)start;
- (void)pause;    // instant local silence (AudioQueuePause)
- (void)resume;
- (void)stop;     // tear down; no delegate calls after this

// Reconnect this generation at another quality from the next frame; the queue keeps playing what's buffered.
// NO if it can't be done seamlessly (ended/failed, or an older gateway whose frame numbers differ per tier).
- (BOOL)switchToTier:(NSString *)tier;

@end

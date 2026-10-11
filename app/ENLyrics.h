#import <Foundation/Foundation.h>

// Synced lyrics (app 0.8; owner: DATA; DESIGN-LYRICS.md §2): GET /v1/lyrics (the gateway asks LRCLIB) -> ENLyrics. The
// models are IMMUTABLE once built (on ENCatalog's parse queue), so they are safe to share between threads. Lyrics are
// copyrighted text: nothing here (or in a caller) may log a line's text, only kinds and counts.

@class ENTrack;

typedef enum { ENLyricsSynced = 0, ENLyricsPlain, ENLyricsInstrumental, ENLyricsNone } ENLyricsKind;

@interface ENLyricLine : NSObject
@property (nonatomic, readonly) double timeMs;              // -1 for plain lines
@property (nonatomic, readonly, copy) NSString *text;       // "" = an instrumental gap (the view shows ♪)
@end

@interface ENLyrics : NSObject
@property (nonatomic, readonly, copy) NSString *uri;
@property (nonatomic, readonly) ENLyricsKind kind;
@property (nonatomic, readonly, copy) NSArray *lines;       // ENLyricLine (empty for instrumental / none)
@property (nonatomic, readonly, copy) NSString *source;     // "LRCLIB" (nil if absent)
+ (instancetype)lyricsWithJSON:(NSDictionary *)j;          // nil if j isn't an object with u
- (NSInteger)lineIndexAtMs:(double)ms;                      // synced: index of the last line with timeMs <= ms (binary
                                                            // search); -1 before the first line or when not synced
// GET /v1/lyrics for track (uri, name, artistName, album, durationMs). Main thread; done on the main thread exactly once.
// A memory cache (NSCache, 30 entries, keyed by uri) answers at once (still asynchronously); one request per uri in flight
// (later callers join); timeout 15 s; errors via +[ENCatalog errorWithJSON:status:error:]. track nil / no uri / no name /
// no artist -> done(nil, error 400). fresh: send fresh=1 and skip the memory cache.
+ (void)loadForTrack:(ENTrack *)track fresh:(BOOL)fresh done:(void (^)(ENLyrics *lyrics, NSError *error))done;
@end

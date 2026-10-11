#import <UIKit/UIKit.h>

// Covers (app 0.5; owner: DATA; DESIGN-3 §5.4). Images come only from the gateway (GET /v1/img/<token>?s=88|216|640, a JPEG;
// tokens are opaque and path-safe). Three tiers: 88 px for 44 pt thumbnails (and the 36 pt mini player), 216 px for the
// 108 pt list header, 640 px for Now Playing / the lock screen / the artist header.
//
// Memory: an NSCache with totalCostLimit 14 MB, cost = pixel width x height x 4 (~400 thumbnails at 88 px), for 88 / 216;
// the 640 tier has its own (two covers), so skipping through songs never pushes the list thumbnails out.
// Disk: <Library/Caches>/<bundle id>/img/<sha1(token)>_<s>.jpg, read + decoded on a background queue; a 'u' token's
// file older than 7 days is a miss (fetched again); hex (i.scdn.co) files never expire. Pruned once per launch, 10 s after
// -[ENCatalog start]: over 100 MB, delete oldest by mtime down to 80 MB.
// Network: a LIFO queue, at most 2 downloads in flight, 1 while [ENCatalog shared].loading or [ENPlayback shared].commandPending
// (the events long-poll and the stream already hold two of iOS's connections). A 404 is remembered for the session (done(nil)).
// Decoding is always off the main thread: CGImageCreateWithJPEGDataProvider, drawn into a CGBitmapContext
// (kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little; round = PremultipliedFirst with a circle clip baked in), then
// +[UIImage imageWithCGImage:scale:2 orientation:UIImageOrientationUp]. 88 / 216 come square from the gateway (centre
// crops); 640 keeps the source's aspect (a 300 x 229 custom cover stays 300 x 229 — callers aspect-fill it). So never use
// layer.cornerRadius/masksToBounds on thumbnails: ask for round:YES instead.
//
// Threading: main thread only; `done` runs on the main thread.

typedef enum { ENImg88 = 88, ENImg216 = 216, ENImg640 = 640 } ENImgSize;

@interface ENImageCache : NSObject

+ (instancetype)shared;

+ (NSString *)keyForToken:(NSString *)token size:(ENImgSize)s round:(BOOL)round;   // "token@s" (+ "r" when round)

// The decoded image if it is in memory now (never blocks, never touches disk); nil on a miss or a nil token.
- (UIImage *)memoryImage:(NSString *)token size:(ENImgSize)s round:(BOOL)round;

// Memory, else disk, else network. done(image, key) on the main thread: image nil on a failure / 404 / nil token. A call
// for a key already loading joins it (every done is called). Returns the key (what -cancel: takes). If the image is in
// memory, done is still called asynchronously (next run-loop turn) — use memoryImage: first in cellForRow.
- (NSString *)load:(NSString *)token size:(ENImgSize)s round:(BOOL)round done:(void (^)(UIImage *image, NSString *key))done;

// Drops a request still waiting in the queue (cells cancel their old key in prepareForReuse); its done blocks are not
// called. One already downloading finishes and fills both caches. (DATA: each load: counts and a cancel: takes one back;
// while another caller still counts, e.g. the mini player showing the same cover as a row, the request only moves to the
// back of the queue instead, so that caller still gets its image.)
- (void)cancel:(NSString *)key;

// Called by ENCatalog / ENPlayback when their request ends: start queued downloads that the 1-in-flight rule held back.
- (void)pump;

// Empties the memory cache (memory warning, entering the background; it observes both notifications itself).
- (void)trim;

// Deletes the oldest files while the folder is over 100 MB, down to 80 MB. Background queue; once per launch.
- (void)pruneDisk;

@end

#import "ENImageCache.h"
#import "ENGateway.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENDiag.h"
#import "ENUtil.h"

// Covers (DESIGN-3 §5.4; see ENImageCache.h). A request goes memory -> disk (read + decode on _decodeQueue) -> network
// (LIFO, 2 at a time, 1 while the catalog or a player command is waiting) -> decode -> memory + disk. Requests for the
// same key share one ENImgRequest. Every load: is counted and a cancel: takes one back: at zero the queued request is
// dropped (its dones never run); while some other caller still counts (the mini player showing the same album cover as a
// Liked row) it only moves to the back of the queue, so that caller still gets its image. Cells redraw only when their
// key still matches, so a done for a cell that moved on is harmless.

static const NSUInteger ENMemoryCost = 14 * 1024 * 1024;
static const NSUInteger ENBigCost = 2 * 640 * 640 * 4;          // the 640 tier: two square covers (~3.1 MB)
static const NSTimeInterval ENTokenURLMaxAge = 7 * 86400;     // 'u' tokens: other hosts may change the picture
static const unsigned long long ENDiskHigh = 100ULL * 1024 * 1024, ENDiskLow = 80ULL * 1024 * 1024;

typedef enum { ENImgStageDisk = 0, ENImgStageQueued, ENImgStageLoading } ENImgStage;

@interface ENImgRequest : NSObject
@property (nonatomic, copy) NSString *key;
@property (nonatomic, copy) NSString *token;
@property (nonatomic) ENImgSize size;
@property (nonatomic) BOOL round;
@property (nonatomic) ENImgStage stage;
@property (nonatomic) NSInteger wanted;                  // load: calls minus cancel: calls
@property (nonatomic, strong) NSMutableArray *dones;
@property (atomic) BOOL cancelled;                       // read on _decodeQueue: skip the disk read
@end
@implementation ENImgRequest
@end

static ENImgSize ENImgTier(ENImgSize s) {
	return s <= ENImg88 ? ENImg88 : s <= ENImg216 ? ENImg216 : ENImg640;
}

// JPEG (the gateway always sends one; PNG just in case) -> a decoded bitmap at the tier's size, scale 2. 88 / 216: a square,
// aspect-fill centred (round: alpha with a circle clip baked in); 640: the source's aspect, at most 640 px, never upscaled.
static UIImage *ENDecodeImage(NSData *data, ENImgSize s, BOOL round) {
	if (!data.length) return nil;
	CGDataProviderRef dp = CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
	if (!dp) return nil;
	CGImageRef src = CGImageCreateWithJPEGDataProvider(dp, NULL, false, kCGRenderingIntentDefault);
	if (!src) src = CGImageCreateWithPNGDataProvider(dp, NULL, false, kCGRenderingIntentDefault);
	CGDataProviderRelease(dp);
	if (!src) return nil;
	size_t w = CGImageGetWidth(src), h = CGImageGetHeight(src);
	if (!w || !h) { CGImageRelease(src); return nil; }
	size_t pw, ph;
	if (s == ENImg640 && !round) {
		double k = MIN(1.0, 640.0 / (double)MAX(w, h));
		pw = MAX((size_t)1, (size_t)floor(w * k + 0.5));
		ph = MAX((size_t)1, (size_t)floor(h * k + 0.5));
	} else {
		pw = ph = s == ENImg640 ? MIN((size_t)640, MIN(w, h)) : (size_t)s;
	}
	CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
	CGBitmapInfo info = round ? ((CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little)
	                          : ((CGBitmapInfo)kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
	CGContextRef ctx = CGBitmapContextCreate(NULL, pw, ph, 8, 0, cs, info);
	CGColorSpaceRelease(cs);
	if (!ctx) { CGImageRelease(src); return nil; }
	CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
	if (round) {
		CGContextAddEllipseInRect(ctx, CGRectMake(0, 0, (CGFloat)pw, (CGFloat)ph));
		CGContextClip(ctx);
	}
	double k = MAX((double)pw / w, (double)ph / h);
	double dw = w * k, dh = h * k;
	CGContextDrawImage(ctx, CGRectMake((CGFloat)((pw - dw) / 2), (CGFloat)((ph - dh) / 2), (CGFloat)dw, (CGFloat)dh), src);
	CGImageRelease(src);
	CGImageRef out = CGBitmapContextCreateImage(ctx);
	CGContextRelease(ctx);
	if (!out) return nil;
	UIImage *img = [UIImage imageWithCGImage:out scale:2 orientation:UIImageOrientationUp];
	CGImageRelease(out);
	return img;
}

static NSUInteger ENImageCost(UIImage *img) {
	return (NSUInteger)(img.size.width * img.scale * img.size.height * img.scale * 4);
}

static BOOL ENTokenOK(NSString *t) {        // [A-Za-z0-9_-]{1,600}: path-safe as it is
	if (!t.length || t.length > 600) return NO;
	for (NSUInteger i = 0; i < t.length; i++) {
		unichar c = [t characterAtIndex:i];
		if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '-')) return NO;
	}
	return YES;
}

@implementation ENImageCache {
	NSCache *_mem;                         // 88 / 216
	NSCache *_big;                         // 640 (Now Playing, the artist header): apart, so a few big covers never push
	                                       // out hundreds of thumbnails (ENPlayback holds the current song's itself)
	NSMutableDictionary *_reqs;            // key -> ENImgRequest (disk, queued or loading)
	NSMutableArray *_queue;                // waiting for the network; the last one goes next (LIFO)
	NSInteger _inFlight;
	NSMutableSet *_gone;                   // tokens the gateway answered 404 for (this session)
	dispatch_queue_t _decodeQueue;         // disk reads + decodes (serial: the other core stays with the main thread)
	dispatch_queue_t _ioQueue;             // file writes, the prune
	NSString *_dir;
	BOOL _pruned;
}

+ (instancetype)shared {
	static ENImageCache *c;
	static dispatch_once_t once;
	dispatch_once(&once, ^{ c = [[ENImageCache alloc] init]; });
	return c;
}

- (instancetype)init {
	if ((self = [super init])) {
		_mem = [[NSCache alloc] init];
		_mem.totalCostLimit = ENMemoryCost;
		_big = [[NSCache alloc] init];
		_big.totalCostLimit = ENBigCost;
		_reqs = [NSMutableDictionary dictionary];
		_queue = [NSMutableArray array];
		_gone = [NSMutableSet set];
		_decodeQueue = dispatch_queue_create("com.mbucc9000.encore.img.decode", DISPATCH_QUEUE_SERIAL);
		_ioQueue = dispatch_queue_create("com.mbucc9000.encore.img.io", DISPATCH_QUEUE_SERIAL);
		dispatch_set_target_queue(_ioQueue, dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_BACKGROUND, 0));
		_dir = ENCacheDir(@"img");
		NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
		[nc addObserver:self selector:@selector(trim) name:UIApplicationDidReceiveMemoryWarningNotification object:nil];
		[nc addObserver:self selector:@selector(trim) name:UIApplicationDidEnterBackgroundNotification object:nil];
	}
	return self;
}

+ (NSString *)keyForToken:(NSString *)token size:(ENImgSize)s round:(BOOL)round {
	if (!ENJStr(token)) return nil;
	return [NSString stringWithFormat:@"%@@%d%@", token, (int)ENImgTier(s), round ? @"r" : @""];
}

- (NSCache *)cacheFor:(ENImgSize)s {
	return ENImgTier(s) == ENImg640 ? _big : _mem;
}

- (UIImage *)memoryImage:(NSString *)token size:(ENImgSize)s round:(BOOL)round {
	NSString *key = [ENImageCache keyForToken:token size:s round:round];
	return key ? [[self cacheFor:s] objectForKey:key] : nil;
}

- (NSString *)fileForToken:(NSString *)token size:(ENImgSize)s {
	return [_dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@_%d.jpg", ENSHA1Hex(token), (int)s]];
}

- (NSString *)load:(NSString *)token size:(ENImgSize)s round:(BOOL)round done:(void (^)(UIImage *image, NSString *key))done {
	s = ENImgTier(s);
	NSString *key = [ENImageCache keyForToken:token size:s round:round];
	void (^d)(UIImage *, NSString *) = [done copy];
	if (!key) {
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(nil, nil); });
		return nil;
	}
	UIImage *m = [[self cacheFor:s] objectForKey:key];
	if (m || [_gone containsObject:token]) {
		if (d) dispatch_async(dispatch_get_main_queue(), ^{ d(m, key); });
		return key;
	}
	ENImgRequest *r = _reqs[key];
	if (r) {
		r.wanted++;
		r.cancelled = NO;
		if (d) [r.dones addObject:d];
		if (r.stage == ENImgStageQueued) {     // asked for again: it's what is on screen now
			[_queue removeObjectIdenticalTo:r];
			[_queue addObject:r];
		}
		return key;
	}
	r = [[ENImgRequest alloc] init];
	r.key = key;
	r.token = token;
	r.size = s;
	r.round = round;
	r.wanted = 1;
	r.dones = [NSMutableArray array];
	if (d) [r.dones addObject:d];
	_reqs[key] = r;
	[self readDisk:r];
	return key;
}

- (void)readDisk:(ENImgRequest *)r {
	r.stage = ENImgStageDisk;
	NSString *path = [self fileForToken:r.token size:r.size];
	BOOL expires = [r.token hasPrefix:@"u"];
	ENImgSize s = r.size;
	BOOL round = r.round;
	dispatch_async(_decodeQueue, ^{
		UIImage *img = nil;
		BOOL skipped = r.cancelled;
		if (!skipped) {
			NSFileManager *fm = [NSFileManager defaultManager];
			BOOL fresh = YES;
			if (expires) {
				NSDate *at = [[fm attributesOfItemAtPath:path error:NULL] fileModificationDate];
				fresh = !at || -[at timeIntervalSinceNow] < ENTokenURLMaxAge;
			}
			NSData *data = fresh ? [NSData dataWithContentsOfFile:path] : nil;
			if (data.length) img = ENDecodeImage(data, s, round);
			if (!img && (data.length || !fresh)) [fm removeItemAtPath:path error:NULL];     // unreadable or expired
		}
		dispatch_async(dispatch_get_main_queue(), ^{ [self disk:r answered:img skipped:skipped]; });
	});
}

- (void)disk:(ENImgRequest *)r answered:(UIImage *)img skipped:(BOOL)skipped {
	if (_reqs[r.key] != r) return;
	if (img) { [self finish:r image:img]; return; }        // a cancelled one still fills memory (it was read anyway)
	if (r.wanted <= 0) { [_reqs removeObjectForKey:r.key]; return; }
	if (skipped) { [self readDisk:r]; return; }            // cancelled, then asked for again before the read began
	if ([_gone containsObject:r.token]) { [self finish:r image:nil]; return; }
	r.stage = ENImgStageQueued;
	[_queue addObject:r];
	[self pump];
}

- (void)cancel:(NSString *)key {
	if (!key) return;
	ENImgRequest *r = _reqs[key];
	if (!r) return;
	if (--r.wanted > 0) {                  // someone else still waits for it: last in line instead of dropped
		if (r.stage == ENImgStageQueued && _queue.count > 1) {
			[_queue removeObjectIdenticalTo:r];
			[_queue insertObject:r atIndex:0];
		}
		return;
	}
	r.wanted = 0;
	[r.dones removeAllObjects];
	if (r.stage == ENImgStageQueued) {
		[_queue removeObjectIdenticalTo:r];
		[_reqs removeObjectForKey:key];
	} else if (r.stage == ENImgStageDisk) {
		r.cancelled = YES;                 // a hit still fills memory; a miss isn't fetched
	}                                      // loading: finishes and fills both caches
}

- (void)pump {
	NSInteger limit = ([ENCatalog shared].loading || [ENPlayback shared].commandPending) ? 1 : 2;
	while (_inFlight < limit && _queue.count) {
		ENImgRequest *r = [_queue lastObject];
		[_queue removeLastObject];
		[self download:r];
	}
}

- (void)download:(ENImgRequest *)r {
	if (!ENTokenOK(r.token) || ![ENGateway shared].paired) {
		[self finish:r image:nil];
		return;
	}
	r.stage = ENImgStageLoading;
	_inFlight++;
	NSString *path = [NSString stringWithFormat:@"/v1/img/%@?s=%d", r.token, (int)r.size];
	[[ENGateway shared] fetchData:path etag:nil timeout:20 completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		self->_inFlight--;
		if (st == 200 && data.length) {
			NSString *file = [self fileForToken:r.token size:r.size];
			dispatch_async(self->_ioQueue, ^{ [data writeToFile:file atomically:YES]; });
			ENImgSize s = r.size;
			BOOL round = r.round;
			dispatch_async(self->_decodeQueue, ^{
				UIImage *img = ENDecodeImage(data, s, round);
				dispatch_async(dispatch_get_main_queue(), ^{ [self finish:r image:img]; });
			});
		} else {
			if (st == 404) [self->_gone addObject:r.token];      // image_gone: the placeholder for the rest of the session
			[self finish:r image:nil];
		}
		[self pump];
	}];
}

- (void)finish:(ENImgRequest *)r image:(UIImage *)img {
	if (img) [[self cacheFor:r.size] setObject:img forKey:r.key cost:ENImageCost(img)];
	if (_reqs[r.key] == r) [_reqs removeObjectForKey:r.key];
	NSArray *ds = [r.dones copy];
	[r.dones removeAllObjects];
	for (void (^d)(UIImage *, NSString *) in ds) d(img, r.key);
}

- (void)trim {
	[_mem removeAllObjects];
	[_big removeAllObjects];
}

- (void)pruneDisk {
	if (_pruned) return;
	_pruned = YES;
	NSString *dir = _dir;
	dispatch_async(_ioQueue, ^{
		NSFileManager *fm = [NSFileManager defaultManager];
		NSMutableArray *files = [NSMutableArray array];
		unsigned long long total = 0;
		for (NSString *name in [fm contentsOfDirectoryAtPath:dir error:NULL]) {
			NSString *path = [dir stringByAppendingPathComponent:name];
			NSDictionary *a = [fm attributesOfItemAtPath:path error:NULL];
			if (![[a fileType] isEqualToString:NSFileTypeRegular]) continue;
			unsigned long long size = [a fileSize];
			total += size;
			[files addObject:@{ @"p": path, @"s": @(size), @"t": [a fileModificationDate] ?: [NSDate distantPast] }];
		}
		if (total <= ENDiskHigh) return;
		NSArray *oldest = [files sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *x, NSDictionary *y) {
			return [(NSDate *)x[@"t"] compare:y[@"t"]];
		}];
		unsigned long long before = total;
		NSUInteger n = 0;
		for (NSDictionary *f in oldest) {
			if (total <= ENDiskLow) break;
			if ([fm removeItemAtPath:f[@"p"] error:NULL]) {
				total -= [(NSNumber *)f[@"s"] unsignedLongLongValue];
				n++;
			}
		}
		ENLog(@"covers: pruned %lu files, %.1f MB -> %.1f MB", (unsigned long)n, before / 1048576.0, total / 1048576.0);
	});
}

@end

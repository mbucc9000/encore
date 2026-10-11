#import "ENDiag.h"
#import "ENGateway.h"
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#include <signal.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <mach/mach.h>

double ENLaunchStart = 0;                      // main() sets it first thing (0.5: launch_ms)

static NSMutableArray *gLines;                 // @{t: unix seconds, m: text}, oldest first
static NSDictionary *(^gStats)(void);
static BOOL gUploading;
static NSTimer *gTimer;
static char gCrashPath[1024];

void ENLog(NSString *format, ...) {
	va_list ap;
	va_start(ap, format);
	NSString *m = [[NSString alloc] initWithFormat:format arguments:ap];
	va_end(ap);
	NSLog(@"[Encore] %@", m);
	NSDictionary *line = @{ @"t": @([[NSDate date] timeIntervalSince1970]), @"m": m };
	void (^add)(void) = ^{
		if (!gLines) gLines = [NSMutableArray array];
		[gLines addObject:line];
		if (gLines.count > 600) [gLines removeObjectsInRange:NSMakeRange(0, gLines.count - 600)];
	};
	if ([NSThread isMainThread]) add();
	else dispatch_async(dispatch_get_main_queue(), add);
}

// ---------------------------------------------------------------- crash capture (written now, reported next launch)

static void ENCrashWrite(const char *s) {
	int fd = open(gCrashPath, O_WRONLY | O_CREAT | O_APPEND, 0644);
	if (fd < 0) return;
	write(fd, s, strlen(s));
	write(fd, "\n", 1);
	close(fd);
}

static void ENOnSignal(int sig) {           // async-signal-safe only
	char buf[48] = "crash: signal ";
	char num[8];
	int n = sig, i = 0;
	do { num[i++] = (char)('0' + n % 10); n /= 10; } while (n && i < 7);
	size_t l = strlen(buf);
	while (i > 0) buf[l++] = num[--i];
	buf[l] = 0;
	ENCrashWrite(buf);
	signal(sig, SIG_DFL);
	raise(sig);
}

static void ENOnException(NSException *e) {
	NSString *s = [NSString stringWithFormat:@"crash: exception %@: %@ | %@", e.name, e.reason,
		[[e.callStackSymbols subarrayWithRange:NSMakeRange(0, MIN((NSUInteger)12, e.callStackSymbols.count))] componentsJoinedByString:@" | "]];
	ENCrashWrite(s.UTF8String);
}

@implementation ENDiag

+ (void)start {
	if (gTimer) return;
	NSString *dir = [[NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES) objectAtIndex:0] stringByAppendingPathComponent:@"Encore"];
	[[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
	NSString *crash = [dir stringByAppendingPathComponent:@"crash.txt"];
	strlcpy(gCrashPath, crash.fileSystemRepresentation, sizeof gCrashPath);

	NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
	NSString *version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
	double lastBeat = [ud doubleForKey:@"diagLastBeat"];
	NSString *prev = lastBeat > 0 ? [NSString stringWithFormat:@"previous session last seen %.0f s ago%@", [[NSDate date] timeIntervalSince1970] - lastBeat,
		[ud boolForKey:@"diagWasPlaying"] ? @", it was PLAYING then (killed or crashed mid-playback)" : @""] : @"first run";
	ENLog(@"launch %@ on iOS %@ (%@)", version, [[UIDevice currentDevice] systemVersion], prev);
	NSString *crashText = [NSString stringWithContentsOfFile:crash encoding:NSUTF8StringEncoding error:NULL];
	if (crashText.length) {
		for (NSString *l in [crashText componentsSeparatedByString:@"\n"]) if (l.length) ENLog(@"previous run: %@", l);
		[[NSFileManager defaultManager] removeItemAtPath:crash error:NULL];
	}
	[ud setBool:NO forKey:@"diagWasPlaying"];

	NSSetUncaughtExceptionHandler(&ENOnException);
	int sigs[] = { SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGTRAP };
	for (unsigned i = 0; i < sizeof sigs / sizeof sigs[0]; i++) signal(sigs[i], ENOnSignal);

	gTimer = [NSTimer timerWithTimeInterval:30 target:self selector:@selector(tick) userInfo:nil repeats:YES];
	[[NSRunLoop mainRunLoop] addTimer:gTimer forMode:NSRunLoopCommonModes];
	[self flushSoon];
}

+ (void)setStatsProvider:(NSDictionary *(^)(void))provider { gStats = [provider copy]; }

+ (void)flushSoon {
	dispatch_async(dispatch_get_main_queue(), ^{
		[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(upload) object:nil];
		[self performSelector:@selector(upload) withObject:nil afterDelay:2.0 inModes:@[NSRunLoopCommonModes]];
	});
}

+ (void)tick {
	[[NSUserDefaults standardUserDefaults] setDouble:[[NSDate date] timeIntervalSince1970] forKey:@"diagLastBeat"];
	[self upload];
}

// ---------------------------------------------------------------- 0.5 measurements (DESIGN-3 §7.2)

+ (void)launchFinished {
	static BOOL done;
	if (done) return;
	done = YES;
	if (ENLaunchStart <= 0) { ENLog(@"launch_ms ? (no start time)"); return; }
	ENLog(@"launch_ms %.0f", (CFAbsoluteTimeGetCurrent() - ENLaunchStart) * 1000);
}

// Frame meter for one fling: a CADisplayLink in the common modes (it ticks while the table tracks / decelerates).
static CADisplayLink *gMeter;
static NSString *gMeterWhat;
static CFTimeInterval gMeterLast, gMeterMaxGap;
static NSUInteger gMeterFrames, gMeterDropped;

+ (void)scrollBegan:(NSString *)what {
	if (gMeter) [self scrollEnded];
	gMeterWhat = [what copy] ?: @"?";
	gMeterLast = 0;
	gMeterMaxGap = 0;
	gMeterFrames = 0;
	gMeterDropped = 0;
	gMeter = [CADisplayLink displayLinkWithTarget:self selector:@selector(meterTick:)];
	[gMeter addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
}

+ (void)meterTick:(CADisplayLink *)link {
	CFTimeInterval t = link.timestamp;
	if (gMeterLast > 0) {
		CFTimeInterval gap = t - gMeterLast;
		gMeterFrames++;
		if (gap > gMeterMaxGap) gMeterMaxGap = gap;
		if (gap > 1.5 / 60) gMeterDropped += (NSUInteger)MAX(1.0, floor(gap * 60 + 0.5) - 1);    // the frames that gap skipped
	}
	gMeterLast = t;
}

+ (void)scrollEnded {
	if (!gMeter) return;
	[gMeter invalidate];
	gMeter = nil;
	if (!gMeterFrames) return;
	NSUInteger shown = gMeterFrames + gMeterDropped;
	ENLog(@"scroll %@: %lu frames, %lu dropped (%.1f %%), max gap %.0f ms", gMeterWhat, (unsigned long)gMeterFrames,
		(unsigned long)gMeterDropped, shown ? 100.0 * gMeterDropped / shown : 0.0, gMeterMaxGap * 1000);
}

+ (double)residentMB {
	struct task_basic_info info;
	mach_msg_type_number_t count = TASK_BASIC_INFO_COUNT;
	if (task_info(mach_task_self(), TASK_BASIC_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) return 0;
	return info.resident_size / 1048576.0;
}

+ (void)upload {
	if (gUploading || ![ENGateway shared].paired) return;
	NSArray *batch = [gLines copy] ?: @[];
	// the only reader of the stats: collecting them resets the stream's network window (rx_kbps, gaps)
	NSDictionary *stats = gStats ? gStats() : nil;
	if (stats) [[NSUserDefaults standardUserDefaults] setBool:[stats[@"playing"] boolValue] forKey:@"diagWasPlaying"];
	NSMutableDictionary *body = [NSMutableDictionary dictionary];
	body[@"lines"] = batch;
	if (stats) body[@"stats"] = stats;
	gUploading = YES;
	[[ENGateway shared] sendMethod:@"POST" path:@"/v1/diag" json:body timeout:20 completion:^(id j, NSInteger st, NSError *err) {
		gUploading = NO;
		if (st == 200) [gLines removeObjectsInArray:batch];
	}];
}

@end

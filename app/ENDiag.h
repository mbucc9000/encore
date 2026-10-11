#import <Foundation/Foundation.h>

// Diagnostics: a ring of recent log lines plus a stats snapshot, uploaded to the gateway (POST /v1/diag) every 30 s
// and soon after anything notable (stalls, failures). The gateway keeps them per device, so a listening session can
// be read from both ends without plugging the phone in. Also records crashes and reports them on the next launch.
// (0.5 owner: DATA, including main.m's ENLaunchStart.)

void ENLog(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);

// 0.5: CFAbsoluteTimeGetCurrent() at the top of main() (main.m sets it), for launch_ms.
extern double ENLaunchStart;

@interface ENDiag : NSObject
+ (void)start;
+ (void)flushSoon;                                          // upload within a couple of seconds
+ (void)setStatsProvider:(NSDictionary *(^)(void))provider;

// ---- 0.5 measurements (DESIGN-3 §7.2). Main thread.
+ (void)launchFinished;                                     // logs "launch_ms N" once per process (later calls do nothing): the
                                                            // Playlists root calls it from viewDidAppear once its visible
                                                            // covers are drawn (or after a short grace when some aren't cached)
+ (void)scrollBegan:(NSString *)what;                       // starts a frame meter (CADisplayLink in common modes) for a fling
                                                            // of `what` ("playlists", "liked", "list Quiet"...)
+ (void)scrollEnded;                                        // stops it and logs "scroll <what>: N frames, M dropped, max gap X ms"
                                                            // (a frame is dropped when the gap exceeds 1.5/60 s); no-op if idle
+ (double)residentMB;                                       // task_info resident size of this process, in MB
@end

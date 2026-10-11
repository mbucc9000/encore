#import <Foundation/Foundation.h>

// Small shared helpers (app 0.5; owner: DATA; Drop 3c: C1 adds ENFadeIn): guards for the gateway's JSON, the text formats
// every screen shares, the cache folder. Plain C functions, safe on any thread (the parse queue uses them too), except the
// two UIKit helpers at the end (main thread only). This header stays Foundation-only (UIView is a forward declaration).

@class UIView;

// ---- JSON guards. The gateway never sends null (DESIGN-3 §3.1), but a value of the wrong type must never crash a parse.
NSString *ENJStr(id v);                          // a non-empty NSString, else nil
NSInteger ENJInt(id v, NSInteger dflt);          // an NSNumber (or a numeric NSString), else dflt
long long ENJLong(id v, long long dflt);         // same, 64-bit (durations and totals in ms)
BOOL ENJFlag(id v);                              // the gateway's flags: 1 / true = YES; absent, 0, anything else = NO
NSArray *ENJArr(id v);                           // an NSArray, else nil
NSDictionary *ENJDict(id v);                     // an NSDictionary, else nil

// ---- ids and files
NSString *ENIDFromURI(NSString *uri);            // "spotify:playlist:<id>" -> "<id>" (after the last ':'); nil for nil / no ':'
NSString *ENSHA1Hex(NSString *s);                // 40 lowercase hex of the UTF-8 bytes (CommonCrypto)
NSString *ENCacheDir(NSString *sub);             // <Library/Caches>/<bundle id>/<sub> (the app is unsandboxed, so it needs the
                                                 // bundle-id folder: /var/mobile/Library/Caches/<bundle id>/...), created on
                                                 // first use; sub "json" = ENCatalog, "img" = ENImageCache, "ui" = drawn art

// ---- text, exactly as the screens show it
NSString *ENTimeText(double ms);                 // "3:07"; "1:02:03" from one hour; "0:00" for <= 0
NSString *ENDurationText(long long ms);          // list footers: "1 hr 23 min", "45 min", "1 min" (never "0 min" for > 0)
NSString *ENCountText(NSInteger n, NSString *one, NSString *many);    // "1 song", "1,234 songs" (grouped digits)
NSString *ENRelativeTime(NSDate *d);             // "just now" (< 1 min), "5 min ago", "2 hr ago", "yesterday", else "Oct 3"

// ---- (3c, C1; DESIGN-5 §1.7 C11) the picture fade. Main thread only.
// A 0.18 s ease-out cross-fade (a CATransition of type fade, under the layer's "transition" key) from what the view shows now
// to what it shows once this run-loop turn's change is drawn: a new image, a -setNeedsDisplay redraw. Call it in the same
// turn as the change (before or after it), and ONLY when the picture arrived from disk or the network (an async
// ENImageCache done), never for a memory hit (P4: no fades while scrolling through cached rows). Nothing happens for a nil or
// hidden view or one that is not on screen (no window). A second call replaces a fade still running.
void ENFadeIn(UIView *v);
// Stops a fade still running on the view (a reused cell before it shows other content); safe when there is none.
void ENFadeInCancel(UIView *v);

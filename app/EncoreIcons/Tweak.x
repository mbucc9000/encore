// Encore Icons: lets Encore change its own home screen icon (in Encore: Settings, Appearance, App Icon).
// Spec: DESIGN-APP-ICONS.md §5-6. Loads into SpringBoard only.
//
// - Only com.mbucc9000.encore is touched. Its icon becomes <Encore.app>/AppIcons/<id>/Icon*.png, where <id> is the
//   "appIcon" value in /var/mobile/Library/Preferences/com.mbucc9000.encore.plist. A missing, "encore" or unknown
//   value, or a missing file, leaves the stock icon.
// - Encore posts the Darwin notification com.mbucc9000.encore.iconchanged after saving; the icon is then redrawn in
//   place (no respring, no uicache).
// - Encore's Settings asks whether this add-on runs: at load the libnotify name com.mbucc9000.encore.iconsloaded gets
//   SpringBoard's pid as its state (the token is kept, never cancelled). Contract: app/ENAppIcons.m.
// - Every private class and selector is checked before use: iOS 6.1 was read from the SDK's SpringBoard and UIKit
//   binaries, iOS 5 could not be checked. Deployment is 5.0: no subscripting, no @available.
//
// How iOS 6.1 SpringBoard draws an app icon (disassembled, armv7s slice):
// - -[SBIcon getIconImage:f] returns its per-format slot, else -generateIconImage:f (and keeps it in the slot).
//   Background generation fills the slot without calling -generateIconImage:, so both methods are hooked.
// - -[SBApplicationIcon generateIconImage:f] is UIKit's +_applicationIconImageForBundleIdentifier:format:f scale:,
//   so SpringBoard's format numbers are UIKit's: the art goes through
//   -[UIImage _applicationIconImageForFormat:f precomposed:YES scale:] and gets the stock mask and shadow.
// - -reloadIconImagePurgingImageCache:YES empties the slots, then -_notifyImageDidUpdate sends -iconImageDidUpdate:
//   to the views and folder icons in the icon's _observers table only.
// - An SBIconView's picture (_iconImageView.image) is written only by -setDisplayedIconImage:, and that is reached
//   only from -iconImageDidUpdate: and from -setIcon: with a different icon (-setIcon: returns early for the same
//   icon). A view that is not in the reloaded icon object's _observers at that moment keeps its old picture until
//   the views are rebuilt (respring). So after the stock reload every Encore icon view SpringBoard holds (the
//   homescreen and switcher maps, plus every SBIconView in SpringBoard's windows and home screen tree) is checked
//   and repainted directly if it still shows something else, and folder icons that contain Encore are reloaded too.
#import <UIKit/UIKit.h>
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreFoundation/CoreFoundation.h>
#include <sys/time.h>
#include <time.h>
#include <string.h>
#include <execinfo.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <notify.h>
#include <unistd.h>

#define kEncoreID   @"com.mbucc9000.encore"
#define kPrefsPath  @"/var/mobile/Library/Preferences/com.mbucc9000.encore.plist"
#define kPrefKey    @"appIcon"
#define kStockID    @"encore"
#define kAppPath    @"/Applications/Encore.app"
#define kChanged    "com.mbucc9000.encore.iconchanged"
#define kLoaded     "com.mbucc9000.encore.iconsloaded"   // libnotify state = SpringBoard's pid while this add-on runs
#define kLogPath    "/var/mobile/Library/Logs/EncoreIcons.log"
#define kWatchSecs  60.0    // debug build: how long after load or a change every Encore image request is logged

#ifndef EI_DEBUG
#define EI_DEBUG 0
#endif

@interface SBApplication : NSObject
- (NSString *)bundleIdentifier;
- (NSString *)path;
@end

@interface SBIcon : NSObject
- (NSString *)leafIdentifier;
- (NSString *)applicationBundleID;
- (void)reloadIconImagePurgingImageCache:(BOOL)purge;
- (void)reloadIconImage;
- (void)purgeCachedImages;
- (void)_notifyImageDidUpdate;
- (UIImage *)getStandardIconImageForLocation:(int)location;
- (BOOL)hasObserver:(id)observer;
- (BOOL)isFolderIcon;
- (BOOL)containsNodeIdentifier:(id)ident;
@end

@interface SBApplicationIcon : SBIcon
- (SBApplication *)application;
@end

@interface SBIconModel : NSObject
+ (id)sharedInstance;
- (SBIcon *)applicationIconForDisplayIdentifier:(NSString *)ident;
- (SBIcon *)leafIconForIdentifier:(NSString *)ident;
- (SBIcon *)expectedIconForDisplayIdentifier:(NSString *)ident;
@end

@interface SBIconController : NSObject
+ (id)sharedInstance;
- (SBIconModel *)model;
- (UIView *)dockContainerView;
@end

@interface SBIconView : UIView
- (SBIcon *)icon;
- (int)location;
- (UIImageView *)iconImageView;
- (void)iconImageDidUpdate:(SBIcon *)icon;
- (void)setDisplayedIconImage:(UIImage *)image;
@end

@interface SBIconViewMap : NSObject
+ (id)homescreenMap;
+ (id)switcherMap;
- (SBIconView *)mappedIconViewForIcon:(SBIcon *)icon;
@end

@interface UIImage (EIPrivate)
- (UIImage *)_applicationIconImageForFormat:(int)format precomposed:(BOOL)precomposed scale:(CGFloat)scale;
@end

// All of these are guarded by gLock: -generateIconImage: may run off the main thread.
static NSObject *gLock;
static NSString *gIcon = kStockID;          // the chosen id; "encore" = the stock icon
static NSMutableDictionary *gCache;         // SB format -> finished icon for gIcon
static NSUInteger gGen;                     // bumped on every change; a render begun before it is not used
static NSMutableDictionary *gUIKitFormat;   // SB format -> UIKit format whose size matched (-1: none did)
static CFAbsoluteTime gWatchUntil;          // debug build: log every Encore image request until then

// ---- debug log -----------------------------------------------------------------------------------------------

static void EILogf(NSString *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    NSString *s = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    struct timeval tv;
    gettimeofday(&tv, NULL);
    time_t secs = tv.tv_sec;
    struct tm tm;
    localtime_r(&secs, &tm);
    char ts[32];
    strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", &tm);
    FILE *f = fopen(kLogPath, "a");
    if (!f) return;
    fprintf(f, "%s.%03d %s\n", ts, (int)(tv.tv_usec / 1000), [s UTF8String]);
    fclose(f);
}
// Release builds compile the calls out (make package EI_DEBUG=1 turns them on).
#define EILog(...) do { if (EI_DEBUG) EILogf(__VA_ARGS__); } while (0)

static BOOL EIWatching(void) {
    if (!EI_DEBUG) return NO;
    CFAbsoluteTime until;
    @synchronized (gLock) {
        until = gWatchUntil;
    }
    return CFAbsoluteTimeGetCurrent() < until;
}

static void EIWatch(void) {
    if (!EI_DEBUG) return;
    @synchronized (gLock) {
        gWatchUntil = CFAbsoluteTimeGetCurrent() + kWatchSecs;
    }
}

static NSString *EIImg(UIImage *img) {
    if (!img) return @"nil";
    return [NSString stringWithFormat:@"%p %.0fx%.0f@%.0fx", img, img.size.width, img.size.height, img.scale];
}

// The callers outside this dylib, as image:unslid-return-address (SpringBoard's match its disassembly, minus 1
// for the Thumb bit).
static NSString *EICallers(int count) {
    void *frames[24];
    int n = backtrace(frames, 24);
    NSMutableString *s = [NSMutableString string];
    int shown = 0;
    for (int i = 1; i < n && shown < count; i++) {
        Dl_info info;
        if (!dladdr(frames[i], &info) || !info.dli_fname) {
            [s appendFormat:@" %p", frames[i]];
            shown++;
            continue;
        }
        const char *base = strrchr(info.dli_fname, '/');
        base = base ? base + 1 : info.dli_fname;
        if (strstr(base, "EncoreIcons")) continue;
        intptr_t slide = 0;
        uint32_t images = _dyld_image_count();
        for (uint32_t k = 0; k < images; k++) {
            if ((const void *)_dyld_get_image_header(k) == info.dli_fbase) {
                slide = _dyld_get_image_vmaddr_slide(k);
                break;
            }
        }
        [s appendFormat:@" %s:0x%lx", base, (unsigned long)((uintptr_t)frames[i] - (uintptr_t)slide)];
        shown++;
    }
    return s;
}

// ---- the preference ------------------------------------------------------------------------------------------

static NSString *EIValid(id v) {
    if (![v isKindOfClass:[NSString class]]) return kStockID;
    NSArray *ids = [NSArray arrayWithObjects:@"classic", @"round", @"2013", @"flat", @"disco", nil];
    for (NSString *s in ids) {
        if ([s isEqualToString:v]) return s;
    }
    return kStockID;
}

// The file itself, not CFPreferences: SpringBoard's in-process cache would not see Encore's write (no cfprefsd on
// iOS 5/6).
static NSString *EIReadPref(void) {
    NSDictionary *d = [NSDictionary dictionaryWithContentsOfFile:kPrefsPath];
    return EIValid([d isKindOfClass:[NSDictionary class]] ? [d objectForKey:kPrefKey] : nil);
}

// ---- which icon ----------------------------------------------------------------------------------------------

static BOOL EIIsEncore(SBIcon *icon) {
    if (!icon) return NO;
    NSString *bid = nil;
    if ([icon respondsToSelector:@selector(applicationBundleID)]) bid = [icon applicationBundleID];
    if (![bid isKindOfClass:[NSString class]] && [icon respondsToSelector:@selector(application)]) {
        SBApplication *app = [(SBApplicationIcon *)icon application];
        if ([app respondsToSelector:@selector(bundleIdentifier)]) bid = [app bundleIdentifier];
    }
    if (![bid isKindOfClass:[NSString class]] && [icon respondsToSelector:@selector(leafIdentifier)])
        bid = [icon leafIdentifier];
    return [bid isKindOfClass:[NSString class]] && [bid isEqualToString:kEncoreID];
}

static NSString *EIAppPath(SBApplicationIcon *icon) {
    SBApplication *app = [icon respondsToSelector:@selector(application)] ? [icon application] : nil;
    NSString *p = [app respondsToSelector:@selector(path)] ? [app path] : nil;
    return ([p isKindOfClass:[NSString class]] && [p length]) ? p : kAppPath;
}

// ---- the art -------------------------------------------------------------------------------------------------

static UIImage *EILoad(NSString *path, CGFloat scale) {
    NSData *d = [NSData dataWithContentsOfFile:path];
    UIImage *img = [d length] ? [UIImage imageWithData:d] : nil;
    CGImageRef cg = img.CGImage;
    if (!cg || CGImageGetWidth(cg) < 8 || CGImageGetHeight(cg) < 8) return nil;
    return [UIImage imageWithCGImage:cg scale:scale orientation:UIImageOrientationUp];
}

// AppIcons/<id>/: Icon (57 pt) for the home screen sizes, Icon-Small (29 pt) for the small ones. The right set at
// the screen's scale first, then whatever else is there (UIKit rescales it).
static UIImage *EIArtIn(NSString *app, NSString *iconID, BOOL small, BOOL retina) {
    NSString *dir = [[app stringByAppendingPathComponent:@"AppIcons"] stringByAppendingPathComponent:iconID];
    NSString *a = small ? @"Icon-Small" : @"Icon";
    NSString *b = small ? @"Icon" : @"Icon-Small";
    NSString *a2 = [a stringByAppendingString:@"@2x"], *b2 = [b stringByAppendingString:@"@2x"];
    NSArray *names = retina ? [NSArray arrayWithObjects:a2, a, b2, b, nil] : [NSArray arrayWithObjects:a, a2, b2, b, nil];
    for (NSString *n in names) {
        NSString *path = [dir stringByAppendingPathComponent:[n stringByAppendingString:@".png"]];
        UIImage *img = EILoad(path, [n hasSuffix:@"@2x"] ? 2 : 1);
        if (img) return img;
    }
    return nil;
}

static UIImage *EIArt(SBApplicationIcon *icon, NSString *iconID, BOOL small, BOOL retina) {
    NSString *app = EIAppPath(icon);
    UIImage *img = EIArtIn(app, iconID, small, retina);
    if (!img && ![app isEqualToString:kAppPath]) img = EIArtIn(kAppPath, iconID, small, retina);
    return img;
}

// ---- rendering at SpringBoard's exact size -------------------------------------------------------------------

static BOOL EISameSize(CGSize a, CGSize b) {
    return fabs(a.width - b.width) < 0.5 && fabs(a.height - b.height) < 0.5;
}

// UIKit's own mask and shadow. SpringBoard hands its format number straight to UIKit on 6.1, so that number is
// tried first; the 0-15 sweep (ClassicIFile's) is for firmware where they differ. UIKit's format switch is
// range-checked on 6.1 (an unknown format falls to its default case). UIKit and MobileIcons keep no cache here:
// every call draws a new bitmap.
static UIImage *EIRenderUIKit(UIImage *art, int format, CGSize want, CGFloat scale) {
    if (![art respondsToSelector:@selector(_applicationIconImageForFormat:precomposed:scale:)]) return nil;
    NSNumber *key = [NSNumber numberWithInt:format];
    NSNumber *known;
    @synchronized (gLock) {
        known = [gUIKitFormat objectForKey:key];
    }
    if (known && [known intValue] < 0) return nil;

    NSMutableArray *order = [NSMutableArray array];
    if (known) [order addObject:known];
    [order addObject:key];
    for (int f = 0; f < 16; f++) [order addObject:[NSNumber numberWithInt:f]];
    NSMutableSet *tried = [NSMutableSet set];
    for (NSNumber *n in order) {
        if ([tried containsObject:n]) continue;
        [tried addObject:n];
        UIImage *img = [art _applicationIconImageForFormat:[n intValue] precomposed:YES scale:scale];
        if ([img isKindOfClass:[UIImage class]] && EISameSize(img.size, want)) {
            @synchronized (gLock) {
                [gUIKitFormat setObject:n forKey:key];
            }
            // Logged on every render (every cache miss), not only the first time a format is matched.
            EILog(@"render: SB format %d via UIKit format %d -> %@", format, [n intValue], EIImg(img));
            return img;
        }
    }
    @synchronized (gLock) {
        [gUIKitFormat setObject:[NSNumber numberWithInt:-1] forKey:key];
    }
    return nil;
}

// Fallback: ClassicIFile's rounded-rect clip (radius 0.1754 x side), without gloss.
static UIImage *EIRenderManual(UIImage *art, CGSize want, CGFloat scale) {
    CGFloat side = MIN(want.width, want.height);
    CGRect r = CGRectMake(floor((want.width - side) / 2), 0, side, side);
    UIGraphicsBeginImageContextWithOptions(want, NO, scale);
    CGContextRef ctx = UIGraphicsGetCurrentContext();
    if (ctx) {
        CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
        [[UIBezierPath bezierPathWithRoundedRect:r cornerRadius:side * 0.1754] addClip];
        [art drawInRect:r];
    }
    UIImage *out = ctx ? UIGraphicsGetImageFromCurrentImageContext() : nil;
    UIGraphicsEndImageContext();
    return out;
}

// The chosen art at the size and scale of SpringBoard's own image for this format, or nil (= keep the stock one).
static UIImage *EIIcon(SBApplicationIcon *icon, NSString *iconID, NSUInteger gen, int format, UIImage *stock) {
    if (![stock isKindOfClass:[UIImage class]]) return nil;
    CGSize want = stock.size;
    if (want.width < 1 || want.height < 1) return nil;
    CGFloat scale = stock.scale > 0 ? stock.scale : 1;

    UIImage *art = EIArt(icon, iconID, want.width <= 40, scale >= 2);
    if (!art) {
        EILog(@"no art for %@ (SB format %d): stock icon", iconID, format);
        return nil;
    }
    UIImage *out = EIRenderUIKit(art, format, want, scale);
    if (!out) {
        out = EIRenderManual(art, want, scale);
        EILog(@"render: SB format %d manual -> %@", format, EIImg(out));
    }
    if (!out) return nil;

    @synchronized (gLock) {
        if (gGen != gen) return nil;        // the choice changed while drawing: stock now, the reload redraws it
        [gCache setObject:out forKey:[NSNumber numberWithInt:format]];
    }
    return out;
}

// What EISwap did, for the debug log.
enum { EIHowOther = 0, EIHowStockChoice, EIHowCached, EIHowRendered, EIHowNoArt };

static UIImage *EISwap(SBApplicationIcon *icon, int format, UIImage *stock, int *how) {
    *how = EIHowOther;
    if (!stock) return stock;
    NSString *iconID;
    NSUInteger gen;
    UIImage *hit;
    @synchronized (gLock) {
        iconID = gIcon;
        gen = gGen;
        hit = [gCache objectForKey:[NSNumber numberWithInt:format]];
    }
    BOOL stockChoice = [iconID isEqualToString:kStockID];
    if (stockChoice && !EIWatching()) return stock;     // the common case: no Encore check at all
    if (!EIIsEncore(icon)) return stock;
    if (stockChoice) {
        *how = EIHowStockChoice;
        return stock;
    }
    if (hit) {
        *how = EIHowCached;
        return hit;
    }
    UIImage *mine = EIIcon(icon, iconID, gen, format, stock);
    *how = mine ? EIHowRendered : EIHowNoArt;
    return mine ? mine : stock;
}

static void EITrace(const char *what, SBIcon *icon, int format, UIImage *stock, UIImage *out, int how) {
    if (!EI_DEBUG || how == EIHowOther || !EIWatching()) return;
    static const char *names[] = { "", "stock (choice is encore)", "swapped (cache)", "swapped (rendered)",
                                   "stock (no art / render failed)" };
    EILogf(@"%s f%d icon %p: %s, orig %@ -> %@, %s, from%@", what, format, icon, names[how], EIImg(stock),
           EIImg(out), [NSThread isMainThread] ? "main" : "bg", EICallers(5));
}

// ---- live change ---------------------------------------------------------------------------------------------

static SBIconModel *EIModel(void) {
    SBIconModel *model = nil;
    Class ctlClass = %c(SBIconController);
    if (ctlClass && [ctlClass respondsToSelector:@selector(sharedInstance)]) {
        SBIconController *ctl = [ctlClass sharedInstance];
        if ([ctl respondsToSelector:@selector(model)]) model = [ctl model];
    }
    Class modelClass = %c(SBIconModel);
    if (!model && modelClass && [modelClass respondsToSelector:@selector(sharedInstance)])
        model = [modelClass sharedInstance];             // iOS 5
    return model;
}

// Arrays compared by pointer: SBLeafIcon's -isEqual: matches any icon with the same identifier, and finding a
// second Encore icon object is exactly what we want to know.
static BOOL EIHas(NSArray *a, id o) {
    for (id x in a) {
        if (x == o) return YES;
    }
    return NO;
}

static void EIAdd(NSMutableArray *a, id o) {
    if (o && !EIHas(a, o)) [a addObject:o];
}

static BOOL EIFolderHasEncore(SBIcon *icon) {
    if (![icon respondsToSelector:@selector(isFolderIcon)] || ![icon isFolderIcon]) return NO;
    if (![icon respondsToSelector:@selector(containsNodeIdentifier:)]) return NO;
    return [icon containsNodeIdentifier:kEncoreID];      // a leaf icon's node identifier is its bundle id (6.1)
}

// What EIFind collects (an object, not a C struct: ARC keeps no object pointers in structs).
@interface EIFound : NSObject
@property (nonatomic, strong) SBIcon *modelIcon;        // the model's Encore icon (what the stock reload uses)
@property (nonatomic, strong) NSMutableArray *icons;    // every Encore icon object found (the model's first)
@property (nonatomic, strong) NSMutableArray *views;    // every SBIconView showing one of them
@property (nonatomic, strong) NSMutableArray *wheres;   // where each view was found
@property (nonatomic, strong) NSMutableArray *folders;  // folder icons that contain Encore
@end

@implementation EIFound
@synthesize modelIcon = _modelIcon, icons = _icons, views = _views, wheres = _wheres, folders = _folders;
- (id)init {
    if ((self = [super init])) {
        _icons = [NSMutableArray array];
        _views = [NSMutableArray array];
        _wheres = [NSMutableArray array];
        _folders = [NSMutableArray array];
    }
    return self;
}
@end

static void EIAddView(EIFound *f, UIView *v, NSString *where) {
    NSUInteger i = 0;
    for (id x in f.views) {
        if (x == v) {
            NSString *w = [f.wheres objectAtIndex:i];
            if ([w rangeOfString:where].location == NSNotFound)
                [f.wheres replaceObjectAtIndex:i withObject:[w stringByAppendingFormat:@"+%@", where]];
            return;
        }
        i++;
    }
    [f.views addObject:v];
    [f.wheres addObject:where];
}

// Every SBIconView under root (an explicit stack, no recursion).
static void EIWalk(UIView *root, NSString *where, EIFound *f) {
    Class ivc = %c(SBIconView);
    if (!root || !ivc) return;
    NSMutableArray *stack = [NSMutableArray arrayWithObject:root];
    NSUInteger seen = 0;
    while ([stack count] && seen < 50000) {
        UIView *v = [stack lastObject];
        [stack removeLastObject];
        seen++;
        if ([v isKindOfClass:ivc] && [v respondsToSelector:@selector(icon)]) {
            SBIcon *icon = [(SBIconView *)v icon];
            if (EIIsEncore(icon)) {
                EIAddView(f, v, where);
                EIAdd(f.icons, icon);
            } else if (icon && EIFolderHasEncore(icon)) {
                EIAdd(f.folders, icon);
            }
        }
        NSArray *subs = [v subviews];
        if ([subs count]) [stack addObjectsFromArray:subs];
    }
}

static void EIFind(EIFound *f) {
    SBIconModel *model = EIModel();
    SBIcon *mine = nil;
    if ([model respondsToSelector:@selector(applicationIconForDisplayIdentifier:)])
        mine = [model applicationIconForDisplayIdentifier:kEncoreID];
    if (!mine && [model respondsToSelector:@selector(leafIconForIdentifier:)])
        mine = [model leafIconForIdentifier:kEncoreID];
    f.modelIcon = mine;
    EIAdd(f.icons, mine);
    if ([model respondsToSelector:@selector(leafIconForIdentifier:)])
        EIAdd(f.icons, [model leafIconForIdentifier:kEncoreID]);
    if ([model respondsToSelector:@selector(expectedIconForDisplayIdentifier:)])
        EIAdd(f.icons, [model expectedIconForDisplayIdentifier:kEncoreID]);

    // SpringBoard's windows, then the home screen tree in case it is not in a window right now (an app is open).
    // -dockContainerView is a plain getter on 6.1 (-contentView would build the home screen if it did not exist).
    UIApplication *app = [UIApplication sharedApplication];
    NSArray *windows = [app respondsToSelector:@selector(windows)] ? [app windows] : nil;
    for (UIWindow *w in windows) EIWalk(w, @"window", f);
    Class ctlClass = %c(SBIconController);
    SBIconController *ctl = (ctlClass && [ctlClass respondsToSelector:@selector(sharedInstance)])
        ? [ctlClass sharedInstance] : nil;
    UIView *top = [ctl respondsToSelector:@selector(dockContainerView)] ? [ctl dockContainerView] : nil;
    while ([top superview]) top = [top superview];
    if (top && ![top isKindOfClass:[UIWindow class]]) EIWalk(top, @"homeTree", f);

    // The view maps (also finds views that are mapped but not in any view tree).
    Class mapClass = %c(SBIconViewMap);
    NSMutableArray *maps = [NSMutableArray array], *mapNames = [NSMutableArray array];
    if (mapClass && [mapClass respondsToSelector:@selector(homescreenMap)]) {
        id m = [mapClass homescreenMap];
        if (m) { [maps addObject:m]; [mapNames addObject:@"homescreenMap"]; }
    }
    if (mapClass && [mapClass respondsToSelector:@selector(switcherMap)]) {
        id m = [mapClass switcherMap];
        if (m) { [maps addObject:m]; [mapNames addObject:@"switcherMap"]; }
    }
    NSArray *icons = [NSArray arrayWithArray:f.icons];
    for (NSUInteger i = 0; i < [maps count]; i++) {
        SBIconViewMap *map = [maps objectAtIndex:i];
        if (![map respondsToSelector:@selector(mappedIconViewForIcon:)]) continue;
        for (SBIcon *icon in icons) {
            SBIconView *v = [map mappedIconViewForIcon:icon];
            if ([v isKindOfClass:[UIView class]]) {
                EIAddView(f, v, [mapNames objectAtIndex:i]);
                if ([v respondsToSelector:@selector(icon)]) EIAdd(f.icons, [v icon]);
            }
        }
    }
}

static UIImage *EIShown(SBIconView *v) {
    UIImageView *iv = [v respondsToSelector:@selector(iconImageView)] ? [v iconImageView] : nil;
    return [iv isKindOfClass:[UIImageView class]] ? iv.image : nil;
}

static UIImage *EIWanted(SBIconView *v, SBIcon *icon) {
    if (![v respondsToSelector:@selector(location)]) return nil;
    if (![icon respondsToSelector:@selector(getStandardIconImageForLocation:)]) return nil;
    return [icon getStandardIconImageForLocation:[v location]];
}

// The stock reload: empty the icon object's image slots and tell its observers.
static NSString *EIPurge(SBIcon *icon) {
    if ([icon respondsToSelector:@selector(reloadIconImagePurgingImageCache:)]) {
        [icon reloadIconImagePurgingImageCache:YES];
        return @"reloadIconImagePurgingImageCache:YES";
    }
    if ([icon respondsToSelector:@selector(reloadIconImage)]) {
        [icon reloadIconImage];
        return @"reloadIconImage";
    }
    if ([icon respondsToSelector:@selector(purgeCachedImages)] && [icon respondsToSelector:@selector(_notifyImageDidUpdate)]) {
        [icon purgeCachedImages];
        [icon _notifyImageDidUpdate];
        return @"purgeCachedImages + _notifyImageDidUpdate";
    }
    return @"no reload selector (the icon changes after the next respring)";
}

// Repaints one view if it does not show what its icon now returns. Returns a description for the log.
static NSString *EIRepaint(SBIconView *v) {
    SBIcon *icon = [v respondsToSelector:@selector(icon)] ? [v icon] : nil;
    if (!icon) return @"no icon";
    UIImage *shown = EIShown(v);
    UIImage *want = EIWanted(v, icon);
    if (want && shown == want) return @"current";
    NSString *did;
    if ([v respondsToSelector:@selector(iconImageDidUpdate:)]) {
        [v iconImageDidUpdate:icon];                   // what the observer table would have done
        did = @"iconImageDidUpdate:";
        if (want && EIShown(v) != want && [v respondsToSelector:@selector(setDisplayedIconImage:)]) {
            [v setDisplayedIconImage:want];
            did = @"iconImageDidUpdate: + setDisplayedIconImage:";
        }
    } else if (want && [v respondsToSelector:@selector(setDisplayedIconImage:)]) {
        [v setDisplayedIconImage:want];
        did = @"setDisplayedIconImage:";
    } else {
        return @"stale, no repaint selector";
    }
    UIImage *now = EIShown(v);
    return [NSString stringWithFormat:@"repainted (%@): %@", did,
            want ? (now == want ? @"now current" : @"STILL DIFFERENT") : @"no wanted image to compare"];
}

// purge: also reload every Encore icon object and the folders that hold it (a change). Without it only stale views
// are repainted (a re-check). Main thread only.
static void EIRefresh(NSString *why, BOOL purge) {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            @autoreleasepool {
                EIRefresh(why, purge);
            }
        });
        return;
    }
    EIFound *f = [[EIFound alloc] init];
    EIFind(f);
    SBIcon *modelIcon = f.modelIcon;
    EILog(@"refresh (%@): %lu Encore icon object(s), %lu view(s), %lu folder(s) holding Encore", why,
          (unsigned long)[f.icons count], (unsigned long)[f.views count], (unsigned long)[f.folders count]);
    if (!modelIcon) {
        EILog(@"refresh: no Encore icon in the model");
        return;
    }

    // What each view showed and whether it was registered, before the stock reload.
    NSMutableArray *before = [NSMutableArray array];
    for (NSUInteger i = 0; i < [f.views count]; i++) {
        SBIconView *v = [f.views objectAtIndex:i];
        SBIcon *icon = [v respondsToSelector:@selector(icon)] ? [v icon] : nil;
        UIImage *shown = EIShown(v);
        [before addObject:shown ? (id)shown : (id)[NSNull null]];
        if (EI_DEBUG) {
            NSString *obs = [icon respondsToSelector:@selector(hasObserver:)]
                ? ([icon hasObserver:v] ? @"YES" : @"NO") : @"?";
            EILogf(@"  view %lu: %@ %p in %@, icon %p (%@), observer %@, location %d, window %@, hidden %d, shows %@",
                   (unsigned long)i, NSStringFromClass([v class]), v, [f.wheres objectAtIndex:i], icon,
                   icon == modelIcon ? @"the model's" : @"ANOTHER OBJECT", obs,
                   [v respondsToSelector:@selector(location)] ? [v location] : -1, v.window ? @"yes" : @"no",
                   (int)v.hidden, EIImg(shown));
        }
    }

    if (purge) {
        for (SBIcon *icon in f.icons) {
            NSString *how = EIPurge(icon);
            EILog(@"  reload icon %p (%@): %@", icon, icon == modelIcon ? @"the model's" : @"another object", how);
        }
    }

    for (NSUInteger i = 0; i < [f.views count]; i++) {
        SBIconView *v = [f.views objectAtIndex:i];
        id b = [before objectAtIndex:i];
        UIImage *afterStock = EIShown(v);
        NSString *stockSays = purge
            ? ((id)afterStock == b ? @"stock reload did NOT repaint it" : @"stock reload repainted it")
            : @"re-check";
        NSString *result = EIRepaint(v);
        EILog(@"  view %lu: %@; %@; shows %@", (unsigned long)i, stockSays, result, EIImg(EIShown(v)));
    }

    if (purge) {
        for (SBIcon *folder in f.folders) {
            NSString *how = EIPurge(folder);
            EILog(@"  reload folder icon %p: %@", folder, how);
        }
    }
}

static void EIApply(void) {
    NSString *now = EIReadPref();
    BOOL changed = NO;
    @synchronized (gLock) {
        if (![now isEqualToString:gIcon]) {
            gIcon = now;
            [gCache removeAllObjects];
            gGen++;
            changed = YES;
        }
    }
    EIWatch();
    EILog(@"change: %@%@", now, changed ? @"" : @" (unchanged: re-check only)");
    EIRefresh(changed ? @"change" : @"re-check", changed);
    // A second look once SpringBoard's own follow-ups (folder grids, ghostly images) have run.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        @autoreleasepool {
            EIRefresh(@"re-check after 1 s", NO);
        }
    });
}

static void EIChanged(CFNotificationCenterRef center, void *observer, CFStringRef name, const void *object,
                      CFDictionaryRef userInfo) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            EIApply();
        }
    });
}

// ---- hooks ---------------------------------------------------------------------------------------------------

%hook SBApplicationIcon

- (UIImage *)generateIconImage:(int)format {
    UIImage *stock = %orig;
    int how;
    UIImage *out = EISwap(self, format, stock, &how);
    if (EI_DEBUG) EITrace("generateIconImage:", self, format, stock, out, how);
    return out;
}

- (UIImage *)getIconImage:(int)format {
    UIImage *stock = %orig;
    int how;
    UIImage *out = EISwap(self, format, stock, &how);
    if (EI_DEBUG) EITrace("getIconImage:", self, format, stock, out, how);
    return out;
}

%end

%ctor {
    @autoreleasepool {
        if (!%c(SBApplicationIcon)) return;             // not SpringBoard (or not one we know): do nothing
        gLock = [[NSObject alloc] init];
        gCache = [[NSMutableDictionary alloc] init];
        gUIKitFormat = [[NSMutableDictionary alloc] init];
        gIcon = EIReadPref();
        EIWatch();
        %init;
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), NULL, EIChanged, CFSTR(kChanged),
                                        NULL, CFNotificationSuspensionBehaviorDeliverImmediately);
        int loadedToken = 0;                            // kept for SpringBoard's lifetime: Encore reads the state
        if (notify_register_check(kLoaded, &loadedToken) == NOTIFY_STATUS_OK)
            notify_set_state(loadedToken, (uint64_t)getpid());
        EILog(@"--- EncoreIcons 1.0.1 loaded, icon %@ (every Encore image request is logged for %.0f s)", gIcon,
              kWatchSecs);
    }
}

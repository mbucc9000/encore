#import <UIKit/UIKit.h>

// The home screen icon choice (owner: DATA; DESIGN-APP-ICONS.md §3, §5, §7): Settings → Appearance → App Icon. The app
// never changes its own icon and its binary stays MobileSubstrate-free: it saves the choice where the add-on reads it
// (EncoreIcons.dylib, a SpringBoard tweak built from app/EncoreIcons/ and shipped in Encore's own package), posts one
// Darwin notification, and asks whether SpringBoard has loaded the add-on (+addOnState).
//   - The ids, in the picker's order: encore (the app's own Icon.png, the default: the add-on changes nothing), classic,
//     round, 2013, flat, disco. The art for the last five ships inside Encore.app as AppIcons/<id>/Icon.png (57),
//     Icon@2x.png (114), Icon-Small.png (29) and Icon-Small@2x.png (58), made by tools/make_icons.py from the owner's
//     five images (tools/appicons-src/). Info.plist names only the root Icon.png / Icon@2x.png, so iOS never uses them.
//   - The choice: key "appIcon" in the app's own defaults domain (com.mbucc9000.encore, the file
//     /var/mobile/Library/Preferences/com.mbucc9000.encore.plist); missing or unknown = encore. Nothing wipes it, so it
//     survives Unpair.
//   - +choose: saves, synchronizes (the add-on reads the file itself, from SpringBoard) and then posts the Darwin
//     notification com.mbucc9000.encore.iconchanged (CoreFoundation). It works without the add-on too: the choice
//     applies once the add-on runs.
// Main thread only.
typedef enum {
	ENAppIconsReady = 0,               // the add-on runs in SpringBoard: a choice shows at once
	ENAppIconsNeedsSubstrate,          // no MobileSubstrate: the add-on can't load
	ENAppIconsNeedsRespring            // MobileSubstrate is there, but SpringBoard hasn't loaded the add-on yet
} ENAppIconsState;

@interface ENAppIcons : NSObject

+ (NSArray *)identifiers;                          // the six ids, in the picker's order
+ (NSString *)titleFor:(NSString *)identifier;     // the picker's name ("Encore" and "2013" untranslated); nil = unknown id
+ (NSString *)chosen;                              // the saved id, validated; @"encore" by default
+ (void)choose:(NSString *)identifier;             // save + synchronize + notify (an unknown id saves encore)
// ENAppIconsReady when the add-on runs in SpringBoard now: the libnotify name com.mbucc9000.encore.iconsloaded holds the
// pid the add-on wrote at load and that process is alive. Otherwise ENAppIconsNeedsSubstrate without
// /Library/MobileSubstrate/MobileSubstrate.dylib, else ENAppIconsNeedsRespring (installed, not loaded yet).
+ (ENAppIconsState)addOnState;
// A 29 pt tile of that icon for the Settings rows (ENGroupedCell's icon column): the art (AppIcons/<id>/Icon-Small@2x.png
// on retina, Icon-Small.png otherwise; the bundle's Icon for encore) clipped to radius 6 with the Settings tiles' inset
// black .15 ring, so the white Round icon keeps an edge on the white card. A plain grey tile if the art is missing.
// Cached; nil for an unknown id.
+ (UIImage *)thumbnailFor:(NSString *)identifier;

@end

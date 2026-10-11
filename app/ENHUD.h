#import <UIKit/UIKit.h>

// The small centred HUD of 3c (owner: ACTIONS; DESIGN-3 §6): a dark rounded square in the app's window with a spinner or a
// check mark and one or two lines of text ("Adding…", "Added to Road Trip", "Saved to Liked Songs"). One at a time: each
// call replaces what is shown. It never blocks touches. Main thread only.
// 0.10 (Drop 3a, DESIGN-5 §1.7 C6, package A2): an icon per action, every icon a 46 pt white ENTheme glyph (mockup hud(),
// ic(icon, 46)); the text has a black (0,-1) shadow; colours and the font are ENTheme chrome tokens (hudFill / hudText /
// hudTextShadow / hudFont). The action -> glyph map the callers use: Saved to Liked Songs, Added to Your Library -> heart;
// any removal (Liked, a playlist, Library, Deleted) -> x; Added to Queue -> queue; Added to the Jam -> people; Added to
// <playlist>, Saved in N playlists, Changes saved -> check; Link Copied -> link. The default (showDone:) is the check.

@interface ENHUD : NSObject

+ (void)showBusy:(NSString *)text;           // spinner + text, until replaced or hidden
+ (void)showDone:(NSString *)text;           // check mark + text, hides itself after 1.2 s
// (0.6, DESIGN-4b §6.11) the same with a white ENTheme glyph (heart, x, queue, people, check, link, ...; 0.10: 46 pt) in
// place of the check mark (nil = the check mark)
+ (void)showDone:(NSString *)text glyph:(NSString *)name;
+ (void)hide;
// hides the HUD only while it still says `text` (a failure takes back its own "Adding…" / "Joining…", never a newer HUD)
+ (void)hideText:(NSString *)text;

@end

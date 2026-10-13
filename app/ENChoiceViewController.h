#import "ENGroupedViewController.h"

// A grouped picker (owner: UI; Drop 3a, DESIGN-5 §1.7 C8, package A5; 3b: B4; mockup screens.js Screens.appearance and
// Screens.quality): a small title, then one or more sections, each a header, options of (title, small text) with a check on
// the chosen one, and a footer. Tapping another option moves the check at once and then calls the section's onChoose with
// its index; tapping the chosen option does nothing. A section can end with a preview row (never selectable) whose view is
// built again on every reload, so it follows the theme and the text size live. The screen re-skins itself on
// ENThemeDidChangeNotification (ENGroupedViewController). It is pushed on a tab's stack, so the tab controller keeps the remote
// controls (the base reclaims first responder in viewDidAppear).
// Users: Settings → Appearance (3a, +appearanceViewController; A6: Text size only while EN_DARK_MODE is 0); Settings →
// Streaming Quality (3b, B4: +qualityViewController).
@interface ENChoiceViewController : ENGroupedViewController

- (id)initWithTitle:(NSString *)title;                 // no sections yet (-addSectionWithHeader:…)
// One section (C8's form): titles are the options; details one small text per option (@"" = none) or nil; chosen the checked
// index (-1 = none); header and footer nil = none; onChoose(index) after the check moved.
- (id)initWithTitle:(NSString *)title header:(NSString *)header titles:(NSArray *)titles details:(NSArray *)details
             chosen:(NSInteger)chosen footer:(NSString *)footer onChoose:(void (^)(NSInteger index))onChoose;
// Adds a section (the same arguments) below the others and returns its index.
- (NSInteger)addSectionWithHeader:(NSString *)header titles:(NSArray *)titles details:(NSArray *)details chosen:(NSInteger)chosen
                           footer:(NSString *)footer onChoose:(void (^)(NSInteger index))onChoose;
- (NSInteger)chosenInSection:(NSInteger)section;       // -1 = none (or no such section)
- (void)setChosen:(NSInteger)index inSection:(NSInteger)section;     // moves the check only; onChoose is not called
// The section's last row: make(width) returns a view as wide as the card's content (width) and as tall as the row should
// be. It is built when the table reloads (a theme or text-size change, the screen loading) and resized with the card. Its
// backgroundColor becomes the card's fill behind the row and the view itself is made clear, so the card keeps its rounded
// corners. The row is not selectable.
- (void)setPreviewInSection:(NSInteger)section view:(UIView *(^)(CGFloat width))make;

// Settings → Appearance (DESIGN-5 §2.1 A5; mockup Screens.appearance):
//   - "Theme": Light / Dark / Automatic with the mockup's descriptions and footer → +[ENTheme setAppearance:]. The check
//     moves at once; when the palette flips, the screen re-skins itself (ENThemeDidChangeNotification).
//     (A6, 0.10: dark mode is deferred, so this section is compiled out while ENTheme.h's EN_DARK_MODE is 0.)
//   - "Text size" (A3's setting): Small / Default / Large → +[ENTheme setTextSize:], then a live preview row: a real
//     ENListCell song row (the song that is playing, else a sample) at the chosen size, in the current palette, on the list
//     background. (With EN_DARK_MODE 0 it is the screen's only section.)
+ (ENChoiceViewController *)appearanceViewController;

// Settings → Streaming Quality (DESIGN-5 §2.2 B4; mockup Screens.quality): small title "Streaming Quality", one section with
// that header: Very High / High / Normal / Low with the mockup's bitrate and MB-per-hour lines, the check on [ENPlayback
// shared].tier, and a footer on what the bitrate is (the ceiling Auto-Reduce Quality steps down from). Choosing a row sets
// -[ENPlayback setTier:] (the stream switches at its next frame, as the old segmented control did). ENPlayback has one tier
// for home and away (§2.5: no separate Away Quality).
+ (ENChoiceViewController *)qualityViewController;

// Settings → Language (ENLang): Automatic (the iPhone's language, named in its detail) and every language in its own name.
// Choosing one applies it at once: ENLang saves it, then ENAppDelegate rebuilds the tabs in that language.
+ (ENChoiceViewController *)languageViewController;
// The picker's names and bitrates for an ENTierNames tier (very_high … low), so Settings' row matches it: @"Very High",
// @"High", @"Normal", @"Low" / 320, 256, 160, 96 (the gateway's tiers). nil / 0 for an unknown tier.
+ (NSString *)qualityTitleForTier:(NSString *)tier;
+ (NSInteger)qualityKbpsForTier:(NSString *)tier;

@end

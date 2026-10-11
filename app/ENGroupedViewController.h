#import <UIKit/UIKit.h>

// The grouped-table kit (owner: UI; Drop 3a, DESIGN-5 §1.7 C8, package A5; mockup styles.css "grouped table (settings)",
// "v4" and "Dark appearance", screens.js gCell): the iOS 6 grouped tables of Appearance (3a), Quality and Settings (3b) and the
// Jam screen (3c). Every colour and font is an ENTheme token (P2). These are short, static tables, not the 60 fps lists, so the
// rows are ordinary UILabels and image views (C8).
//   - ENGroupedViewController: a UITableViewController, always UITableViewStyleGrouped, on ENTheme's pinstripe
//     (groupedPattern with backgroundView nil). iOS 6 draws each card itself: the fill is the cell's backgroundColor (set in
//     -tableView:willDisplayCell:forRowAtIndexPath: from the ENGroupedCell's `fill`, groupedCard by default), and the border
//     and separators come from the table's separatorColor (groupedBorder). Light keeps the stock etched style (the white line
//     under a card); Dark is single-line (no light line on the dark pinstripe). The green selection has the row's corners
//     (top, middle, bottom, single: -[ENTheme groupedSelectionImage:]), set in willDisplayCell too.
//   - Section headers and footers: a subclass answers the standard -tableView:titleForHeaderInSection: /
//     -tableView:titleForFooterInSection: (the base answers nil) and the base draws them from tokens: the header Bold 17 in
//     groupedHeader at 19 pt from the edge, 18 pt above it (a section without one keeps the 18 pt gap); the footer 14 in
//     groupedFooter, centred, wrapping (sizeWithFont:constrainedToSize:lineBreakMode:).
//   - Theme (§1.2): observes ENThemeDidChangeNotification (a palette flip or a text-size change). Visible: -themeDidChange at
//     once; hidden: on the next viewWillAppear. The base re-applies the table's pattern, separators and indicatorStyle and
//     calls reloadData, which re-skins every row (willDisplayCell: runs -[ENGroupedCell applyTheme]) and rebuilds the headers
//     and footers. Subclasses with views of their own override it and call super.
//   - Mini player: ENMiniPlayerLayoutNotification keeps contentInset.bottom / scrollIndicatorInsets.bottom at the overlay's
//     height while the screen is shown, as the list base does (`ignoresMiniPlayer` for a modal table).
//   - -scrollToTop (ENTabBarController's re-tap at a tab's root). Portrait only.
//   - Remote controls (P6): a screen inside the tab controller hands first responder back to it in viewDidAppear
//     (-[ENTabBarController reclaimFirstResponder]); a modal subclass becomes first responder itself.
// Subclasses that implement -tableView:willDisplayCell:forRowAtIndexPath: call super. Main thread only.

typedef NS_ENUM(NSInteger, ENGroupedAccessory) {
	ENGroupedAccessoryNone = 0,
	ENGroupedAccessoryChevron,     // chevRight 13 pt (ENTheme groupedChevronImage): the row pushes or opens something
	ENGroupedAccessoryCheck,       // the chosen option (ENTheme groupedCheckImage)
	ENGroupedAccessorySwitch,      // a UISwitch (`toggle`; onTintColor from +applyChrome's appearance)
};

// A grouped row (mockup .g-cell): 10 pt padding, an optional 29 pt icon tile, then the title (Bold 16.5, one line) over an
// optional detail (12.5, wrapping, never cut off), an optional value (16, groupedValue) at the right, and the accessory.
// At least 44 pt tall; +heightWithTitle:… measures the detail with sizeWithFont:constrainedToSize:lineBreakMode:. Selected:
// white text and glyphs on the green per-position selection. Fonts are set once; colours in -applyTheme.
@interface ENGroupedCell : UITableViewCell

+ (NSString *)reuseIdentifier;                        // @"ENGroupedCell"
// The row height for this content in a card `width` wide (-[ENGroupedViewController cardWidth]). Give the accessory the row
// can have at most (a choice row: ENGroupedAccessoryCheck whether or not it is chosen), so moving a check never changes it.
+ (CGFloat)heightWithTitle:(NSString *)title detail:(NSString *)detail value:(NSString *)value icon:(BOOL)icon
                 accessory:(ENGroupedAccessory)accessory width:(CGFloat)width;

@property (nonatomic, strong) UIImage *icon;          // a 29 pt tile (-[ENTheme iconTileNamed:size:]); nil = no icon column
@property (nonatomic, copy) NSString *title;
@property (nonatomic, copy) NSString *detail;         // the small text under the title; nil = none
@property (nonatomic, copy) NSString *value;          // nil = none
@property (nonatomic) ENGroupedAccessory accessory;
@property (nonatomic, readonly) UISwitch *toggle;     // ENGroupedAccessorySwitch's switch, made on first use; prepareForReuse
                                                      // removes its targets (the screen sets `on` and its target each time)
@property (nonatomic) BOOL centered;                  // the title alone, centred across the card (Unpair This iPhone)
@property (nonatomic) BOOL destructive;               // the title in jamRed
@property (nonatomic, strong) UIColor *fill;          // the card's fill behind this row; nil = groupedCard

- (void)applyTheme;                                   // re-reads [ENTheme current]'s colours (the base's willDisplayCell calls it)

@end

@interface ENGroupedViewController : UITableViewController

@property (nonatomic, readonly) BOOL visible;         // between viewWillAppear: and viewWillDisappear:
@property (nonatomic) BOOL ignoresMiniPlayer;         // a modal table: no mini player inset

- (id)init;                                           // = initWithStyle:UITableViewStyleGrouped (any style given becomes grouped)
- (CGFloat)cardWidth;                                 // the content width of a card (the table less iOS 6's 10 pt margins and
                                                      // 2 pt of slack), for +[ENGroupedCell heightWithTitle:…]
- (void)themeDidChange;                               // re-skin in place (see above); subclasses call super
- (void)scrollToTop;                                  // animated, accounting for the inset

@end

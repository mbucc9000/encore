#import <UIKit/UIKit.h>

// Home's shelves (app 0.7; owner: UI; mockup screens.js "Home", styles.css .carousel/.tile): one table row holding a title,
// an optional grey sub-title and a sideways-scrolling row of 104 pt cards (cover in a 2 pt white frame with a soft
// shadow, or a round picture for artists; bold title and grey sub-line under it). Each card draws itself in -drawRect:
// (images from ENImageCache's 216 tier, round:YES for artists, asked for only for the cards near the visible part; no
// layers or masks). A pan that starts on a card scrolls the row and cancels the card's tap.
// The horizontal scroll view has scrollsToTop NO (the status bar tap stays with the table). Main thread only.
//
// Drop 3c (DESIGN-5 §2.3 C3; 1.0.0; owner C3), the mockup's Home (.home-h / .home-sub / .carousel / .tile / .home-sep):
//   - every colour and font is an ENTheme token (shelfTitleFont 17 / shelfSubFont 13 in homeTitle / shelfSub; the cards'
//     tileTitleFont / tileSubFont in tileTitle / tileSub, coverMat / tileRing frames with tileMatShadow, the
//     cardPlaceholder… stand-in); read when the row is made (Light only while EN_DARK_MODE is 0)
//   - the row is NOT opaque (clear cell, labels and scroller): Home shows its homeBackground gradient through it (Home also
//     clears the cell's background in willDisplayCell:, where iOS 6 resets it); only these few shelf rows blend (P4)
//   - title nil = no title block: the cards start at the top (Home's "Jump back in" shelf, whose title is the greeting's
//     sub-line); a title is 14 pt down (Bold 17), a sub-title 4 pt under it (13), then the cards (the mockup's paddings)
//   - the separator under the cards gets its white line: 1 pt homeSeparator over 1 pt homeSeparatorHighlight, 18 pt under
//     the cards' text (the carousel's 12 pt + the separator's 6 pt margin)
//   - a pressed card dims to .7 (was .6), and a card's picture cross-fades in (ENFadeIn, 0.18 s) when it arrives from disk
//     or the network while the card is on screen (one CATransition on that card; a memory hit shows at once, no fade: P4)

@class ENHomeTile;

@interface ENShelfCell : UITableViewCell

+ (NSString *)reuseIdentifier;          // @"ENShelfCell"
// (3c) the row's height for a shelf with / without a title and a sub-title (a sub-title without a title counts as none)
+ (CGFloat)heightWithTitle:(BOOL)title subtitle:(BOOL)subtitle;

@property (nonatomic, copy) NSString *title;               // (3c) nil = no title block (the cards start at the top)
@property (nonatomic, copy) NSString *subtitle;            // nil = none (shown only under a title)
@property (nonatomic, copy) NSArray *tiles;                 // ENHomeTile; a different array rebuilds the cards (the row scrolls
                                                            // back); the same array again changes nothing
@property (nonatomic) CGFloat scrollX;                      // the row's sideways offset (clamped); the screen keeps it per shelf
@property (nonatomic, copy) void (^onTap)(ENHomeTile *tile);
@property (nonatomic, copy) void (^onScroll)(CGFloat x);    // after the user scrolled the row (drag / deceleration ended)

@end

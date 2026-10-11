#import <UIKit/UIKit.h>
#import "ENListCell.h"
#import "ENCompat.h"

// The base of every 0.5 list screen (owner: UI; DESIGN-3 §5.1, §5.5, §5.6; Drop 3a: package A3, DESIGN-5 §1.2, C4, C5, and
// the 3a review's NAV7 title). A UITableViewController subclass because UIRefreshControl is only supported there on iOS 6.
//   - Plain style, opaque rows, one constant row height per table: [ENTheme current].rowHeight (the Text size setting: 44 / 48
//     / 54 pt; subclasses never implement heightForRowAtIndexPath:, except Search's Top Result and Home's shelves, which
//     return rowHeight for their plain rows), ENListCell registered under +[ENListCell reuseIdentifier], ENTheme
//     listBackground and indicatorStyle.
//   - Pull to refresh (when `refreshable`): calls -reload:YES; the subclass calls -finishRefreshing when its load ends. Tint
//     refreshTint. (1.1) Through ENCompat's ENRefresh*: UIRefreshControl on iOS 6, ENCompat's own "Pull down to refresh" on
//     iOS 5 (the base forwards it scrollViewDidScroll: and scrollViewDidEndDragging:; subclasses that override those call super).
//   - (1.1, iOS 5) a row a subclass's tableView:shouldHighlightRowAtIndexPath: refuses is neither highlighted (ENListCell asks
//     -listCellShouldHighlight:) nor selected (-tableView:willSelectRowAtIndexPath:); iOS 6 asks that method itself.
//   - Mini player inset: listens to ENMiniPlayerLayoutNotification and keeps contentInset.bottom / scrollIndicatorInsets.bottom
//     at the mini player's height while visible (only .bottom is touched: UIRefreshControl owns .top while refreshing).
//   - A banner (error / stale / "Update your Encore Bridge") above the rows that never pushes the rows around unexpectedly: ENTheme
//     bannerImage (the same in both themes), slides down from under the bar in .3 s (A3), optionally led by a small spinner.
//   - Partial-list polling (-schedulePoll:): runs only while the screen is visible AND the app is active; cancelled on
//     viewWillDisappear and UIApplicationDidEnterBackgroundNotification, resumed (one -poll) on DidBecomeActive.
//   - ENCatalogChangedNotification -> -catalogChanged: (main thread, visible or not; subclasses decide);
//     ENPlaybackChangedNotification -> when the heard song (playingURI) changed while visible and the app is active (else
//     on the next viewWillAppear / DidBecomeActive), sets `playing` on the visible song cells only (no row reloads).
//   - (A3) ENThemeDidChangeNotification (a palette flip, or a Text size change) -> -themeDidChange at once while visible, else
//     in the next viewWillAppear (the catalog-reset pattern). It re-skins in place: no rebuilt views, no scroll jump.
//   - (Drop 3a, NAV7) -setTitle: also runs [ENTheme applyTitle:toItem:small:NO]: a title too wide for the 20 pt bar font
//     shows at 17 pt, and one over 13 characters gives the next screen a "Back" button; a foreign titleView (Search's field)
//     is left alone. A screen that wants the small title calls -applyTitle:… small:YES after setting self.title.
//   - Re-tap of the selected tab at the root -> -scrollToTop (called by ENTabBarController).
//   - ENDiag frame meter around flings (scrollViewWillBeginDragging / DidEndDecelerating) with -meterName.
//   - The ••• of a song row -> [ENTrackActions showMenuForTrack:from:options:busy:] (moreBusy on that cell meanwhile); the
//     swipe right -> [ENTrackActions addToQueue:] under a strip saying "Add to Queue", or "Add to Jam" while a Jam is on
//     (-listCellSwipeTitle:).
//   - Memory warning while not visible (view.window == nil): subclasses drop their models in -dropModels and reload on
//     viewWillAppear.
//   - (Drop 3c, C1) -listOverlayColor: what the empty state and the footers sit on (listBackground; a list with a
//     backgroundView of its own, Home's homeBackground, returns clearColor), and -setFooterTitle:message: (the empty
//     state's look as a footer under the rows, for Search's hint). Both are additions: unused, the base is unchanged.
// Main thread only.

@class ENTrack, ENTheme;

// (1.1, iOS 5) what both section header classes do: ENSectionHeaderView on iOS 6, ENLegacySectionHeaderView (a plain UIView
// with the same look, the same skin code) on iOS 5, which has no UITableViewHeaderFooterView. Screens type a header as
// UIView<ENSectionHeader> *.
@protocol ENSectionHeader <NSObject>
@property (nonatomic, copy) NSString *title;
@property (nonatomic, strong) UIImage *backgroundImage;
@property (nonatomic, strong) ENTheme *theme;
@property (nonatomic) BOOL strong;
- (void)setActionTitle:(NSString *)title target:(id)target action:(SEL)action;
- (void)reloadTheme;
@end

// (UI implementation addition) the green sticky section header (registered by the base; get one with -sectionHeaderWithTitle:
// or -strongSectionHeaderWithTitle:, which re-skin it on every dequeue). 22 pt; ENTheme headerFont / headerText with its
// shadow; the right-hand action in the same font (pressed: headerActionHighlighted).
@interface ENSectionHeaderView : UITableViewHeaderFooterView <ENSectionHeader>
@property (nonatomic, copy) NSString *title;
@property (nonatomic, strong) UIImage *backgroundImage;     // (0.6) nil = the theme's header image (Up Next's Jam queue header
                                                            // sets jamQueueHeaderImage; the base's dequeue resets it)
@property (nonatomic, strong) ENTheme *theme;               // (A3) nil (the default) follows +[ENTheme current]; a palette stays
                                                            // (Up Next: +queue). Reads back the palette in use, never nil.
@property (nonatomic) BOOL strong;                          // (A3) the brighter sectionHeaderStrongBackground (Search's Top Result)
- (void)setActionTitle:(NSString *)title target:(id)target action:(SEL)action;   // small right-hand text button ("Clear"); nil hides
- (void)reloadTheme;                                        // (A3) re-reads `theme` and re-skins (background, label, action)
@end

// (1.1, iOS 5) the same header as a plain view (made fresh for every request: iOS 5 has no header reuse): a full-size image
// view for the background, the label 12 pt in and the 70 pt action on the right, as ENSectionHeaderView lays them out.
@interface ENLegacySectionHeaderView : UIView <ENSectionHeader>
@property (nonatomic, copy) NSString *title;
@property (nonatomic, strong) UIImage *backgroundImage;
@property (nonatomic, strong) ENTheme *theme;
@property (nonatomic) BOOL strong;
- (void)setActionTitle:(NSString *)title target:(id)target action:(SEL)action;
- (void)reloadTheme;
@end

// (1.1, iOS 5) the header calls a table makes: iOS 6 registerClass:forHeaderFooterViewReuseIdentifier: (ENSectionHeaderView) /
// dequeueReusableHeaderFooterViewWithIdentifier: / headerViewForSection: as before; iOS 5 nothing to register, a new
// ENLegacySectionHeaderView, and the header among the table's subviews that lies in that section (headers stay inside their
// section's rect, pinned or not). ENSectionHeaderForSection returns nil for a header that isn't one of these.
void ENRegisterSectionHeader(UITableView *tv, NSString *reuseIdentifier);
UIView<ENSectionHeader> *ENDequeueSectionHeader(UITableView *tv, NSString *reuseIdentifier);
UIView<ENSectionHeader> *ENSectionHeaderForSection(UITableView *tv, NSInteger section);

@interface ENListViewController : UITableViewController <ENListCellDelegate>

@property (nonatomic, readonly) BOOL visible;               // between viewWillAppear: and viewWillDisappear:
@property (nonatomic) BOOL refreshable;                     // pull to refresh; default YES (set before the view loads)
@property (nonatomic, copy) NSString *footerText;           // centred grey footer under the rows (nil = none)
@property (nonatomic) BOOL footerBusy;                      // (UI addition) a small spinner before the footer text (partial lists)
@property (nonatomic, copy) NSString *meterName;            // ENDiag scroll-meter label; default the class name
@property (nonatomic) BOOL ignoresMiniPlayer;               // (0.6) a modal list (Up Next): no mini player inset

// ---- for subclasses to override
- (void)reload:(BOOL)fresh;                                 // load / revalidate (fresh = pull-to-refresh); base does nothing
- (void)poll;                                               // a scheduled poll fired (partial lists); base does nothing
- (void)catalogChanged:(NSNotification *)note;              // ENCatalogChangedNotification; base: kind reset -> -reload:NO if visible
- (void)playbackSongChanged;                                // the heard song changed; base updates the visible ENTrack cells'
                                                            // `playing` (setPlaying: redraws only the cells that change)
- (void)dropModels;                                         // memory warning while hidden; base does nothing
- (ENTrack *)trackAtIndexPath:(NSIndexPath *)indexPath;     // the ENTrack a row shows, for ••• (base: the cell's item if ENTrack)
- (NSUInteger)menuOptionsForTrack:(ENTrack *)track;         // ENTrackMenuOptions for its ••• (base: ENTrackMenuDefault)
// (UI addition) pull to refresh: YES once the refresh's own request has been answered. A 304 calls nothing back, so the
// spinner asks this every 0.25 s (and stops after 30 s regardless). Base: no catalog request at all is in flight.
- (BOOL)refreshAnsweredSince:(NSDate *)start;
// (A3, DESIGN-5 §1.2) the theme or the text size changed (visible: at once; hidden: in the next viewWillAppear). Base: the
// table background, indicatorStyle and rowHeight; the footer, the empty view, the busy spinner and the refresh tint; the
// visible cells and section headers; then reloadData (the selection stays; after a row height change the top row stays in
// place). Screens with views of their own (headers, fields) override it and call super.
- (void)themeDidChange;
// (3c, C1) the background of the base's own overlays: the empty state's view and labels, the footer's view and label, and
// the hint footer (-setFooterTitle:message:).
// Base: [ENTheme current].listBackground (opaque, as before). Override it to return [UIColor clearColor] when the table
// shows a backgroundView of its own (C3: Home's homeBackground), so they don't sit in a listBackground box on it; asked
// when they are created and again in -themeDidChange (return the same answer every time).
- (UIColor *)listOverlayColor;

// ---- helpers for subclasses
- (void)showError:(NSError *)error;                         // banner with [ENCatalog messageForError:] (rows stay); tap hides it
- (void)showBanner:(NSString *)text;                        // any other banner text ("Showing a saved copy", "Update your
                                                            // Encore Bridge", "Still loading. Pull to refresh.")
- (void)showBanner:(NSString *)text busy:(BOOL)busy;        // (A3) the same, busy = a 16 pt grey spinner before the text
- (void)hideBanner;
- (void)hideBannerIfShowing:(NSString *)text;               // (UI addition) hides it only while it shows exactly this text
- (void)setBusy:(BOOL)busy;                                 // a centred spinner (a `wait` list, a first load with no cache)
// (A3) the empty state when there are no rows (mockup .empty: 50 pt down, 30 pt sides, centred): a bold title (emptyTitle
// 17) over a message (emptyBody 14.5); either may be nil; both nil hide it.
- (void)setEmptyTitle:(NSString *)title message:(NSString *)message;
- (void)setEmptyText:(NSString *)text;                      // the same with the title only ("No songs yet"); nil hides
// (3c, C1) the same look (emptyTitle 17 bold over emptyBody 14.5, centred, 30 pt sides, the title 6 pt over the message) as
// the table's FOOTER, under the last row: a hint that follows the rows instead of the empty state's fixed place (C4: Search's
// "Search all of Spotify" / "Songs play instantly…" under the recents; the mockup's .empty with 30 pt on top, 50 under).
// Either may be nil; both nil remove it. footerText / footerBusy win while either is set (there is one tableFooterView);
// clearing them brings the hint back. It sits on -listOverlayColor and re-skins in -themeDidChange.
- (void)setFooterTitle:(NSString *)title message:(NSString *)message;
- (void)finishRefreshing;                                   // ends the UIRefreshControl animation (safe when not refreshing)
- (void)schedulePoll:(NSTimeInterval)delay;                 // -poll after delay (see above); replaces a pending one
- (void)cancelPoll;
- (void)scrollToTop;                                        // animated, accounting for the inset
- (void)reloadVisibleRows;                                  // reloadRowsAtIndexPaths: for the visible rows only, no animation
- (UIView<ENSectionHeader> *)sectionHeaderWithTitle:(NSString *)title;   // (UI addition) a dequeued 22 pt header, no action
                                                                         // button, following +current, re-skinned
- (UIView<ENSectionHeader> *)strongSectionHeaderWithTitle:(NSString *)title;   // (A3) the same, strong (Top Result)

@end

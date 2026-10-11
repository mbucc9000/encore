#import <UIKit/UIKit.h>

// (1.1, iOS 5) one build for iOS 5.0 / 5.1.1 (iPhone 3GS / 4 / 4S, iPod touch 3G / 4G) and iOS 6, with iOS 6 on exactly the
// path it had: every helper below runs the iOS 6 call itself when the iOS 6 API exists, and an iOS 5 fallback only when it
// doesn't (a feature test, never @available: that links ___isOSVersionAtLeast, which the toolchain lacks). The audit behind
// each one: ios5/AUDIT.md (§ numbers below).
//   - ENCompatInstall(): the first call in main(). On iOS 5 only: (§2-A) the object subscripting methods (iOS 6 Foundation;
//     arclite is not linked) added to NSArray / NSMutableArray / NSDictionary / NSMutableDictionary, and (§3-1) iOS 6's "views
//     stay loaded" rule (UIViewController's own -didReceiveMemoryWarning no longer unloads a hidden view; subclasses still
//     run their own overrides). On iOS 6 it changes nothing.
//   - Table cells (§2-B): ENRegisterCellClass / ENDequeueCell for registerClass:forCellReuseIdentifier: and
//     dequeueReusableCellWithIdentifier:forIndexPath:. iOS 5: the class is remembered per table, a new cell is made with
//     -initWithStyle:reuseIdentifier: (as UIKit does for a registered class), and the cell is sized to the row as iOS 6 does.
//   - Pull to refresh (§2-D): ENRefresh*: UIRefreshControl on iOS 6 (the same calls as before); on iOS 5 a small "Pull down
//     to refresh" view above the rows (the owner forwards scrollViewDidScroll: and scrollViewDidEndDragging:), which sends
//     the same action and moves contentInset.top only while it spins.
//   - Rows that must not highlight (§2-K): ENTableRowHighlightable asks the iOS 6-only tableView:shouldHighlightRowAtIndexPath:
//     of a delegate that has one (iOS 5 never asks it itself).
//   - Labels, fields, images, requests: ENSetMinimumScaleFactor (§2-F), ENSetFieldPlaceholder / ENTintFieldPlaceholder (§2-E),
//     ENHasAttributedText (§2-E), ENResizableImage / ENImageWithPNGData (§2-G), ENSendAsynchronousRequest (§3-2: iOS 5 makes a
//     POST wait at least 240 s; there the request's own timeout is kept by a watchdog that cancels it).
// Main thread only (ENCompatInstall: before UIApplicationMain).

// YES on iOS 6.0 and later (Foundation 992+; iOS 5.1.1 is 890.1). For behaviour that has no single API to test.
BOOL ENSystemIs6(void);

void ENCompatInstall(void);

// ---- tables
void ENRegisterCellClass(UITableView *tv, Class cellClass, NSString *reuseIdentifier);
id ENDequeueCell(UITableView *tv, NSString *reuseIdentifier, NSIndexPath *indexPath);
BOOL ENTableRowHighlightable(id delegate, UITableView *tv, NSIndexPath *indexPath);   // YES when it doesn't say

// ---- pull to refresh (a UITableViewController's)
BOOL ENHasRefreshControl(void);
void ENRefreshInstall(UITableViewController *vc, UIColor *tint, id target, SEL action);
BOOL ENRefreshIsRefreshing(UITableViewController *vc);
void ENRefreshEnd(UITableViewController *vc);                     // safe when not refreshing (or never installed)
void ENRefreshSetTint(UITableViewController *vc, UIColor *tint);
void ENRefreshScrolled(UITableViewController *vc);                // iOS 5: forward scrollViewDidScroll: (iOS 6: nothing)
void ENRefreshDragEnded(UITableViewController *vc);               // iOS 5: forward scrollViewDidEndDragging:willDecelerate:

// ---- labels and fields
void ENSetMinimumScaleFactor(UILabel *label, CGFloat factor);     // iOS 5: minimumFontSize from the label's current font
BOOL ENHasAttributedText(void);                                   // UILabel attributedText and the NSFont… / NSForeground… keys
// iOS 6: attributedPlaceholder (font + colour); iOS 5: the plain placeholder in the field's own font, recoloured if it can be
void ENSetFieldPlaceholder(UITextField *field, NSString *placeholder, UIFont *font, UIColor *color);
void ENTintFieldPlaceholder(UITextField *field, UIColor *color);  // iOS 5 only (no attributedPlaceholder): the colour alone

// ---- images
// iOS 6: resizableImageWithCapInsets:resizingMode:Stretch. iOS 5 (tiles a resizable image's centre): zero caps return the image
// itself (an image view or button scales it to fill, which is stretching); other caps resizableImageWithCapInsets:.
UIImage *ENResizableImage(UIImage *image, UIEdgeInsets caps);
UIImage *ENImageWithPNGData(NSData *data, CGFloat scale);        // imageWithData:scale: (iOS 5: the same through a CGImage)

// ---- network
typedef void (^ENURLCompletion)(NSURLResponse *response, NSData *data, NSError *error);
// sendAsynchronousRequest:queue:[NSOperationQueue mainQueue]; on iOS 5 a request with a body is sent cancellably and fails with
// NSURLErrorTimedOut once it has been idle for its timeoutInterval (completion: once, on the main thread, as before)
void ENSendAsynchronousRequest(NSURLRequest *request, ENURLCompletion completion);

// ---- audio
BOOL ENHasAudioSessionNotifications(void);   // AVAudioSessionInterruptionNotification and the others (iOS 6)

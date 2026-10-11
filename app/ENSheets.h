#import <UIKit/UIKit.h>

// The green action sheets and alerts (Drop 3a, DESIGN-5 §1.7 C2, package A1; mockup styles.css "sheets + alerts go green
// too"). Both stay stock UIKit objects in their own windows: callers only change the class name, and every delegate, ENPrompt
// / ENJamPrompt and one-per-kind guard is untouched (the clipboard watcher's "no alert or sheet is up" check still sees them).
// The skin runs in -layoutSubviews after super (idempotent: once, then only frames), all from ENTheme's chrome tokens:
// - ENActionSheet: its own panel (sheetBackgroundImage) inserted at index 0 over the hidden stock background (a full-size
//   UIImageView, when there is one; a stock panel drawn in drawRect stays under it either way), the buttons' backgrounds by
//   role (destructiveButtonIndex, cancelButtonIndex, other; pressed = green) with the sheet button font and text shadow, and
//   the title in #d2d2d2. Each button is matched to its index by title; if any can't be (an unexpected 6.1 hierarchy, e.g.
//   a scrolling table of buttons) the whole sheet keeps the stock look: never a hidden button, never a crash (PROMPT9).
// - ENAlertView: only its background (alertBackgroundImageOfSize: over the hidden stock image view, at the same frame). Its
//   stock buttons, text field, dim and pop animation already match the mockup. No stock image view = the stock look.
@interface ENActionSheet : UIActionSheet
// Optional: the title's first line, drawn bold white over the rest (#d2d2d2). Give the sheet the whole title, this line
// first: initWithTitle:@"<song>\n<artists>" ... then sheet.boldLine = @"<song>". If the bold line would not fit the stock
// title label's frame, the title stays plain (still recoloured).
@property (nonatomic, copy) NSString *boldLine;
@end

@interface ENAlertView : UIAlertView
@end

#import <UIKit/UIKit.h>

// First run: where the user's Encore Bridge (the gateway) lives + the 6-digit pairing code from its admin page. The fields
// start empty (ENGateway has no built-in address), with generic private-range placeholders.
// (owner: UI; 1.0, Drop 3c, DESIGN-5 §2.3 C5 / §1.3 "Setup", mockup .setup; owner of this drop's look: C5.) The look: the
// dark green §1.3 background (radial + stripes, -[ENTheme setupBackgroundImageOfSize:]), the centred 76 pt icon (the 152 px
// SetupIcon@2x.png from tools/make_art.py, rounded with its shadow baked in: -setupIconImage:), "Encore" and the tagline
// "An unofficial Spotify client for iOS 6" (D11), one grouped field box with Home, Away and Code rows (108 pt labels; the box and separator images), the
// hint "Open <home>/admin on your computer to sign in to Spotify and get a pairing code." built from the typed home address,
// a green wide Connect button (C7, 44 pt) and a centred status row. Every colour and font is an ENTheme setup… token (P2).
// The steps are 0.5's, named as the mockup: busy -> a white spinner and "Pairing…" (was "Looking for the gateway..."),
// failure -> the error in red, success -> the check and "Connected" (was "Paired (home)."), held .5 s so it is seen, then
// -[ENAppDelegate showMain] (which plays the launch animation because Setup was the root). New on purpose (§2.4 #12): an
// address typed without a scheme gets "http://" (Home and Away; the fields then show what was saved), so "192.168.1.20:8095"
// works. Unchanged (SETUP1-4): prefill from ENGateway, URL / number-pad keyboards (the dark Alert one), Return chaining
// home -> away -> code -> connect, exactly 6 digits after stripping non-digits, the addresses saved before pairWithCode:,
// Connect disabled while busy, the keyboard insets and scroll-to-button, a tap outside ends editing.
// (R2c, 3.5-inch screens) The content (~512 pt) scrolls on a 460 pt screen: with the keyboard up the field being edited
// stays in view as well as Connect (when both fit; else the field first), and a status (an error, "Pairing…") scrolls
// its row into view.
@interface ENSetupViewController : UIViewController <UITextFieldDelegate>
@end

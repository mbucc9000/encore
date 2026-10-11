#import "ENListViewController.h"

// The Home tab's root (app 0.7; owner: UI; mockup screens.js "Home"): Spotify's home rebuilt from your own listening
// (GET /v1/home, gateway personal.js): "Good evening, <name>", then shelves of cards (ENShelfCell) — Jump back in, Made For
// You, Your top artists, New releases for you — and Your Top Tracks as song rows. The nav bar's left button is your
// picture: it opens your profile (ENProfileViewController). Selected at launch: its first appearance ends launch_ms and
// also loads the library (other screens and the Add-to picker rely on [ENCatalog shared].library).
//
// Drop 3c (DESIGN-5 §2.3 C3; 1.0.0; owner C3), the mockup's Home, looks only:
//   - the table's backgroundView is ENTheme's homeBackground gradient; the greeting and the shelf rows are clear over it
//     (the Your Top Tracks song rows and their header stay opaque), and the base's empty state / footer sit on it too
//     (-listOverlayColor = clear)
//   - the greeting is Bold 21 (greetingFont) with "Jump back in" (13, shelfSub) under it while there is a Jump back in
//     shelf, which then has no title of its own; the later shelves have Bold 17 titles over 13 pt subs ("Last 4 weeks"),
//     each followed by the two-line separator; "Your Top Tracks · last 4 weeks"; a pressed card dims to .7 and the
//     cards' pictures fade in (ENShelfCell)
//   - the empty states are two-tier (title over message); the profile button's colours are ENTheme tokens and its picture
//     fades in when it arrives from disk or the network
// Every behaviour (loading, the 120 s reload, shelf positions, taps, the profile button) is unchanged.

@interface ENHomeViewController : ENListViewController

// The round profile button for a nav bar (Home, Library): your picture (ENCatalog meImageToken), else a person glyph.
// Tapping it pushes ENProfileViewController onto vc's navigation controller. Call -refreshProfileButton: from
// viewWillAppear: so a picture learned meanwhile shows.
+ (UIBarButtonItem *)profileButtonFor:(UIViewController *)vc;
+ (void)refreshProfileButton:(UIBarButtonItem *)item;

@end

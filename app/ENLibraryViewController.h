#import "ENListViewController.h"

// The Library tab's root (owner: UI; 0.7, mockup screens.js "Library"): Liked Songs (count from library.likedLength),
// Albums (your saved albums), Artists (the ones you follow), Recently Played (your last 50 plays), then Recently Added
// Albums (the newest 4 saved). Albums / Artists / Recently Played push ENLibraryListViewController. The nav bar's left
// button opens your profile. Drop 3a (DESIGN-5 A3): the 42 pt tiles come from -[ENTheme iconTileNamed:size:] (the same
// look).
// Drop 3c (DESIGN-5 §2.3 C3; 1.0.0; owner C3), the mockup's Library, looks and copy only: Recently Played's sub-line is
// "Last 50 plays" (§2.4 #11); in the sub-lists Recently Played has the small (Bold 17) nav title, artist rows have no
// "Artist" sub-line (the name centred in the row), and the empty states are two-tier (a title over the old sentence).

@interface ENLibraryViewController : ENListViewController

@end

// (0.7) Albums, Artists or Recently Played as a plain list (GET /v1/me/albums, /v1/me/artists, /v1/recent; pull to refresh).
// Albums / artists push their pages; a recently played song plays on tap (its sub-line says when you heard it) and has the
// ••• menu and swipe-to-queue like every song row.
@interface ENLibraryListViewController : ENListViewController
- (instancetype)initWithKind:(NSInteger)kind;               // an ENRowListKind
@end

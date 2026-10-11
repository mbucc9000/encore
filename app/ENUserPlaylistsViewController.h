#import "ENListViewController.h"

// Someone's public playlists, all of them (app 0.11, gateway 0.10.0; owner: PROFILES-APP; DESIGN-PROFILES §4.4): a profile's
// "See all N playlists". Title "Public Playlists". Pages of 50 from [ENCatalog loadUserPlaylists:offset:fresh:done:] (each page
// a memory-only route: cached copy first, then the network), "Load more…" (an action row, busy while loading) while the last
// page's next >= 0, the footer "N public playlists". Rows and taps as the profile's playlist section: the cover, the name, the
// sub-line "N followers" / "by <owner>" / "Playlist" (ENProfilePlaylistSub); a tap opens ENTrackListViewController with the
// row (inheriting ignoresMiniPlayer). Pull to refresh reloads the first page fresh (the later pages are asked for again as
// they are loaded more). Errors: the banner (rows stay). Fixed meterName "user playlists".
// Drop 3c (DESIGN-5 §2.3 C3; 1.0.0; owner C3), looks only: "No public playlists" is the two-tier kit's title
// (-setEmptyTitle:message:); a first page that fails with nothing to show adds "Couldn't load this list." / "Pull to
// refresh." under the banner (the Library lists' copy), cleared for the spinner by the next load. Covers fade in through
// ENListCell (C1).

@interface ENUserPlaylistsViewController : ENListViewController

- (instancetype)initWithUserURI:(NSString *)uri name:(NSString *)name;      // name: the profile's (for the "by" sub-lines)

@end

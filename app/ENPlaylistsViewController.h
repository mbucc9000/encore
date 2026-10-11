#import "ENListViewController.h"

// The Playlists tab's root (owner: UI; DESIGN-3 §5.5, §5.7), flat in 0.5 (folders `f` are ignored until Phase 5).
//   Rows: "Liked Songs" first (ENTheme likedTile, "N songs" from library.likedLength, no count while -1) -> pushes
//   ENTrackListViewController initWithLikedLibrary:; then every playlist in sidebar order (showPlaylist:) -> pushes
//   initWithPlaylist:.
//   Footer: "N playlists · updated <ENRelativeTime(checkedAt)>" (a revalidation's silent 304 renews it too: the screen
//   watches .library.checkedAt while its load is in flight). Pull to refresh = loadLibrary:YES.
//   Right bar button "+" (3c): [ENTrackActions newPlaylistFrom:self track:nil done:] then pushes the new playlist's list.
//   [ENCatalog shared].gatewayTooOld -> banner ENUpdateBridgeShortText ("Update your Encore Bridge", D8).
// Launch path: viewDidLoad shows -[ENCatalog cachedLibrarySync] (no network); the first viewDidAppear calls
// +[ENDiag launchFinished] once the visible covers are drawn, then revalidates (loadLibrary:NO). Later it revalidates when
// it reappears and the last check is over 60 s old, and on kind library / reset notifications it redraws from .library.
// Drop 3a (DESIGN-5 A3): the long press's Pin / Unpin sheet is an ENActionSheet (green); the rows are the list kit's.
// Drop 3c (DESIGN-5 §2.3 C3; 1.0.0; owner C3): no folder rows (folders aren't shown yet, so C3's folders item is skipped
// and the list stays flat); the empty state goes through -setEmptyTitle:message: only. Covers fade in through ENListCell (C1).

@interface ENPlaylistsViewController : ENListViewController

@end

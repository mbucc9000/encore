#import "ENListViewController.h"

// "See all songs" (owner: UI; DESIGN-3 §5.5): the search's songs, 10 per page. It starts with the first page's rows (the
// full search's tracks) and ends with a "Load 10 more…" row (a spinner while loading) that asks
// [ENCatalog search:q offset:tracksNext done:] until tracksNext is -1. Tap = [ENPlayback playURI:] (0.9.5: after
// [ENRecents add:], so the song shows in Search's "Recent searches"); rows have •••.
// Drop 3c (DESIGN-5 §2.3 C4; owner C4): titled “q” (the gateway's echo of the query, as the footer has it) in the small 17 pt
// title (the back button keeps the previous screen's title, "Search"); "Load 10 more…" is a centred green action row
// (-[ENListCell showAction:busy:]) whose spinner replaces the text while a page loads. The footer, the paging and the taps
// are unchanged.

@class ENSearchResult;

@interface ENSearchSongsViewController : ENListViewController

- (instancetype)initWithResult:(ENSearchResult *)first;          // the full search answer (query + first page of tracks)

@end

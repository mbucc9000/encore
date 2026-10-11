#import "ENListViewController.h"

// People lists (app 0.11, gateway 0.10.0; owner: PROFILES-APP; DESIGN-PROFILES §4.4): Search's "See all profiles", and a
// profile's Followers and Following.
//   Rows: a person via -[ENListCell showUser:subtitle:] (ENUserRows; round picture, chevron) with the sub-line "N followers"
//   when the gateway sent a count, else "Profile"; an artist in a following list via showArtist:subtitle:nil. A person opens
//   ENProfileViewController (the user's own uri: their own profile), an artist ENArtistViewController; both inherit
//   ignoresMiniPlayer.
//   "See all profiles" (-initWithSearchQuery:first:): title "Profiles", the first page Search already has, then "Load 10 more…"
//   (an action row; busy while loading) while the last page's next >= 0 ([ENCatalog searchUsers:offset:done:]); the footer
//   "N profiles". No pull to refresh (a search has no fresh copy).
//   Followers / Following (-initFollowersOf: / -initFollowingOf:): [ENCatalog loadFollowers: / loadFollowing:] (cached copy
//   first); pull to refresh reloads fresh; empty "No followers yet" / "Not following anyone yet"; a list the gateway cut
//   (trunc) gets the footer "Showing the first N". 404 user_not_found: the empty title "This profile isn't available on
//   Spotify."; other errors: the banner (rows stay).
// Fixed meterName "people". Ids, names and queries are never logged.
// Drop 3c (DESIGN-5 §2.3 C3; 1.0.0; owner C3), looks only: the empty states use the two-tier kit (-setEmptyTitle:message:):
// "No followers yet" / "Not following anyone yet" as titles; a 404 is "Profile not available" over "This profile isn't
// available on Spotify." (the profile screen's title over this list's sentence); a first load that fails with nothing to
// show adds "Couldn't load this list." / "Pull to refresh." under the banner (the Library lists' copy), and a reload clears
// it for the spinner. The round pictures fade in through ENListCell (C1).

@class ENRowList;

@interface ENPeopleViewController : ENListViewController

- (instancetype)initWithSearchQuery:(NSString *)q first:(ENRowList *)page;   // "See all profiles": title "Profiles", the first
                                                                             // page given; "Load 10 more…" (showAction, busy while
                                                                             // loading) while page.next >= 0; footer "N profiles"
- (instancetype)initFollowersOf:(NSString *)uri;                             // title "Followers"; empty "No followers yet"
- (instancetype)initFollowingOf:(NSString *)uri;                             // title "Following"; empty "Not following anyone yet"

@end

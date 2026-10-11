#import "ENListCell.h"

// People rows and the small bits the profile screens share (app 0.11, gateway 0.10.0; owner: PROFILES-APP; DESIGN-PROFILES
// §4.4). Used by ENProfileViewController, ENPeopleViewController, ENUserPlaylistsViewController and Search's Profiles section.
//   -[ENListCell showUser:subtitle:] (a category: ENListCell's own files are untouched): a person as a list row. It runs
//   showTitle:u.name subtitle:sub image:nil chevron:YES, then art = ENCellArtRound and [self setImageToken:u.image] (the 88
//   tier, round; the theme's round placeholder until it comes or without one), and item = u. No new per-row image (P4).
//   ENProfilePlaylistSub: a public playlist's sub-line on someone's profile: "N followers" when the playlist's count is known
//   and above 0, else "by <owner>" when the owner isn't the profile's own name, else "Playlist".
//   ENGroupedNumber: "1,234" (the "See all N playlists" row, "Following · N").
//   ENSameUser: two spotify:user: uris of the same person (their decoded ids compared; NO when either isn't one).
// Main thread only. No id or name is ever logged.

@class ENUserRow, ENPlaylist;

@interface ENListCell (ENUser)
- (void)showUser:(ENUserRow *)u subtitle:(NSString *)sub;
@end

NSString *ENProfilePlaylistSub(ENPlaylist *pl, NSString *profileName);
NSString *ENGroupedNumber(NSInteger n);
BOOL ENSameUser(NSString *a, NSString *b);

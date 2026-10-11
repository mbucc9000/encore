#import "ENListViewController.h"

// The Search tab's root (owner: UI; DESIGN-3 §5.5).
//   Field: a UISearchBar as navigationItem.titleView (tintColor ENTheme navTint), placeholder "Songs, artists, albums,
//   playlists" (0.11: unchanged; people come with every search, see the end). Empty field (0.9.5): "Recent searches" like Spotify's, the songs, artists, albums and playlists tapped here
//   (ENRecents: 20, one per uri, newest first) with a Clear button in the header. Rows: a song (cover) "Song · <artists>",
//   an artist (round) "Artist", an album "Album · <artist>", a playlist "Playlist · <owner>", each with a × on the right
//   (ENTheme `close` as the cell's moreGlyphOverride: it removes that row, animated) in place of the ••• / chevron.
//   Tapping one does what its first tap did (a song plays, the others push their page) and moves it to the top, shown when
//   the list is next built (coming back to the screen, or the field cleared; ENRecentsChangedNotification only marks it).
//   None: a footer "Your recent searches show up here". (0.9.4's list of query texts, "recentSearches", is gone.)
//   Typing: debounced 380 ms; a sequence number drops stale replies ([ENCatalog search:q offset:0 done:]).
//   Sections (sectioned table; this small table may implement heightForRowAtIndexPath:): Top Result (60 pt tall row),
//   Songs (5, without the top result when it is a track, then "See all songs" -> ENSearchSongsViewController), Artists
//   (3, round), Albums (3, "Artist · YYYY"), Playlists (3, "by <o>"; pushes ENTrackListViewController initWithPlaylist:).
//   No results: "Nothing found for “q”".
//   Drop 3c (DESIGN-5 §2.3 C4, §2.4 #9; owner C4; looks only, every behaviour above and below unchanged):
//   - the Top Result's header is the brighter green one (-strongSectionHeaderWithTitle:);
//   - "See all songs" is a centred green action row (-[ENListCell showAction:busy:]): "See all N songs" (tracksTotal, grouped
//     digits) when the total is known and over 1, else "See all songs"; same tap;
//   - the Artists section's rows show the name alone (no "Artist" sub-line; the Top Result and Recent searches keep theirs);
//   - with no query, under the recents, the hint "Search all of Spotify" over "Songs play instantly. Tap ••• on any song to add
//     it to a playlist." (-setFooterTitle:message:, the empty state's look as the footer); with no recents its message ends
//     "Your recent searches show up here." (the 0.9.5 hint). "Add songs" keeps the 0.9.5 footer (its songs are added);
//   - nothing found: "No results" over "Nothing found for “q”." (-setEmptyTitle:message:);
//   - a 16 pt spinner inside the field (its rightView) from each keystroke through the 380 ms debounce, off once that search
//     goes out (the table's centred spinner covers the wait while there is no result yet). iOS 6.1 hides the clear
//     button while a right view shows, so the spinner sits in the ×'s place and the × is back when it stops. Only rightView /
//     rightViewMode are set: the field keeps the first responder and the keyboard. No 6.1 text field found: no spinner.
//   A song row plays [ENPlayback playURI:]; other rows push their screen; songs have •••. Every song / artist / album /
//   playlist tapped (Top Result included; not "See all songs" itself, but a song tapped on that page) goes first in
//   Recent searches ([ENRecents add:]) before it plays or opens.
//   Scrolling resigns the search bar (ENTabBarController then reclaims first responder on UIKeyboardDidHideNotification).
//
// (0.9.3, DESIGN-JAM-UI.md) -initForJam: the Jam screen's "Add songs" sheet, presented by ENJamViewController in its own
// UINavigationController. Titled "Add songs" with "Done" on the left (closes the sheet); the field is the table's header
// (the filter bar look, placeholder "Find songs to add", focused when the sheet first shows); no mini player inset.
// A song row (Songs, a Top Result song, a recent song) adds the song instead of playing it: +[ENTrackActions addToQueue:],
// the ••• "Add to Jam" path with its HUD ("Added to the Jam") and errors, and the sheet stays open so several can be
// added; it shows the same Recent searches, and what is tapped in it (an add too) is recorded the same way. "See all
// songs", albums, playlists and artists push their pages in versions whose song rows add the same way (an artist page's
// albums open such an album page too); everything else on those pages is theirs (Play / Shuffle still play, ••• is the
// normal sheet). A failed search shows its message in place of the rows and a saved copy says so under them (the
// floating banner would cover the field). Outside this mode the screen is exactly as above.
//
// (0.11, gateway 0.10.0; DESIGN-PROFILES §4.4; owner tonight: PROFILES-APP) People, outside -initForJam only, while
// [ENCatalog profilesAvailable]:
//   - Profiles: every search of 2+ characters also asks [ENCatalog searchUsers:q offset:0] under the same sequence number (once
//     the song search has answered, while the field still says q); the answer for that query is a section "Profiles" (0.11.1;
//     0.11.0 put it last, two screens down under Playlists, and was missed): right after the Top Result (else first) when
//     one of the people is named the query (any case, any accents) and the Top Result isn't, so it is on the first screen
//     even with the keyboard up; otherwise right after Artists. Up to 3 people (ENUserRows: round picture, sub-line
//     "Profile"), a person whose name is the query first, the others in the gateway's order, then "See all profiles"
//     (chevron) when there are more -> ENPeopleViewController initWithSearchQuery:first: (the gateway's page as it came).
//     When the people come after the result is on screen the section goes in at its place without moving a row that may be
//     about to be tapped: a fade when its place is below the visible rows, or among them while the list rests at the top
//     (the rows under it slide down); unanimated with the offset grown by its height and the scroll indicators flashed when
//     the list rests scrolled past it; otherwise (scrolled with its place on screen, a finger down, moving) it waits for
//     the scrolling to stop. A "Nothing found" makes way for it. A failed people search is silent.
//   - (0.11.2) The scroll range (0.11.1 was reported not to scroll down to the last row; the cause is not confirmed: UIKit
//     6.1 sets the content height at once for the unanimated insert, so its offset shift stayed in range). At every scroll
//     end and after each late placement (after a fade: 0.5 s on, once its 0.3 s animation has set the content height) one
//     numbers-only line "search: range (…)": content height, bottom insets, the table's height and bottom edge against the
//     tab bar, the offset against its maximum, miniPlayerHeight, the keyboard. Two corrections, each logged when it acts:
//     with the keyboard down, contentInset.bottom / scrollIndicatorInsets.bottom below the bars' height (miniPlayerHeight;
//     0 with ignoresMiniPlayer) are raised to it (UITableViewController takes the keyboard's overlap off by difference, so
//     an inset rewritten while the keyboard was up comes out short), a turn after UIKeyboardDidHide and at every scroll
//     end; and a content height short of the last section's end is re-measured by reloadData (the offset kept) when a
//     drag begins and when the scrolling stops, never within 0.45 s of a Profiles fade. The unanimated placement uses
//     reloadData with the grown offset clamped to the range (no global animation switch).
//   - (0.11.1) Typing back to the query on screen while a newer search is in flight drops that search (its reply would
//     replace the screen under the field).
//   - A pasted profile link (ENUserURIFromLink: open.spotify.com/user/…, any ?si= / intl-xx, or spotify:user:…): no catalog
//     search; one section "Profile" with one row: the id with "Open profile", filled in by [ENCatalog loadUser:] with the name
//     and picture ("Profile"), or "Profile not available" (dimmed, untappable) on a 404. The row or the keyboard's Search key
//     opens ENProfileViewController.
//   - A person tapped (once the name is known) goes first in Recent searches ([ENRecents add:], kind user) with the sub-line
//     "Profile"; a recent person opens the profile; its × removes it. The "Add songs" sheet shows no people (not in its
//     results, nor in its Recent searches).
//   Section order: Top Result, Songs, Artists, Profiles, Albums, Playlists, or Top Result, Profiles, Songs, … when a person is
//   named the query (0.11.1; a missing section's place is taken by the one before it). Pushed screens inherit
//   ignoresMiniPlayer.

@interface ENSearchViewController : ENListViewController <UISearchBarDelegate>

- (instancetype)initForJam;

@end

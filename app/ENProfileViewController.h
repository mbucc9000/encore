#import "ENListViewController.h"

// A profile (app 0.7; owner: UI; 0.11 owner: PROFILES-APP, DESIGN-PROFILES §4.4): one class for everyone.
// Header (one drawRect, ENTheme tokens: profileHeaderTop/Mid/Bottom, profileAvatarShadow, profileNameShadow, miniSub, +fontOfSize:
// bold:): a 104 pt round picture at the 216 tier (the initials on the id's colour without one), the name and "N followers ·
// N following". Two clear buttons over the two halves of that line (8 pt of slop above and below) open the Followers / Following
// lists (ENPeopleViewController), each only while its count is > 0 and profiles are available. Someone else's profile with
// `cf` gets a 104 x 28 Follow (green) / Following (silver) button centred under the line (the header grows from 196 to 232 pt):
// optimistic [ENCatalog setUser:following:done:] with the HUD "Following" (check) / "Unfollowed" (x); a failure alerts, and a
// 501 hides the button for the screen's life. The nav title is the name ("Profile" until it is known; never logged).
//   - The user (-init; Home and Library's profile button; also -initWithUserURI: with their own uri): GET /v1/me as in 0.7:
//     Top artists this month, Top tracks this month and their PUBLIC playlists only (what others see; the Playlists tab and
//     Library show everything). It also loads their /v1/users/<me> (when the library knows me.id and profiles are available): its
//     counts replace /v1/me's, the two halves of the line open the lists, and a "People" section (Followers / Following) is
//     appended. That second load fails silently (the 0.7 header stays).
//   - Anyone else (-initWithUserURI:name:image:): GET /v1/users/<id>: "Public Playlists" (<= 10 rows, the sub-line "N
//     followers" / "by <owner>" / "Playlist", then "See all N playlists" -> ENUserPlaylistsViewController), "Recently played
//     artists" (<= 5, when they share them), "People" (Followers "N people", Following "N"). No public playlists: the footer
//     "No public playlists". 404 user_not_found: "Profile not available" / "Spotify doesn't show this profile."; an old gateway:
//     the banner ENUpdateBridgeText ("Update your Encore Bridge."); a saved copy: "Showing a saved copy"; other errors:
//     the banner (rows stay). Until the first answer the header shows the name and picture passed in, with the spinner.
// Pull to refresh reloads fresh. A playlist row opens ENTrackListViewController (the row carries n, i, o and ou, so its header
// draws at once; read-only, as the library says it isn't editable), an artist ENArtistViewController; everything pushed
// inherits ignoresMiniPlayer (the Jam sheet). Fixed meterName values: "profile" (own), "profile other".
// Drop 3c (DESIGN-5 §2.3 C3; 1.0.0; owner C3), looks only: the header's picture cross-fades in (ENFadeIn, 0.18 s) when it
// arrives from disk or the network while the screen is up (a memory copy shows at once); the Follow / Following button is set
// up by +[ENTheme configureButton:style:title:glyph:] (the same 28 pt green / silver pill, font and text shadows). Every
// colour and font is a token. The rows' pictures fade in through ENListCell (C1). Behaviour and the visibility rule (the
// user's own profile: public playlists only) are unchanged.

@interface ENProfileViewController : ENListViewController

- (id)init;                                                                       // the user (Home / Library profile button)
- (instancetype)initWithUserURI:(NSString *)uri name:(NSString *)name image:(NSString *)token;   // anyone; the user's own uri
                                                                                  // (library.meID) behaves exactly like -init
@property (nonatomic, readonly, copy) NSString *userURI;                          // spotify:user:<id> (own: nil until me.id is known)

@end

#import "ENListViewController.h"
#import "ENModel.h"

// An artist page (owner: UI; DESIGN-3 §5.5).
//   Header 320 x 170 pt: an aspect-fill crop of the 640-tier image drawn into the header bitmap (no layer masking), the name,
//   and a "Play Artist" button ([ENPlayback playContext:artistURI offsetURI:nil]).
//   Sections (UITableViewHeaderFooterView with ENTheme sectionHeaderBackground): Popular (ENTrack rows with art, sub-line =
//   album name; tap = [ENPlayback playURI:row.uri]; •••), Albums, Singles & EPs (showAlbum: with yearText; tap pushes
//   ENTrackListViewController initWithAlbum:). Empty sections are left out. Pull to refresh = loadArtist:fresh:YES.
// Drop 3c (DESIGN-5 §2.3 C2, 1.0.0; owner C2): the mockup's .ahdr. The name in artistNameFont (Bold 27) across the full width
//   (12 pt in from each side; 1 line, or 2 for a long name, growing upwards), its box 44 pt above the bottom, white with a soft
//   shadow baked into the bitmap; below it, 9 pt above the bottom, Play Artist as the 34 pt green gbtn with the .pi disc (C7,
//   +[ENTheme configureButton:…]; same action). The shade runs clear at 35 % -> artistShade (black .75). The 640-tier picture
//   fades in (ENFadeIn) when it comes from disk or the network. Empty states are -setEmptyTitle:message: ("Couldn't load this
//   artist." / "Pull to refresh."; "Nothing here yet"). Every colour and font is an ENTheme token. Rows, sections, taps, •••,
//   the Jam pick subclass (ENJamPickArtistViewController) and loading are unchanged.

@interface ENArtistViewController : ENListViewController

- (instancetype)initWithArtist:(ENArtistRow *)artist;                // a search / top-result AR row
- (instancetype)initWithArtistURI:(NSString *)uri name:(NSString *)name;   // Go to Artist / Now Playing (name may be nil)

@property (nonatomic, readonly, copy) NSString *artistURI;

@end

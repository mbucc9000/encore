#import <UIKit/UIKit.h>

// The ♥ button (owner: ACTIONS; DESIGN-3 §6.4). The UI places one in the mini player and in Now Playing's strip; it keeps
// itself right: filled green when [ENCatalog savedStateForURI:track.uri] is @YES, an outline otherwise (unknown = outline),
// redrawn on ENCatalogChangedNotification (kind liked) and, with followsPlayback, on ENPlaybackChangedNotification when the
// heard song changes. A tap calls +[ENTrackActions toggleSaved:]. Hidden (and untappable) while track is nil.
// The hit area is the button's frame (make it 44 pt); the glyph is drawn centred, ~20 pt. Main thread only.
// 0.10 (Drop 3a, DESIGN-5 §2.1 A2): the images are ENTheme's heart / heartO glyphs in its tokens (heartSaved; heartOnChrome
// on dark chrome, the palette's heartOutline on light content, which follows a theme switch). No behaviour change.

@class ENTrack;

typedef enum { ENHeartOnDark = 0, ENHeartOnLight } ENHeartStyle;   // outline colour for dark chrome (mini player, Now
                                                                   // Playing) or a light background

@interface ENHeartButton : UIButton

- (instancetype)initWithFrame:(CGRect)frame style:(ENHeartStyle)style;

@property (nonatomic, strong) ENTrack *track;          // what the heart is about (ignored while followsPlayback)
@property (nonatomic) BOOL followsPlayback;            // YES: track = [ENPlayback shared].playingTrack, kept up to date

@end

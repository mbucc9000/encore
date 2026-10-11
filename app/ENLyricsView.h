#import <UIKit/UIKit.h>

// Synced lyrics over Now Playing's art frame (app 0.8; owner: UI; DESIGN-LYRICS.md §3), Spotify-like in Encore's green.
//   The cover (aspect fill) under a #0f1a0c overlay at .8 (no cover: just the dark green); a plain, clear UITableView of
//   lines in HelveticaNeue-Bold 20, white, multi-line rows (heights precomputed at width - 40, 20 pt side padding), no
//   separators, contentInset top / bottom 40 % of the height; a footer "Lyrics from LRCLIB" (white .4, 11 pt).
//   synced: the current line ([ENLyrics lineIndexAtMs:positionMs]) white, the others white .45; the current line is kept at
//     ~35 % from the top (0.3 s scroll when it changes). A drag pauses that until 3 s after the drag / deceleration ends.
//     Tapping a line seeks to it when canSeek allows. Gap lines ("") show ♪. Only the rows whose state changed are touched.
//   plain: every line white .85, no highlight, no seeking; the footer adds "These lyrics aren't synced".
//   instrumental "♪  Instrumental"; none "No lyrics for this song"; error "Couldn't load lyrics. Tap to try again." (a tap
//   anywhere = +[ENLyrics loadForTrack:fresh:YES]); loading: a white spinner. While only a spinner or a message shows (and
//   with no track), touches fall through to the view below (Now Playing's art: its tap closes lyrics, its swipes skip).
// Lyric text is never logged. Main thread only.

@class ENTrack;

@interface ENLyricsView : UIView

@property (nonatomic, strong) UIImage *artwork;             // drawn behind the lines, darkened (nil -> the dark green)
@property (nonatomic, copy) BOOL (^canSeek)(void);          // tap-a-line seeks only when this answers YES (nil = YES)

- (void)showTrack:(ENTrack *)track;                         // loads (spinner) and shows; the same uri again = nothing
- (void)setActive:(BOOL)active;                             // YES while visible: a 0.25 s timer follows
                                                            // [ENPlayback shared].positionMs; NO stops it

@end

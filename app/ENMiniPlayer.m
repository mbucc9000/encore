#import "ENMiniPlayer.h"
#import "ENTheme.h"
#import "ENPlayback.h"
#import "ENImageCache.h"
#import "ENHeartButton.h"
#import "ENUtil.h"
#import "ENJam.h"

static const CGFloat ENMiniSkipAt = 70;          // drag distance (pt) that skips on release

// Now Playing's rule for prev / next and the art swipe: not a Jam guest without control
static BOOL ENMiniCanSkip(void) {
	ENJam *jam = [ENJam shared];
	return !(jam.active && jam.guest && !jam.canControl);
}

@interface ENMiniPlayer () <UIGestureRecognizerDelegate>
@end

@implementation ENMiniPlayer {
	UIView *_slot;                      // clips the sliding part (art + text) to its own area
	UIView *_content;                   // the art + text that follow a sideways swipe
	UIImageView *_art;
	UILabel *_artist, *_title;
	ENHeartButton *_heart;
	UIButton *_play;
	UIActivityIndicatorView *_spin;
	UIImageView *_progress;             // 0.10: ENTheme miniProgressImage along the top edge (2 pt line + its glow below)
	NSTimer *_timer;
	BOOL _active;
	NSString *_artToken;
	NSString *_artKey;                  // the cover load in flight (cancelled when the song changes again)
	UIImage *_knob[3][2];               // ENTheme's silver knob: [play, pause, empty (behind the spinner)][normal, pressed]
	BOOL _skipping;                     // a swipe's skip is sliding out / waiting / sliding in: no new swipe meanwhile
	BOOL _skipNext;                     // its direction (the side the new song comes in from)
	BOOL _waitingSong;                  // slid out; the new song hasn't shown yet (the reply is still out)
	NSString *_skipFrom;                // the song the skip left (nil once another one shows, or for a restart)
}

// the art's placeholder: the mini player is chrome, the same in both themes, so always the Light palette's tile (today's)
static UIImage *ENMiniPlaceholder(void) {
	return [ENTheme light].placeholderCover;
}

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		ENTheme *th = [ENTheme current];
		CGFloat w = frame.size.width;
		self.backgroundColor = th.miniPlayerFill;
		self.clipsToBounds = YES;

		UIImageView *bg = [[UIImageView alloc] initWithFrame:self.bounds];
		bg.image = th.miniPlayerBackground;
		bg.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
		[self addSubview:bg];

		CGFloat tx = 52, tw = w - tx - 44 - 46;
		_slot = [[UIView alloc] initWithFrame:CGRectMake(0, 0, tx + tw, frame.size.height)];
		_slot.backgroundColor = [UIColor clearColor];
		_slot.clipsToBounds = YES;
		[self addSubview:_slot];
		_content = [[UIView alloc] initWithFrame:_slot.bounds];
		_content.backgroundColor = [UIColor clearColor];
		[_slot addSubview:_content];

		// 0.10: the 36 pt art in miniArtFrame (a 1 pt #000 border and a white .12 outer ring, clear inside: the art at inset 2)
		UIImageView *artFrame = [[UIImageView alloc] initWithFrame:CGRectMake(5, 3, 40, 40)];
		artFrame.image = th.miniArtFrame;
		artFrame.userInteractionEnabled = NO;
		[_content addSubview:artFrame];
		_art = [[UIImageView alloc] initWithFrame:CGRectMake(7, 5, 36, 36)];
		_art.contentMode = UIViewContentModeScaleAspectFill;
		_art.clipsToBounds = YES;
		_art.image = ENMiniPlaceholder();
		[_content addSubview:_art];

		_artist = [[UILabel alloc] initWithFrame:CGRectMake(tx, 6, tw, 15)];
		_artist.font = th.miniSubFont;
		_artist.textColor = th.miniSub;
		_artist.backgroundColor = [UIColor clearColor];
		[_content addSubview:_artist];
		_title = [[UILabel alloc] initWithFrame:CGRectMake(tx, 21, tw, 20)];
		_title.font = th.miniTitleFont;
		_title.textColor = th.miniTitle;
		_title.backgroundColor = [UIColor clearColor];
		_title.shadowColor = th.miniTitleShadow;
		_title.shadowOffset = CGSizeMake(0, -1);
		[_content addSubview:_title];

		// art + text: a tap opens Now Playing, a sideways swipe skips
		[_slot addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(tapped)]];
		UIPanGestureRecognizer *pan = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(panned:)];
		pan.delegate = self;
		[_slot addGestureRecognizer:pan];

		_heart = [[ENHeartButton alloc] initWithFrame:CGRectMake(w - 46 - 44, 1, 44, 44) style:ENHeartOnDark];
		_heart.followsPlayback = YES;
		_heart.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin;
		[self addSubview:_heart];

		NSArray *glyphs = @[ @"play", @"pause", @"" ];       // (an empty name = the empty knob)
		for (NSUInteger i = 0; i < 3; i++) {
			for (NSUInteger p = 0; p < 2; p++) _knob[i][p] = [th knobImageWithGlyph:glyphs[i] pressed:(p == 1)];
		}
		_play = [UIButton buttonWithType:UIButtonTypeCustom];
		_play.frame = CGRectMake(w - 46, 0, 46, 46);
		_play.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin;
		_play.adjustsImageWhenHighlighted = NO;           // the pressed knob (a radial #f0f0f0 -> #a7a7a7) is its own image
		[self showKnob:0];
		[_play addTarget:self action:@selector(tapPlay) forControlEvents:UIControlEventTouchUpInside];
		[self addSubview:_play];
		_spin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleGray];
		_spin.hidesWhenStopped = YES;
		_spin.userInteractionEnabled = NO;
		_spin.center = CGPointMake(w - 23, 22);
		_spin.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin;
		[self addSubview:_spin];

		// 0.10: along the top edge (mockup v4); its 5 pt glow lies over the top of the bar, never taking a touch
		UIImage *line = th.miniProgressImage;
		_progress = [[UIImageView alloc] initWithFrame:CGRectMake(0, 0, 0, line.size.height)];
		_progress.image = line;
		_progress.userInteractionEnabled = NO;
		[self addSubview:_progress];

		[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(refresh) name:ENPlaybackChangedNotification object:nil];
		[self refresh];
	}
	return self;
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];
	[_timer invalidate];
}

- (void)tapped {
	if (self.onTap) self.onTap();
}

- (void)tapPlay {
	[[ENPlayback shared] togglePlayPause];
	[self refresh];
}

#pragma mark - swipe to skip

// only a mostly sideways drag starts the swipe, and not while the last skip is still under way (its animation would
// fight the finger, and a second next before the first one's song shows would name the same song again and land on it)
- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)g {
	if (![g isKindOfClass:[UIPanGestureRecognizer class]]) return YES;
	if (_skipping || [self skipPending]) return NO;
	CGPoint v = [(UIPanGestureRecognizer *)g velocityInView:_slot];
	return fabs(v.x) > fabs(v.y) && [ENPlayback shared].track != nil;
}

- (void)panned:(UIPanGestureRecognizer *)g {
	CGFloat w = _slot.bounds.size.width;
	CGFloat dx = [g translationInView:_slot].x;
	BOOL can = ENMiniCanSkip();
	switch (g.state) {
		case UIGestureRecognizerStateBegan:
		case UIGestureRecognizerStateChanged: {
			CGFloat x = can ? dx : dx * 0.2f;                       // a guest without control: a stiff rubber band
			_content.transform = CGAffineTransformMakeTranslation(x, 0);
			_content.alpha = 1 - MIN(0.6f, (CGFloat)fabs(x) / w);
			break;
		}
		case UIGestureRecognizerStateEnded: {
			CGFloat vx = [g velocityInView:_slot].x;
			BOOL back = fabs(vx) > 300 && (vx < 0) != (dx < 0);       // flicked back toward the start: keep the song
			BOOL go = can && [ENPlayback shared].track &&
			          ((fabs(dx) > ENMiniSkipAt && !back) || (fabs(vx) > 600 && fabs(dx) > 20 && (vx < 0) == (dx < 0)));
			if (go) [self skip:(dx < 0)];
			else [self snapBack];
			break;
		}
		default:
			[self snapBack];
			break;
	}
}

- (void)snapBack {
	[UIView animateWithDuration:0.2 delay:0 options:UIViewAnimationOptionCurveEaseOut | UIViewAnimationOptionBeginFromCurrentState
	                 animations:^{ self->_content.transform = CGAffineTransformIdentity; self->_content.alpha = 1; } completion:nil];
}

// next: the art + text leave to the left and the new song comes in from the right (previous: the other way round).
// The track only changes when the command's reply (or the engine's event) arrives, often well after the 0.15 s slide-out:
// until then the slot stays empty (the knob spins), so the old song never slides back in as if the skip had bounced.
- (void)skip:(BOOL)next {
	ENPlayback *pb = [ENPlayback shared];
	CGFloat w = _slot.bounds.size.width;
	BOOL restart = !next && pb.positionMs > 3000;              // ENPlayback -previous restarts the song: it comes back as is
	_skipping = YES;
	_skipNext = next;
	_waitingSong = NO;
	_skipFrom = restart ? nil : pb.playingURI;                 // before the command closes the stream
	if (next) [pb next];
	else [pb previous];
	[UIView animateWithDuration:0.15 delay:0 options:UIViewAnimationOptionCurveEaseIn | UIViewAnimationOptionBeginFromCurrentState
	                 animations:^{
		self->_content.transform = CGAffineTransformMakeTranslation(next ? -w : w, 0);
		self->_content.alpha = 0;
	} completion:^(BOOL finished) {
		[self refresh];
		if ([self skipPending]) {
			self->_waitingSong = YES;                          // -refresh slides it in once the song shows (or the command failed)
			[self performSelector:@selector(skipTimedOut) withObject:nil afterDelay:4];
			return;
		}
		[self slideIn];
	}];
}

// the skip's command is still out and the song shown is still the one it left (else forgets that song)
- (BOOL)skipPending {
	if (!_skipFrom) return NO;
	ENPlayback *pb = [ENPlayback shared];
	if (pb.commandPending && [pb.playingURI isEqualToString:_skipFrom]) return YES;
	_skipFrom = nil;
	return NO;
}

// a slow gateway: don't leave the slot empty; the new song then replaces the old one when it shows
- (void)skipTimedOut {
	if (_waitingSong) [self slideIn];
}

- (void)slideIn {
	CGFloat w = _slot.bounds.size.width;
	_waitingSong = NO;
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(skipTimedOut) object:nil];
	_content.transform = CGAffineTransformMakeTranslation(_skipNext ? w * 0.4f : -w * 0.4f, 0);
	[UIView animateWithDuration:0.22 delay:0 options:UIViewAnimationOptionCurveEaseOut animations:^{
		self->_content.transform = CGAffineTransformIdentity;
		self->_content.alpha = 1;
	} completion:^(BOOL finished) {
		self->_skipping = NO;
	}];
}

#pragma mark -

- (void)refresh {
	ENPlayback *pb = [ENPlayback shared];
	NSDictionary *t = pb.track;
	NSString *name = ENJStr(t[@"name"]);
	NSArray *artists = ENJArr(t[@"artists"]);
	_title.text = name ?: @"";
	_artist.text = artists.count ? [artists componentsJoinedByString:@", "] : @"";
	BOOL busy = pb.loading && pb.playing;
	[self showKnob:(busy ? 2 : pb.playing ? 1 : 0)];
	if (busy) [_spin startAnimating];
	else [_spin stopAnimating];
	[self updateArt];
	[self updateProgress];
	[self updateTimer];
	if (_waitingSong && ![self skipPending]) [self slideIn];       // a swipe's new song showed (or its command ended)
}

// 0 play, 1 pause, 2 the empty knob (behind the spinner); the pressed knob while touched
- (void)showKnob:(NSUInteger)i {
	[_play setImage:_knob[i][0] forState:UIControlStateNormal];
	[_play setImage:_knob[i][1] forState:UIControlStateHighlighted];
}

// 88 tier of track.img; an old gateway (no img) falls back to ENPlayback's artwork
- (void)updateArt {
	ENPlayback *pb = [ENPlayback shared];
	UIImage *placeholder = ENMiniPlaceholder();
	NSString *tok = ENJStr(pb.track[@"img"]);
	BOOL same = tok == _artToken || [tok isEqualToString:_artToken];
	if (!same && _artKey) { [[ENImageCache shared] cancel:_artKey]; _artKey = nil; }
	if (!tok) {
		_artToken = nil;
		_art.image = pb.artwork ?: placeholder;
		return;
	}
	if (same) return;
	_artToken = tok;
	ENImageCache *cache = [ENImageCache shared];
	UIImage *mem = [cache memoryImage:tok size:ENImg88 round:NO];
	_art.image = mem ?: placeholder;
	if (mem) return;
	__weak ENMiniPlayer *w = self;
	_artKey = [cache load:tok size:ENImg88 round:NO done:^(UIImage *image, NSString *key) {
		ENMiniPlayer *s = w;
		if (!s) return;
		if ([key isEqualToString:s->_artKey]) s->_artKey = nil;
		if (image && [tok isEqualToString:s->_artToken]) s->_art.image = image;
	}];
}

- (void)updateProgress {
	ENPlayback *pb = [ENPlayback shared];
	double d = pb.durationMs, p = pb.positionMs;
	double f = d > 0 ? MIN(1.0, MAX(0.0, p / d)) : 0;
	CGRect r = _progress.frame;
	r.size.width = roundf((float)(self.bounds.size.width * f));
	_progress.frame = r;
}

- (void)tick { [self updateProgress]; }

- (void)setActive:(BOOL)active {
	_active = active;
	if (active) [self refresh];
	else [self updateTimer];
}

// the progress line's own 0.5 s timer: only while shown (active, which includes "the app is active") and playing
- (void)updateTimer {
	BOOL want = _active && [ENPlayback shared].playing;
	if (want && !_timer) {
		_timer = [NSTimer timerWithTimeInterval:0.5 target:self selector:@selector(tick) userInfo:nil repeats:YES];
		[[NSRunLoop mainRunLoop] addTimer:_timer forMode:NSRunLoopCommonModes];
	} else if (!want && _timer) {
		[_timer invalidate];
		_timer = nil;
	}
}

@end

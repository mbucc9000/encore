#import "ENPlayerViewController.h"
#import "ENCompat.h"
#import "ENAnon.h"
#import "ENAppDelegate.h"
#import "ENGateway.h"
#import "ENPlayback.h"
#import "ENTabBarController.h"
#import "ENDiag.h"
#import "ENJam.h"
#import "ENJamActions.h"
#import "ENCatalog.h"
#import "ENSheets.h"
#import "ENTheme.h"
#import "ENL.h"

#pragma mark - drawn icons

static UIImage *ENDraw(CGSize size, void (^draw)(CGContextRef ctx)) {
	UIGraphicsBeginImageContextWithOptions(size, NO, 0);
	draw(UIGraphicsGetCurrentContext());
	UIImage *img = UIGraphicsGetImageFromCurrentImageContext();
	UIGraphicsEndImageContext();
	return img;
}

static void ENTriangle(CGContextRef c, CGFloat x, CGFloat y, CGFloat w, CGFloat h, BOOL right) {
	CGContextBeginPath(c);
	if (right) { CGContextMoveToPoint(c, x, y); CGContextAddLineToPoint(c, x + w, y + h / 2); CGContextAddLineToPoint(c, x, y + h); }
	else { CGContextMoveToPoint(c, x + w, y); CGContextAddLineToPoint(c, x, y + h / 2); CGContextAddLineToPoint(c, x + w, y + h); }
	CGContextClosePath(c);
	CGContextFillPath(c);
}

// 0.11 (B4): the disc in the Now Playing "on" green (npToggleOn), the glyph in the page colour (windowBackground)
static UIImage *ENPlayIcon(BOOL pause) {
	ENTheme *th = [ENTheme current];
	return ENDraw(CGSizeMake(64, 64), ^(CGContextRef c) {
		[th.npToggleOn setFill];
		CGContextFillEllipseInRect(c, CGRectMake(1, 1, 62, 62));
		[th.windowBackground setFill];
		if (pause) { CGContextFillRect(c, CGRectMake(22, 20, 7, 24)); CGContextFillRect(c, CGRectMake(35, 20, 7, 24)); }
		else ENTriangle(c, 25, 19, 22, 26, YES);
	});
}

static UIImage *ENSkipIcon(BOOL forward, UIColor *color) {
	return ENDraw(CGSizeMake(44, 44), ^(CGContextRef c) {
		[color setFill];
		if (forward) { ENTriangle(c, 12, 12, 17, 20, YES); CGContextFillRect(c, CGRectMake(29, 12, 4, 20)); }
		else { CGContextFillRect(c, CGRectMake(11, 12, 4, 20)); ENTriangle(c, 15, 12, 17, 20, NO); }
	});
}

static UIImage *ENShuffleIcon(UIColor *color) {
	return ENDraw(CGSizeMake(36, 36), ^(CGContextRef c) {
		[color set];
		CGContextSetLineWidth(c, 2);
		CGContextSetLineCap(c, kCGLineCapRound);
		CGContextMoveToPoint(c, 7, 12); CGContextAddLineToPoint(c, 11, 12);
		CGContextAddCurveToPoint(c, 18, 12, 18, 24, 25, 24); CGContextAddLineToPoint(c, 27, 24);
		CGContextMoveToPoint(c, 7, 24); CGContextAddLineToPoint(c, 11, 24);
		CGContextAddCurveToPoint(c, 18, 24, 18, 12, 25, 12); CGContextAddLineToPoint(c, 27, 12);
		CGContextStrokePath(c);
		ENTriangle(c, 26, 8, 5, 8, YES);
		ENTriangle(c, 26, 20, 5, 8, YES);
	});
}

static UIImage *ENRepeatIcon(UIColor *color, BOOL one) {
	return ENDraw(CGSizeMake(36, 36), ^(CGContextRef c) {
		[color set];
		CGContextSetLineWidth(c, 2);
		UIBezierPath *p = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(8, 11, 20, 14) cornerRadius:5];
		p.lineWidth = 2;
		[p stroke];
		[[UIColor clearColor] setFill];
		CGContextSetBlendMode(c, kCGBlendModeClear);
		CGContextFillRect(c, CGRectMake(15, 9, 6, 4));
		CGContextSetBlendMode(c, kCGBlendModeNormal);
		[color setFill];
		ENTriangle(c, 18, 7, 6, 8, YES);
		if (one) {
			NSString *s = @"1";
			[s drawInRect:CGRectMake(8, 13, 20, 12) withFont:[ENTheme fontOfSize:9 bold:YES] lineBreakMode:NSLineBreakByClipping alignment:NSTextAlignmentCenter];
		}
	});
}

static NSString *ENTime(double ms) {
	long s = (long)floor(MAX(0, ms) / 1000.0);
	return [NSString stringWithFormat:@"%ld:%02ld", s / 60, s % 60];
}

static NSInteger ENTierSegment(NSString *tier) {     // segment index of a tier name, -1 if none
	for (NSInteger i = 0; i < 4; i++) if ([ENTierNames[i] isEqualToString:tier]) return i;
	return -1;
}

#pragma mark -

@implementation ENPlayerViewController {
	UIScrollView *_scroll;
	UIImageView *_art;
	UILabel *_title, *_artist, *_line, *_elapsed, *_remain, *_msg, *_debug;
	UISlider *_slider;
	BOOL _scrubbing;
	UIButton *_play, *_prev, *_next, *_shuffle, *_repeat, *_back15, *_fwd30, *_go, *_unpair, *_memTest, *_jamRow;
	UILabel *_jamValue;
	UIActivityIndicatorView *_spin;
	UISegmentedControl *_quality;
	UISwitch *_auto;
	UITextField *_link;
	UIImage *_placeholder, *_playImg, *_pauseImg;
	UIImage *_shuffleImg[2], *_repeatImg[3];
	UIFont *_artistFont, *_artistIdleFont;       // the artist line: 15, or 12 for the "Nothing playing" hint
	UIAlertView *_unpairAlert;       // 0.11: pushed now (no longer the tab root): its assign delegate is cleared in dealloc
	NSTimer *_timer;
	CGFloat _miniH, _kbH;            // bottom insets: the mini player (0.5 tabs) and the keyboard's overlap
}

- (UILabel *)label:(CGRect)f font:(UIFont *)font color:(UIColor *)c align:(NSTextAlignment)a {
	UILabel *l = [[UILabel alloc] initWithFrame:f];
	l.font = font;
	l.textColor = c;
	l.textAlignment = a;
	l.backgroundColor = [UIColor clearColor];
	[_scroll addSubview:l];
	return l;
}

- (UIButton *)button:(CGRect)f action:(SEL)sel {
	UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
	b.frame = f;
	b.showsTouchWhenHighlighted = NO;
	b.adjustsImageWhenHighlighted = YES;
	[b addTarget:self action:sel forControlEvents:UIControlEventTouchUpInside];
	[_scroll addSubview:b];
	return b;
}

- (UIButton *)pill:(CGRect)f title:(NSString *)t action:(SEL)sel {
	ENTheme *th = [ENTheme current];
	UIButton *b = [self button:f action:sel];
	[b setTitle:t forState:UIControlStateNormal];
	[b setTitleColor:th.navTitle forState:UIControlStateNormal];
	[b setTitleColor:th.npDeviceSub forState:UIControlStateHighlighted];
	b.titleLabel.font = [ENTheme fontOfSize:13 bold:YES];
	b.backgroundColor = th.miniPlayerFill;
	b.layer.cornerRadius = f.size.height / 2;
	b.layer.borderColor = th.navTint.CGColor;
	b.layer.borderWidth = 1;
	return b;
}

- (void)dealloc {
	_unpairAlert.delegate = nil;     // UIAlertView.delegate is assign on iOS 6
}

// 0.11 (B4): a dark page in both themes, from ENTheme's chrome tokens (identical in every palette): the page windowBackground,
// cards and pills miniPlayerFill with a navTint border, text navTitle / npDeviceSub / npTimeText, green npToggleOn, red
// +queue's jamRed (the always-dark palette); Helvetica Neue through +[ENTheme fontOfSize:bold:] (the debug readout too: no
// monospaced token)
- (void)loadView {
	ENTheme *th = [ENTheme current];
	UIView *v = [[UIView alloc] initWithFrame:[UIScreen mainScreen].applicationFrame];
	v.backgroundColor = th.windowBackground;
	self.view = v;
	// the navigation item only: setting self.title would also rename the Settings tab while this is still its root (until B5)
	[th applyTitle:ENL(@"Diagnostics") toItem:self.navigationItem small:NO];

	_scroll = [[UIScrollView alloc] initWithFrame:v.bounds];
	_scroll.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
	_scroll.alwaysBounceVertical = YES;
	_scroll.indicatorStyle = UIScrollViewIndicatorStyleWhite;
	[v addSubview:_scroll];

	_placeholder = [th nowPlayingPlaceholderOfSide:236];      // (not cached by ENTheme: kept while this screen lives)
	_playImg = ENPlayIcon(NO);
	_pauseImg = ENPlayIcon(YES);
	_shuffleImg[0] = ENShuffleIcon(th.npToggleOff);
	_shuffleImg[1] = ENShuffleIcon(th.npToggleOn);
	_repeatImg[0] = ENRepeatIcon(th.npToggleOff, NO);
	_repeatImg[1] = ENRepeatIcon(th.npToggleOn, NO);
	_repeatImg[2] = ENRepeatIcon(th.npToggleOn, YES);
	_artistFont = [ENTheme fontOfSize:15 bold:NO];
	_artistIdleFont = [ENTheme fontOfSize:12 bold:NO];

	_art = [[UIImageView alloc] initWithFrame:CGRectMake(42, 16, 236, 236)];
	_art.image = _placeholder;
	_art.contentMode = UIViewContentModeScaleAspectFill;
	_art.clipsToBounds = YES;
	_art.layer.cornerRadius = 4;
	UIView *shadow = [[UIView alloc] initWithFrame:_art.frame];
	shadow.backgroundColor = th.windowBackground;
	shadow.layer.shadowColor = [UIColor blackColor].CGColor;
	shadow.layer.shadowOpacity = 0.7;
	shadow.layer.shadowRadius = 10;
	shadow.layer.shadowOffset = CGSizeMake(0, 4);
	shadow.layer.shadowPath = [UIBezierPath bezierPathWithRect:shadow.bounds].CGPath;
	[_scroll addSubview:shadow];
	[_scroll addSubview:_art];

	_title = [self label:CGRectMake(16, 266, 288, 24) font:th.bigTitleFont color:th.navTitle align:NSTextAlignmentCenter];
	_artist = [self label:CGRectMake(16, 291, 288, 20) font:_artistFont color:th.npDeviceSub align:NSTextAlignmentCenter];
	_line = [self label:CGRectMake(16, 313, 288, 16) font:[ENTheme fontOfSize:11 bold:YES] color:th.npToggleOn align:NSTextAlignmentCenter];
	_line.adjustsFontSizeToFitWidth = YES;     // "... Very High > Normal (auto)" is long
	ENSetMinimumScaleFactor(_line, 0.7f);      // (1.1: iOS 5, minimumFontSize)

	// the slider kit (C9, as Now Playing's scrubber): 31 pt tall for its thumb, centred where the 24 pt slider was
	_slider = [[UISlider alloc] initWithFrame:CGRectMake(18, 332, 284, 31)];
	[th styleSlider:_slider];
	[_slider addTarget:self action:@selector(scrubStart) forControlEvents:UIControlEventTouchDown];
	[_slider addTarget:self action:@selector(scrubMove) forControlEvents:UIControlEventValueChanged];
	[_slider addTarget:self action:@selector(scrubEnd) forControlEvents:UIControlEventTouchUpInside | UIControlEventTouchUpOutside | UIControlEventTouchCancel];
	[_scroll addSubview:_slider];
	UIFont *small = [ENTheme fontOfSize:11 bold:NO], *smallBold = [ENTheme fontOfSize:11 bold:YES];
	_elapsed = [self label:CGRectMake(20, 362, 70, 14) font:small color:th.npTimeText align:NSTextAlignmentLeft];
	_remain = [self label:CGRectMake(230, 362, 70, 14) font:small color:th.npTimeText align:NSTextAlignmentRight];

	_shuffle = [self button:CGRectMake(18, 392, 36, 36) action:@selector(tapShuffle)];
	_prev = [self button:CGRectMake(68, 388, 44, 44) action:@selector(tapPrev)];
	[_prev setImage:ENSkipIcon(NO, th.navTitle) forState:UIControlStateNormal];
	_play = [self button:CGRectMake(128, 378, 64, 64) action:@selector(tapPlay)];
	[_play setImage:_playImg forState:UIControlStateNormal];
	_spin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleWhiteLarge];
	_spin.color = th.windowBackground;
	_spin.center = _play.center;
	_spin.hidesWhenStopped = YES;
	_spin.userInteractionEnabled = NO;
	[_scroll addSubview:_spin];
	_next = [self button:CGRectMake(208, 388, 44, 44) action:@selector(tapNext)];
	[_next setImage:ENSkipIcon(YES, th.navTitle) forState:UIControlStateNormal];
	_repeat = [self button:CGRectMake(266, 392, 36, 36) action:@selector(tapRepeat)];

	_back15 = [self pill:CGRectMake(70, 456, 80, 30) title:ENL(@"-15 s") action:@selector(tapBack)];
	_fwd30 = [self pill:CGRectMake(170, 456, 80, 30) title:ENL(@"+30 s") action:@selector(tapFwd)];

	UILabel *qh = [self label:CGRectMake(20, 502, 280, 14) font:smallBold color:th.npDeviceSub align:NSTextAlignmentLeft];
	qh.text = ENL(@"STREAMING QUALITY");
	UILabel *ah = [self label:CGRectMake(150, 502, 84, 14) font:smallBold color:th.npDeviceSub align:NSTextAlignmentRight];
	ah.text = ENL(@"AUTO");
	_auto = [[UISwitch alloc] initWithFrame:CGRectZero];      // the stock switch, scaled down to sit on the header line
	_auto.transform = CGAffineTransformMakeScale(0.75, 0.75);
	_auto.center = CGPointMake(300 - _auto.bounds.size.width * 0.375, 508);
	[_auto addTarget:self action:@selector(autoChanged) forControlEvents:UIControlEventValueChanged];
	[_scroll addSubview:_auto];
	_quality = [[UISegmentedControl alloc] initWithItems:@[ ENL(@"Very High"), ENL(@"High"), ENL(@"Normal"), ENL(@"Low") ]];
	_quality.segmentedControlStyle = UISegmentedControlStyleBar;
	_quality.frame = CGRectMake(20, 520, 280, 32);
	[_quality addTarget:self action:@selector(qualityChanged) forControlEvents:UIControlEventValueChanged];
	[_scroll addSubview:_quality];

	// 0.6: the Jam row (DESIGN-4b §6.11): the Jam screen, and what the Jam is doing
	UILabel *jh = [self label:CGRectMake(20, 566, 280, 14) font:smallBold color:th.npDeviceSub align:NSTextAlignmentLeft];
	jh.text = ENL(@"JAM");
	_jamRow = [self button:CGRectMake(20, 584, 280, 38) action:@selector(tapJam)];
	_jamRow.backgroundColor = th.miniPlayerFill;
	_jamRow.layer.cornerRadius = 8;
	_jamRow.layer.borderColor = th.navTint.CGColor;
	_jamRow.layer.borderWidth = 1;
	UILabel *jl = [[UILabel alloc] initWithFrame:CGRectMake(12, 0, 80, 38)];
	jl.font = [ENTheme fontOfSize:14 bold:YES];
	jl.textColor = th.navTitle;
	jl.backgroundColor = [UIColor clearColor];
	jl.text = ENL(@"Jam");
	[_jamRow addSubview:jl];
	_jamValue = [[UILabel alloc] initWithFrame:CGRectMake(70, 0, 184, 38)];
	_jamValue.font = [ENTheme fontOfSize:13 bold:NO];
	_jamValue.textColor = th.npDeviceSub;
	_jamValue.backgroundColor = [UIColor clearColor];
	_jamValue.textAlignment = NSTextAlignmentRight;
	[_jamRow addSubview:_jamValue];
	UILabel *chev = [[UILabel alloc] initWithFrame:CGRectMake(258, 0, 14, 38)];
	chev.font = [ENTheme fontOfSize:16 bold:YES];
	chev.textColor = th.npDeviceSub;
	chev.backgroundColor = [UIColor clearColor];
	chev.text = @"›";
	[_jamRow addSubview:chev];

	UILabel *lh = [self label:CGRectMake(20, 626, 280, 14) font:smallBold color:th.npDeviceSub align:NSTextAlignmentLeft];
	lh.text = ENL(@"PLAY A SPOTIFY LINK");
	_link = [[UITextField alloc] initWithFrame:CGRectMake(20, 644, 206, 38)];
	_link.placeholder = ENL(@"open.spotify.com/... or spotify:...");
	_link.font = [ENTheme fontOfSize:14 bold:NO];
	_link.textColor = th.navTitle;
	_link.backgroundColor = th.miniPlayerFill;
	_link.layer.cornerRadius = 8;
	_link.layer.borderColor = th.navTint.CGColor;
	_link.layer.borderWidth = 1;
	_link.leftView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 10, 38)];
	_link.leftViewMode = UITextFieldViewModeAlways;
	_link.contentVerticalAlignment = UIControlContentVerticalAlignmentCenter;
	_link.clearButtonMode = UITextFieldViewModeWhileEditing;
	_link.autocorrectionType = UITextAutocorrectionTypeNo;
	_link.autocapitalizationType = UITextAutocapitalizationTypeNone;
	_link.keyboardType = UIKeyboardTypeURL;
	_link.keyboardAppearance = UIKeyboardAppearanceAlert;
	_link.returnKeyType = UIReturnKeyGo;
	_link.delegate = self;
	[_scroll addSubview:_link];
	_go = [self pill:CGRectMake(234, 644, 66, 38) title:ENL(@"Play") action:@selector(tapGo)];
	_go.backgroundColor = th.npToggleOn;
	[_go setTitleColor:th.windowBackground forState:UIControlStateNormal];
	_go.layer.borderWidth = 0;
	_go.layer.cornerRadius = 19;

	UIColor *red = [ENTheme queue].jamRed;
	_msg = [self label:CGRectMake(20, 688, 280, 32) font:[ENTheme fontOfSize:12 bold:NO] color:red align:NSTextAlignmentLeft];
	_msg.numberOfLines = 2;

	UIView *card = [[UIView alloc] initWithFrame:CGRectMake(14, 724, 292, 92)];
	card.backgroundColor = th.miniPlayerFill;
	card.layer.cornerRadius = 8;
	[_scroll addSubview:card];
	_debug = [self label:CGRectMake(22, 728, 278, 84) font:[ENTheme fontOfSize:10.5f bold:NO] color:th.npDeviceSub align:NSTextAlignmentLeft];
	_debug.numberOfLines = 6;

	// T-b4: what a memory warning frees (the image cache, hidden lists' models); before / after go to the diag log
	_memTest = [self pill:CGRectMake(70, 830, 180, 32) title:ENL(@"Simulate memory warning") action:@selector(tapMemoryWarning)];
	_memTest.titleLabel.font = [ENTheme fontOfSize:12 bold:NO];

	_unpair = [self pill:CGRectMake(90, 876, 140, 32) title:ENL(@"Unpair this phone") action:@selector(tapUnpair)];
	[_unpair setTitleColor:red forState:UIControlStateNormal];
	_unpair.titleLabel.font = [ENTheme fontOfSize:12 bold:NO];

	_scroll.contentSize = CGSizeMake(320, 928);
	UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(dismissKeyboard)];
	tap.cancelsTouchesInView = NO;
	[_scroll addGestureRecognizer:tap];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	self.navigationController.navigationBarHidden = NO;
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(refresh) name:ENPlaybackChangedNotification object:nil];
	[nc addObserver:self selector:@selector(refresh) name:ENGatewayRouteChangedNotification object:nil];
	[nc addObserver:self selector:@selector(refresh) name:ENJamChangedNotification object:nil];
	[nc addObserver:self selector:@selector(refresh) name:ENCatalogVersionNotification object:nil];
	[nc addObserver:self selector:@selector(keyboard:) name:UIKeyboardWillShowNotification object:nil];
	[nc addObserver:self selector:@selector(keyboard:) name:UIKeyboardWillHideNotification object:nil];
	[nc addObserver:self selector:@selector(miniLayout:) name:ENMiniPlayerLayoutNotification object:nil];
	[nc addObserver:self selector:@selector(appInactive) name:UIApplicationWillResignActiveNotification object:nil];
	[nc addObserver:self selector:@selector(appInactive) name:UIApplicationDidEnterBackgroundNotification object:nil];
	[nc addObserver:self selector:@selector(appActive) name:UIApplicationDidBecomeActiveNotification object:nil];
	_miniH = [ENTabBarController shared].miniPlayerHeight;
	[self applyInsets];
	[self startTimer];
	NSUInteger qi = 0;
	for (NSUInteger i = 0; i < 4; i++) if ([ENTierNames[i] isEqualToString:[ENPlayback shared].tier]) qi = i;
	_quality.selectedSegmentIndex = qi;
	_auto.on = [ENPlayback shared].autoQuality;
	[self refresh];
}

// 0.11: pushed from Settings now, so it hands the remote controls back on every appearance too (P6, LOCK2)
- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	[[ENTabBarController shared] reclaimFirstResponder];
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	[self stopUpdates];
}

// The 0.5 s refresh only while shown AND the app is active: locking the phone or leaving the app doesn't call
// viewWillDisappear:, so it stops on WillResignActive / DidEnterBackground and restarts on DidBecomeActive.
- (void)startTimer {
	if (_timer) return;
	_timer = [NSTimer timerWithTimeInterval:0.5 target:self selector:@selector(refresh) userInfo:nil repeats:YES];
	[[NSRunLoop mainRunLoop] addTimer:_timer forMode:NSRunLoopCommonModes];
}

- (void)appInactive {
	[_timer invalidate];
	_timer = nil;
}

- (void)appActive {
	[self startTimer];
	[self refresh];
}

// the timer (which retains this screen) and every observer
- (void)stopUpdates {
	[_timer invalidate];
	_timer = nil;
	[[NSNotificationCenter defaultCenter] removeObserver:self];
}

#pragma mark - refresh

- (void)refresh {
	ENPlayback *pb = [ENPlayback shared];
	NSDictionary *t = pb.track;
	NSString *name = [t[@"name"] isKindOfClass:[NSString class]] ? t[@"name"] : nil;
	NSArray *artists = [t[@"artists"] isKindOfClass:[NSArray class]] ? t[@"artists"] : nil;
	_title.text = name ?: ENL(@"Nothing playing");
	_artist.text = name ? [artists componentsJoinedByString:@", "] : ENL(@"Paste a link below, or pick Encore in Spotify on your computer.");
	_artist.font = name ? _artistFont : _artistIdleFont;
	UIImage *art = pb.artwork ?: _placeholder;
	if (_art.image != art) {
		[UIView transitionWithView:_art duration:0.25 options:UIViewAnimationOptionTransitionCrossDissolve
		                animations:^{ self->_art.image = art; } completion:nil];
	}

	double dur = pb.durationMs, pos = pb.positionMs;
	if (!_scrubbing) {
		_slider.value = dur > 0 ? (float)(pos / dur) : 0;
		_elapsed.text = ENTime(pos);
	}
	_remain.text = dur > 0 ? [@"-" stringByAppendingString:ENTime(dur - (_scrubbing ? _slider.value * dur : pos))] : @"";
	_slider.enabled = dur > 0;

	BOOL busy = pb.loading && pb.playing;
	[_play setImage:(busy ? [self emptyCircle] : pb.playing ? _pauseImg : _playImg) forState:UIControlStateNormal];
	if (busy) [_spin startAnimating];
	else [_spin stopAnimating];

	[_shuffle setImage:_shuffleImg[pb.shuffle ? 1 : 0] forState:UIControlStateNormal];
	NSUInteger r = [pb.repeatMode isEqualToString:@"track"] ? 2 : [pb.repeatMode isEqualToString:@"context"] ? 1 : 0;
	[_repeat setImage:_repeatImg[r] forState:UIControlStateNormal];

	ENGateway *gw = [ENGateway shared];
	NSString *q = [_quality titleForSegmentAtIndex:_quality.selectedSegmentIndex];
	ENStreamPlayer *sp = pb.stream;
	NSInteger ai = ENTierSegment(pb.activeTier);
	if (sp && ai >= 0 && ai != _quality.selectedSegmentIndex)      // stepped down from the ceiling: "Very High > Normal (auto)"
		q = [NSString stringWithFormat:@"%@ > %@", q, pb.autoQuality ? [NSString stringWithFormat:ENL(@"%@ (auto)"), [_quality titleForSegmentAtIndex:ai]]
		                                                    : [_quality titleForSegmentAtIndex:ai]];
	NSString *state;
	if (pb.loading && sp.state == ENStreamStalled) state = ENL(@"Rebuffering...");
	else if (pb.loading && pb.playing) state = ENL(@"Loading...");
	else if (pb.playing) state = ENL(@"Playing on this iPhone");
	else if (pb.remoteDevice) state = [NSString stringWithFormat:ENL(@"On %@ (play to move it here)"), pb.remoteDevice];
	else state = ENL(@"Paused");
	_line.text = pb.remoteDevice && !pb.playing ? state : [NSString stringWithFormat:@"%@  ·  %@  ·  %@", state, gw.away ? ENL(@"Away") : ENL(@"Home"), q];

	_msg.text = pb.message;
	ENJam *jam = [ENJam shared];
	_jamValue.text = jam.available ? [jam label] : ENL(ENUpdateBridgeShortText);

	static const char *names[] = { "idle", "connecting", "buffering", "playing", "paused", "stalled", "failed" };
	NSDictionary *eng = pb.engine;
	NSDictionary *engEng = [eng[@"engine"] isKindOfClass:[NSDictionary class]] ? eng[@"engine"] : nil;
	_debug.text = [NSString stringWithFormat:
		@"gen %@  stream %s  buffer %.1f/%.0f s\n"
		@"%@ %ldk  %.1f MB  start %.2f s %@\n"
		@"stalls %lu  reconnects %lu  sw %lu  rx %ldk\n"
		@"engine %@ (gen %@)%@\n"
		@"%@ %@\n"
		@"device %@",
		sp ? [NSString stringWithFormat:@"%ld", (long)sp.gen] : @"-", sp ? names[sp.state] : "none", sp.bufferedSeconds, sp.leadSeconds,
		pb.activeTier, (long)sp.kbps, sp.bytesReceived / 1048576.0, sp.startLatency, sp.startHow ?: @"",
		(unsigned long)sp.stalls, (unsigned long)sp.reconnects, (unsigned long)sp.switches, (long)sp.rx8Kbps,
		eng[@"status"] ?: @"?", eng[@"gen"] ?: @"?", [engEng[@"connected"] boolValue] ? @"" : @"  NOT CONNECTED",
		// (R2a) the bridge's address and this phone's device id are hidden while Anonymous Mode is on
		gw.away ? @"away" : @"home", [ENAnon on] ? @"(hidden)" : (gw.baseURL ?: @"-"),
		[ENAnon on] ? @"(hidden)" : (gw.deviceID ?: @"-")];
}

- (UIImage *)emptyCircle {
	static UIImage *img;
	if (!img) img = ENDraw(CGSizeMake(64, 64), ^(CGContextRef c) {
		[[ENTheme current].npToggleOn setFill];
		CGContextFillEllipseInRect(c, CGRectMake(1, 1, 62, 62));
	});
	return img;
}

#pragma mark - actions

- (void)tapPlay { [[ENPlayback shared] togglePlayPause]; [self refresh]; }
- (void)tapPrev { [[ENPlayback shared] previous]; [self refresh]; }
- (void)tapNext { [[ENPlayback shared] next]; [self refresh]; }
- (void)tapBack { [[ENPlayback shared] skipBy:-15000]; [self refresh]; }
- (void)tapFwd { [[ENPlayback shared] skipBy:30000]; [self refresh]; }
- (void)tapShuffle { [[ENPlayback shared] toggleShuffle]; [self refresh]; }
- (void)tapRepeat { [[ENPlayback shared] cycleRepeat]; [self refresh]; }

- (void)qualityChanged {
	NSInteger i = _quality.selectedSegmentIndex;
	if (i >= 0 && i < 4) [ENPlayback shared].tier = ENTierNames[i];
	[self refresh];
}

- (void)autoChanged {
	[ENPlayback shared].autoQuality = _auto.on;
	[self refresh];
}

- (void)scrubStart { _scrubbing = YES; }

- (void)scrubMove {
	double dur = [ENPlayback shared].durationMs;
	_elapsed.text = ENTime(_slider.value * dur);
}

- (void)scrubEnd {
	if (!_scrubbing) return;
	_scrubbing = NO;
	double dur = [ENPlayback shared].durationMs;
	if (dur > 0) [[ENPlayback shared] seekTo:_slider.value * dur];
	[self refresh];
}

- (void)tapJam {
	[self dismissKeyboard];
	if ([ENJam shared].available) [[ENTabBarController shared] presentJam];
}

- (void)tapGo {
	NSString *s = _link.text;
	if (!s.length) return;
	if ([ENJam isJamLink:s]) {           // 0.6: a Jam is joined (after a prompt), never played (DESIGN-4b §6.6)
		_link.text = @"";
		[self dismissKeyboard];
		[ENJamActions offerJoinLink:s];
		return;
	}
	if (![[ENPlayback shared] playLink:s]) {
		[[[ENAlertView alloc] initWithTitle:ENL(@"Not a Spotify link") message:ENL(@"Paste a song, album, playlist or artist link (open.spotify.com/... or spotify:...). Podcasts aren't supported.")
		                           delegate:nil cancelButtonTitle:ENL(@"OK") otherButtonTitles:nil] show];
		return;
	}
	_link.text = @"";
	[self dismissKeyboard];
	[_scroll setContentOffset:CGPointZero animated:YES];
}

- (void)dismissKeyboard {
	[self.view endEditing:YES];
	[[ENTabBarController shared] reclaimFirstResponder];      // lock screen / headphone controls (0.5: the tab controller)
}

- (void)textFieldDidBeginEditing:(UITextField *)f {
	if (f.text.length || [ENAnon on]) return;        // (Anonymous Mode: never show the clipboard, e.g. a Jam invite)
	NSString *clip = [UIPasteboard generalPasteboard].string;
	if (clip.length && ([ENPlayback uriFromLink:clip] || [ENJam isJamLink:clip])) f.text = clip;    // save a paste
}

- (BOOL)textFieldShouldReturn:(UITextField *)f {
	[self tapGo];
	return YES;
}

- (void)keyboard:(NSNotification *)n {
	BOOL show = [n.name isEqualToString:UIKeyboardWillShowNotification];
	CGRect kb = [self.view convertRect:[n.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue] fromView:nil];
	_kbH = show ? MAX(0, CGRectGetMaxY(self.view.bounds) - kb.origin.y) : 0;     // the part over this view (the tab bar takes the rest)
	[self applyInsets];
	if (show && _link.isFirstResponder) [_scroll scrollRectToVisible:CGRectInset(_link.frame, 0, -16) animated:YES];
}

- (void)miniLayout:(NSNotification *)n {
	_miniH = [n.userInfo[ENMiniPlayerHeightKey] floatValue];
	[self applyInsets];
}

// the bottom stays clear of the mini player (and of the keyboard while it is up)
- (void)applyInsets {
	UIEdgeInsets in = UIEdgeInsetsMake(0, 0, MAX(_kbH, _miniH), 0);
	_scroll.contentInset = in;
	_scroll.scrollIndicatorInsets = in;
}

- (void)tapMemoryWarning {
	ENLog(@"memory warning test: %.1f MB resident before", [ENDiag residentMB]);
	[[NSNotificationCenter defaultCenter] postNotificationName:UIApplicationDidReceiveMemoryWarningNotification object:[UIApplication sharedApplication]];
	[self performSelector:@selector(logMemoryAfter) withObject:nil afterDelay:1.0];
}

- (void)logMemoryAfter {
	ENLog(@"memory warning test: %.1f MB resident after", [ENDiag residentMB]);
	[ENDiag flushSoon];
}

- (void)tapUnpair {
	if (_unpairAlert) return;
	_unpairAlert = [[ENAlertView alloc] initWithTitle:ENL(@"Unpair this iPhone?") message:ENL(@"You'll need a new pairing code from your Encore Bridge's admin page to connect again.")
	                                         delegate:self cancelButtonTitle:ENL(@"Cancel") otherButtonTitles:ENL(@"Unpair"), nil];
	[_unpairAlert show];
}

// didDismiss, not clickedButton: it is the alert's last delegate call (UIAlertView.delegate is assign on iOS 6). showSetup
// swaps the window's root, which frees the tab controller and this screen with it, so it comes last and nothing touches
// self after it; the timer and the observers go first so nothing keeps the old screen alive or calls into it.
- (void)alertView:(UIAlertView *)a didDismissWithButtonIndex:(NSInteger)i {
	a.delegate = nil;
	if (a == _unpairAlert) _unpairAlert = nil;
	if (i != 1) return;
	[self stopUpdates];
	if ([ENPlayback shared].playing) [[ENPlayback shared] pause];
	[[ENGateway shared] unpair];
	[(ENAppDelegate *)[UIApplication sharedApplication].delegate showSetup];
}

@end

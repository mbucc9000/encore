#import "ENLyricsView.h"
#import "ENLyrics.h"
#import "ENModel.h"
#import "ENPlayback.h"
#import "ENAppDelegate.h"

static const CGFloat ENLyricPad = 20;            // left / right of the lines
static const CGFloat ENLyricGap = 8;             // above and below each line's text
static const CGFloat ENLyricBlank = 14;          // a plain "" line (a stanza break): just space
static const CGFloat ENLyricSpot = 0.35f;        // the reading spot: the current line's middle, from the top
static const NSInteger ENLyricLabelTag = 1;
static const NSTimeInterval ENLyricTick = 0.25, ENLyricResume = 3, ENLyricSeekHold = 1;

typedef enum { ENLyricsViewEmpty = 0, ENLyricsViewLoading, ENLyricsViewShown, ENLyricsViewError } ENLyricsViewState;

static UIFont *ENLyricFont(void) {
	static UIFont *f;
	if (!f) f = [UIFont fontWithName:@"HelveticaNeue-Bold" size:20] ?: [UIFont boldSystemFontOfSize:20];
	return f;
}

static UILabel *ENLyricNote(CGRect f, NSString *text, UIFont *font, CGFloat alpha) {
	UILabel *l = [[UILabel alloc] initWithFrame:f];
	l.font = font;
	l.textColor = [UIColor colorWithWhite:1 alpha:alpha];
	l.backgroundColor = [UIColor clearColor];
	l.text = text;
	return l;
}

@interface ENLyricsView () <UITableViewDataSource, UITableViewDelegate>
@end

@implementation ENLyricsView {
	UIImageView *_cover;
	UITableView *_table;
	UILabel *_message;
	UIActivityIndicatorView *_spin;
	UITapGestureRecognizer *_retryTap;
	ENLyricsViewState _state;
	BOOL _shown;                         // showTrack: was called (a nil track counts: the same nil again = nothing)
	ENTrack *_track;
	NSString *_uri;
	NSUInteger _gen;                     // the load in flight; an older answer is dropped
	ENLyrics *_lyrics;
	BOOL _synced;
	NSArray *_texts, *_heights;          // per row: what it shows (♪ for a gap) and its height (text + 2 gaps)
	CGFloat _heightsWidth;               // the width they were measured at
	NSInteger _current;                  // the highlighted line, -1 = none (before the first, or not synced)
	BOOL _active, _userScroll;           // _userScroll: a drag paused the following
	NSTimer *_timer, *_resume;
	CFAbsoluteTime _seekHold;            // after a tapped line: keep it lit until the position agrees (or this passes)
}

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		UIViewAutoresizing fill = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
		self.backgroundColor = ENColor(0x0f1a0c);
		self.clipsToBounds = YES;
		_current = -1;

		_cover = [[UIImageView alloc] initWithFrame:self.bounds];
		_cover.contentMode = UIViewContentModeScaleAspectFill;
		_cover.clipsToBounds = YES;
		_cover.autoresizingMask = fill;
		[self addSubview:_cover];
		UIView *shade = [[UIView alloc] initWithFrame:self.bounds];
		shade.backgroundColor = [ENColor(0x0f1a0c) colorWithAlphaComponent:0.8f];
		shade.userInteractionEnabled = NO;
		shade.autoresizingMask = fill;
		[self addSubview:shade];

		_table = [[UITableView alloc] initWithFrame:self.bounds style:UITableViewStylePlain];
		_table.autoresizingMask = fill;
		_table.backgroundColor = [UIColor clearColor];
		_table.backgroundView = nil;
		_table.separatorStyle = UITableViewCellSeparatorStyleNone;
		_table.showsVerticalScrollIndicator = NO;
		_table.scrollsToTop = NO;
		_table.dataSource = self;
		_table.delegate = self;
		_table.hidden = YES;
		CGFloat inset = roundf(frame.size.height * 0.4f);
		_table.contentInset = UIEdgeInsetsMake(inset, 0, inset, 0);
		[self addSubview:_table];

		_message = [[UILabel alloc] initWithFrame:CGRectZero];
		_message.font = [UIFont fontWithName:@"HelveticaNeue-Bold" size:17] ?: [UIFont boldSystemFontOfSize:17];
		_message.textColor = [UIColor colorWithWhite:1 alpha:0.75f];
		_message.backgroundColor = [UIColor clearColor];
		_message.textAlignment = NSTextAlignmentCenter;
		_message.numberOfLines = 0;
		_message.hidden = YES;
		[self addSubview:_message];
		_spin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleWhiteLarge];
		_spin.hidesWhenStopped = YES;
		_spin.userInteractionEnabled = NO;
		[self addSubview:_spin];

		_retryTap = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(retry)];
		_retryTap.enabled = NO;
		[self addGestureRecognizer:_retryTap];
	}
	return self;
}

- (void)dealloc {
	_table.delegate = nil;               // (assign on iOS 6: a deceleration still running would call back into a freed view)
	_table.dataSource = nil;
	[_timer invalidate];
	[_resume invalidate];
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGSize s = self.bounds.size;
	CGFloat inset = roundf(s.height * 0.4f);       // 40 % above and below: the first and last lines reach the reading spot
	BOOL moved = _table.contentInset.top != inset;
	if (moved) _table.contentInset = UIEdgeInsetsMake(inset, 0, inset, 0);
	_message.frame = CGRectMake(ENLyricPad, 0, s.width - 2 * ENLyricPad, s.height);
	_spin.center = CGPointMake(roundf(s.width / 2), roundf(s.height / 2));
	if (_texts.count && s.width != _heightsWidth) {
		[self measure];
		_table.tableFooterView = [self footer];
		[_table reloadData];
		[_table layoutIfNeeded];
		moved = YES;
	}
	if (moved && _texts.count) [self follow:NO];
}

// Only a spinner or a message (or nothing) on screen: touches go to the view below (Now Playing's art). The error state
// keeps them for its retry tap; the lines' table covers the whole frame when it shows.
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
	UIView *v = [super hitTest:point withEvent:event];
	return (v == self && _state != ENLyricsViewError) ? nil : v;
}

#pragma mark - public

- (void)setArtwork:(UIImage *)artwork {
	if (artwork == _artwork) return;
	_artwork = artwork;
	UIImageView *iv = _cover;
	if (_active) [UIView transitionWithView:iv duration:0.25 options:UIViewAnimationOptionTransitionCrossDissolve
	                             animations:^{ iv.image = artwork; } completion:nil];
	else iv.image = artwork;
}

- (void)showTrack:(ENTrack *)track {
	NSString *uri = track.uri;
	if (_shown && (uri == _uri || [uri isEqualToString:_uri])) return;     // the same song again
	_shown = YES;
	_track = track;
	_uri = [uri copy];
	[self load:NO];
}

- (void)setActive:(BOOL)active {
	if (active == _active) return;
	_active = active;
	if (active) {
		_timer = [NSTimer timerWithTimeInterval:ENLyricTick target:self selector:@selector(tick) userInfo:nil repeats:YES];
		[[NSRunLoop mainRunLoop] addTimer:_timer forMode:NSRunLoopCommonModes];
		if (_synced) {                   // back on screen: straight to where the song is, no animation
			[_resume invalidate];
			_resume = nil;
			_userScroll = NO;
			_seekHold = 0;
			_current = [_lyrics lineIndexAtMs:[ENPlayback shared].positionMs];
			for (NSIndexPath *ip in [_table indexPathsForVisibleRows]) [self restyleRow:ip.row animated:NO];
			[self follow:NO];
		}
	} else {
		[_timer invalidate];
		_timer = nil;
		[_resume invalidate];
		_resume = nil;
	}
}

#pragma mark - loading

- (void)load:(BOOL)fresh {
	NSUInteger gen = ++_gen;
	[self takeLyrics:nil];
	if (!_track) {
		[self setState:ENLyricsViewEmpty message:nil];
		return;
	}
	if (!_track.name.length || !_track.artistName.length) {     // nothing to look it up by (the gateway would answer 400)
		[self setState:ENLyricsViewShown message:@"No lyrics for this song"];
		return;
	}
	[self setState:ENLyricsViewLoading message:nil];
	__weak ENLyricsView *w = self;
	[ENLyrics loadForTrack:_track fresh:fresh done:^(ENLyrics *lyrics, NSError *error) {
		ENLyricsView *s = w;
		if (!s || gen != s->_gen) return;
		if (!lyrics) {
			[s setState:ENLyricsViewError message:@"Couldn't load lyrics.\nTap to try again."];
			return;
		}
		[s takeLyrics:lyrics];
		NSString *msg = nil;
		if (!s->_texts.count) msg = lyrics.kind == ENLyricsInstrumental ? @"♪  Instrumental" : @"No lyrics for this song";
		[s setState:ENLyricsViewShown message:msg];
		[s follow:NO];
	}];
}

- (void)retry {
	if (_state == ENLyricsViewError) [self load:YES];
}

- (void)setState:(ENLyricsViewState)state message:(NSString *)msg {
	_state = state;
	_table.hidden = !(state == ENLyricsViewShown && _texts.count);
	_message.text = msg;
	_message.hidden = !msg;
	if (state == ENLyricsViewLoading) [_spin startAnimating];
	else [_spin stopAnimating];
	_retryTap.enabled = state == ENLyricsViewError;
}

// lyrics nil = clear. Synced / plain with lines fill the table; instrumental / none (or no lines) leave it empty.
- (void)takeLyrics:(ENLyrics *)lyrics {
	[_resume invalidate];
	_resume = nil;
	_userScroll = NO;
	_seekHold = 0;
	_lyrics = lyrics;
	BOOL any = NO;                               // a line with words (only gaps / empty lines = "No lyrics for this song")
	if (lyrics.kind == ENLyricsSynced || lyrics.kind == ENLyricsPlain)
		for (ENLyricLine *line in lyrics.lines) if (line.text.length) { any = YES; break; }
	_synced = any && lyrics.kind == ENLyricsSynced;
	NSMutableArray *texts = nil;
	if (any) {
		texts = [NSMutableArray arrayWithCapacity:lyrics.lines.count];
		for (ENLyricLine *line in lyrics.lines) {
			NSString *t = line.text ?: @"";
			[texts addObject:(_synced && !t.length) ? @"♪" : t];
		}
	}
	_texts = texts;
	_current = _synced ? [lyrics lineIndexAtMs:[ENPlayback shared].positionMs] : -1;
	[self measure];
	_table.tableFooterView = _texts ? [self footer] : nil;
	[_table reloadData];
	if (_texts) [_table layoutIfNeeded];
}

// row heights: sizeWithFont:constrainedToSize: at the width - 40, plus the gaps
- (void)measure {
	_heightsWidth = self.bounds.size.width;
	CGSize box = CGSizeMake(_heightsWidth - 2 * ENLyricPad, 10000);
	UIFont *f = ENLyricFont();
	NSMutableArray *h = [NSMutableArray arrayWithCapacity:_texts.count];
	for (NSString *t in _texts) {
		CGFloat th = t.length ? ceilf([t sizeWithFont:f constrainedToSize:box].height) + 2 * ENLyricGap : ENLyricBlank;
		[h addObject:@(th)];
	}
	_heights = h;
}

// under the lines: "These lyrics aren't synced" (plain) and "Lyrics from LRCLIB"
- (UIView *)footer {
	CGFloat w = self.bounds.size.width, y = 14;
	BOOL plain = !_synced;
	UIView *v = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, plain ? 52 : 36)];
	v.backgroundColor = [UIColor clearColor];
	UIFont *f = [UIFont fontWithName:@"HelveticaNeue" size:11] ?: [UIFont systemFontOfSize:11];
	if (plain) {
		UIFont *b = [UIFont fontWithName:@"HelveticaNeue-Bold" size:11] ?: [UIFont boldSystemFontOfSize:11];
		[v addSubview:ENLyricNote(CGRectMake(ENLyricPad, y, w - 2 * ENLyricPad, 14), @"These lyrics aren't synced", b, 0.55f)];
		y += 16;
	}
	NSString *src = [NSString stringWithFormat:@"Lyrics from %@", _lyrics.source ?: @"LRCLIB"];
	[v addSubview:ENLyricNote(CGRectMake(ENLyricPad, y, w - 2 * ENLyricPad, 14), src, f, 0.4f)];
	return v;
}

#pragma mark - following the song

- (void)tick {
	if (_userScroll && !_resume && !_table.tracking && !_table.dragging && !_table.decelerating) [self resumeLater];   // a
	                                                                     // touch that stopped a deceleration ends no drag
	if (!_synced) return;
	NSInteger i = [_lyrics lineIndexAtMs:[ENPlayback shared].positionMs];
	if (i != _current && CFAbsoluteTimeGetCurrent() < _seekHold) return;    // the seek hasn't reached the position yet
	_seekHold = 0;
	[self setCurrent:i animated:YES];
}

- (void)setCurrent:(NSInteger)i animated:(BOOL)animated {
	if (i == _current) return;
	NSInteger old = _current;
	_current = i;
	[self restyleRow:old animated:animated];
	[self restyleRow:i animated:animated];
	[self follow:animated];
}

- (CGFloat)alphaOfRow:(NSInteger)r {
	if (!_synced) return 0.85f;
	return r == _current ? 1 : 0.45f;
}

// one row's highlight, only if it is on screen (cellForRow styles the others when they scroll in)
- (void)restyleRow:(NSInteger)r animated:(BOOL)animated {
	if (r < 0 || r >= (NSInteger)_texts.count) return;
	UITableViewCell *cell = [_table cellForRowAtIndexPath:[NSIndexPath indexPathForRow:r inSection:0]];
	UILabel *l = (UILabel *)[cell.contentView viewWithTag:ENLyricLabelTag];
	if (!l) return;
	CGFloat a = [self alphaOfRow:r];
	if (animated) [UIView animateWithDuration:0.25 delay:0 options:UIViewAnimationOptionAllowUserInteraction | UIViewAnimationOptionBeginFromCurrentState
	                               animations:^{ l.alpha = a; } completion:nil];
	else l.alpha = a;
}

// The current line's middle at the reading spot (the first line's before the song reaches it, and for plain lyrics),
// clamped to what the insets allow. Animated = UIKit's scroll (about 0.3 s; it keeps the passing rows on screen).
- (void)follow:(BOOL)animated {
	if (_table.hidden || !_texts.count || _userScroll) return;
	NSInteger r = MIN(MAX(_current, 0), (NSInteger)_texts.count - 1);
	CGFloat H = _table.bounds.size.height;
	UIEdgeInsets in = _table.contentInset;
	CGRect rr = [_table rectForRowAtIndexPath:[NSIndexPath indexPathForRow:r inSection:0]];
	CGFloat y = roundf(CGRectGetMidY(rr) - H * ENLyricSpot);
	y = MAX(-in.top, MIN(y, MAX(-in.top, _table.contentSize.height + in.bottom - H)));
	if (fabsf(_table.contentOffset.y - y) < 1) return;
	[_table setContentOffset:CGPointMake(0, y) animated:animated];
}

- (void)resumeLater {
	[_resume invalidate];
	_resume = [NSTimer timerWithTimeInterval:ENLyricResume target:self selector:@selector(resumeFollowing) userInfo:nil repeats:NO];
	[[NSRunLoop mainRunLoop] addTimer:_resume forMode:NSRunLoopCommonModes];
}

- (void)resumeFollowing {
	_resume = nil;
	_userScroll = NO;
	if (_synced) [self follow:YES];
}

#pragma mark - UIScrollViewDelegate (a drag pauses the following until 3 s after it ends)

- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView {
	_userScroll = YES;
	[_resume invalidate];
	_resume = nil;
}

- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView willDecelerate:(BOOL)decelerate {
	if (!decelerate) [self resumeLater];
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView {
	[self resumeLater];
}

#pragma mark - UITableView

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return _texts.count;
}

- (CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)indexPath {
	return [_heights[indexPath.row] floatValue];
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
	static NSString *const kLine = @"line";
	UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:kLine];
	UILabel *l;
	if (!cell) {
		cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:kLine];
		cell.selectionStyle = UITableViewCellSelectionStyleNone;
		l = [[UILabel alloc] initWithFrame:CGRectZero];
		l.tag = ENLyricLabelTag;
		l.font = ENLyricFont();
		l.textColor = [UIColor whiteColor];
		l.backgroundColor = [UIColor clearColor];
		l.numberOfLines = 0;
		l.lineBreakMode = NSLineBreakByWordWrapping;
		[cell.contentView addSubview:l];
	} else {
		l = (UILabel *)[cell.contentView viewWithTag:ENLyricLabelTag];
	}
	NSInteger r = indexPath.row;
	NSString *t = _texts[r];
	CGFloat h = [_heights[r] floatValue];
	l.text = t;
	l.frame = t.length ? CGRectMake(ENLyricPad, ENLyricGap, tableView.bounds.size.width - 2 * ENLyricPad, h - 2 * ENLyricGap) : CGRectZero;
	l.alpha = [self alphaOfRow:r];
	return cell;
}

- (void)tableView:(UITableView *)tableView willDisplayCell:(UITableViewCell *)cell forRowAtIndexPath:(NSIndexPath *)indexPath {
	cell.backgroundColor = [UIColor clearColor];          // (iOS 6 resets a plain cell's colour before this)
	cell.contentView.backgroundColor = [UIColor clearColor];
}

- (NSIndexPath *)tableView:(UITableView *)tableView willSelectRowAtIndexPath:(NSIndexPath *)indexPath {
	return _synced ? indexPath : nil;
}

// a synced line: seek to it (when canSeek allows) and light it at once
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
	[tableView deselectRowAtIndexPath:indexPath animated:NO];
	NSInteger r = indexPath.row;
	if (!_synced || r >= (NSInteger)_lyrics.lines.count) return;
	if (self.canSeek && !self.canSeek()) return;
	ENLyricLine *line = _lyrics.lines[r];
	if (line.timeMs < 0) return;
	[[ENPlayback shared] seekTo:line.timeMs];
	[_resume invalidate];
	_resume = nil;
	_userScroll = NO;
	_seekHold = CFAbsoluteTimeGetCurrent() + ENLyricSeekHold;
	if (r == _current) [self follow:YES];        // (it may have been dragged away)
	else [self setCurrent:r animated:YES];
}

@end

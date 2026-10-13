#import "ENJamViewController.h"
#import "ENL.h"
#import <MessageUI/MessageUI.h>
#import "ENJam.h"
#import "ENJamActions.h"
#import "ENAvatarView.h"
#import "ENQueueViewController.h"
#import "ENQueueEditor.h"
#import "ENSearchViewController.h"
#import "ENNowPlayingViewController.h"
#import "ENTabBarController.h"
#import "ENPlayback.h"
#import "ENCatalog.h"
#import "ENImageCache.h"
#import "ENTheme.h"
#import "ENCompat.h"
#import "ENModel.h"
#import "ENAppDelegate.h"
#import "ENDiag.h"
#import "ENGateway.h"
#import "ENProfileViewController.h"
#import "ENAnon.h"
#import <QuartzCore/QuartzCore.h>

typedef enum { ENJamOff = 0, ENJamOffNoSC, ENJamHost, ENJamGuest, ENJamLim, ENJamAway, ENJamWait } ENJamScreenState;
// (R2a) ENJamRowShowInvite: "Show Invite", the invite section's one row while Anonymous Mode hides the link, QR and Code
typedef enum { ENJamRowCode = 0, ENJamRowLink, ENJamRowShare, ENJamRowMember, ENJamRowGuestControl, ENJamRowEnd, ENJamRowLeave, ENJamRowQR,
	ENJamRowNow, ENJamRowSong, ENJamRowAdd, ENJamRowShowInvite, ENJamRowNone } ENJamRowKind;
// (0.9.3) the song sections (their rows are `tracks`, plus "Add songs" at the end of Up next) and all the others (`rows`)
typedef enum { ENJamSecOther = 0, ENJamSecNow, ENJamSecQueue, ENJamSecContext } ENJamSecKind;

static const CGFloat ENJamHeroAvatar = 40, ENJamHeroOverlap = 9, ENJamHeroIcon = 76;
static const NSUInteger ENJamHeroMaxAvatars = 7;
static const CGFloat ENJamSongHeight = 56;           // a song row: the 44 pt cover with 6 pt above and below
static const NSTimeInterval ENJamDropWait = 3;       // (as Up Next) a rollback waits this long at most for a dragged row's drop
static const NSTimeInterval ENJamNoteTime = 8;       // an edit failure's footer note goes after this long

// (1.0, C5) every colour and font is an ENTheme token (DESIGN-5 P2): the grouped ones for the rows, headers and footers,
// the jamHero… ones for the hero, and +fontOfSize:bold: for the few sizes no token names (the hero's 22 / 13.5 / 14, the
// song rows' 16 / 13, as before)

// (0.9.3) the states that show the Jam's songs (Now playing, Up next, Next from) once Up Next has answered: B, C, L, Away
static BOOL ENJamShowsSongs(ENJamScreenState st) {
	return st == ENJamHost || st == ENJamGuest || st == ENJamLim || st == ENJamAway;
}

#pragma mark - sections and cells

@interface ENJamSection : NSObject
@property (nonatomic, copy) NSString *header, *footer;
@property (nonatomic, strong) NSMutableArray *rows;        // NSNumber ENJamRowKind (member rows: the row index is the member's)
// (0.9.3) a song section: its songs (ENTrack; an edit replaces the array, nothing is changed in place) and, for Up next,
// the "Add songs" row after them
@property (nonatomic) ENJamSecKind kind;
@property (nonatomic, copy) NSArray *tracks;
@property (nonatomic) BOOL addRow;
@property (nonatomic, readonly) NSUInteger rowCount;
@end

@implementation ENJamSection
- (id)init { if ((self = [super init])) _rows = [NSMutableArray array]; return self; }
- (NSUInteger)rowCount { return _kind == ENJamSecOther ? _rows.count : _tracks.count + (_addRow ? 1 : 0); }
@end

// The screen's one text row: an optional 30 pt avatar (or a 30 pt icon box: "Add songs"), a title over an optional small
// line, an optional right-hand value (middle-truncated: the Link row), or a centred title (End Jam / Leave Jam). The
// accessoryView holds a switch or a button.
// (1.0, C5) The grouped kit's look (mockup .g-cell, as ENGroupedCell): the title Bold 16.5 in groupedLabel over the small
// line 12.5 in groupedSmall, the value 16 in groupedValue (was #52657f); on the green selection the text turns white
// (cellSelectedTitle / cellSelectedSub) and the icon shows its `highlightedImage`. Colours are read when the row is set up
// (the controller's -cellForRow…: -resetColors), not only at init.
@interface ENJamCell : UITableViewCell
@property (nonatomic, readonly) ENAvatarView *avatar;
@property (nonatomic, readonly) UIImageView *icon;
@property (nonatomic, readonly) UILabel *title, *small, *value;
@property (nonatomic) BOOL centered;
- (void)resetColors;     // the default colours from [ENTheme current] (a row then sets its own title colour)
@end

@implementation ENJamCell

- (id)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)rid {
	if ((self = [super initWithStyle:UITableViewCellStyleDefault reuseIdentifier:rid])) {
		ENTheme *th = [ENTheme current];
		_avatar = [[ENAvatarView alloc] initWithFrame:CGRectMake(10, 11, 30, 30)];
		_avatar.hidden = YES;
		[self.contentView addSubview:_avatar];
		_icon = [[UIImageView alloc] initWithFrame:CGRectZero];
		_icon.contentMode = UIViewContentModeCenter;
		_icon.hidden = YES;
		[self.contentView addSubview:_icon];
		_title = [self label:th.groupedLabelFont];
		_small = [self label:th.groupedSmallFont];
		_value = [self label:th.groupedValueFont];
		_value.textAlignment = NSTextAlignmentRight;
		_value.lineBreakMode = NSLineBreakByTruncatingMiddle;
		[self resetColors];
	}
	return self;
}

- (UILabel *)label:(UIFont *)f {
	UILabel *l = [[UILabel alloc] initWithFrame:CGRectZero];
	l.font = f;
	l.backgroundColor = [UIColor clearColor];
	[self.contentView addSubview:l];
	return l;
}

- (void)resetColors {
	ENTheme *th = [ENTheme current];
	_title.textColor = th.groupedLabel;
	_title.highlightedTextColor = th.cellSelectedTitle;
	_small.textColor = th.groupedSmall;
	_small.highlightedTextColor = th.cellSelectedSub;
	_value.textColor = th.groupedValue;
	_value.highlightedTextColor = th.cellSelectedTitle;
}

- (void)prepareForReuse {
	[super prepareForReuse];
	_avatar.hidden = YES;
	_avatar.member = nil;
	_icon.hidden = YES;
	_icon.image = _icon.highlightedImage = nil;
	_title.text = _small.text = _value.text = nil;
	[self resetColors];
	_centered = NO;
	self.accessoryView = nil;
	self.selectionStyle = UITableViewCellSelectionStyleNone;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGRect b = self.contentView.bounds;
	CGFloat h = b.size.height, x = 10, right = b.size.width - 10;
	CGFloat titleH = ceilf(_title.font.lineHeight), valueH = ceilf(_value.font.lineHeight);
	if (!_avatar.hidden) {
		_avatar.frame = CGRectMake(10, floorf((h - 30) / 2), 30, 30);
		x = 50;
	} else if (!_icon.hidden) {
		_icon.frame = CGRectMake(10, floorf((h - 30) / 2), 30, 30);
		x = 50;
	}
	if (_centered) {
		_title.textAlignment = NSTextAlignmentCenter;
		_title.frame = CGRectMake(10, floorf((h - titleH) / 2), b.size.width - 20, titleH);
		_value.frame = _small.frame = CGRectZero;
		return;
	}
	_title.textAlignment = NSTextAlignmentLeft;
	CGFloat tw = ceilf([_title.text ?: @"" sizeWithFont:_title.font].width);
	if (_value.text.length) {          // as wide as its text, at most what the title leaves (the Link row truncates in the middle)
		CGFloat vw = MIN(ceilf([_value.text sizeWithFont:_value.font].width), MAX(right - x - tw - 12, 40));
		_value.frame = CGRectMake(right - vw, floorf((h - valueH) / 2), vw, valueH);
		right -= vw + 6;
	} else {
		_value.frame = CGRectZero;
	}
	BOOL two = _small.text.length > 0;
	CGFloat sh = two ? ceilf([_small.text sizeWithFont:_small.font constrainedToSize:CGSizeMake(right - x, 40)
	                                        lineBreakMode:NSLineBreakByWordWrapping].height) : 0;
	_small.numberOfLines = 2;
	CGFloat top = floorf((h - titleH - sh) / 2);
	_title.frame = CGRectMake(x, top, MAX(right - x, 10), titleH);
	_small.frame = two ? CGRectMake(x, top + titleH, MAX(right - x, 10), sh) : CGRectZero;
}

@end

// (0.9.3) A song of Now playing / Up next / Next from: this screen's grouped (white, rounded) row with ENListCell's parts:
// the 44 pt cover in its 1 pt dark border (88 tier from ENImageCache, the placeholder until it comes), the title over
// "<artists>" ("<artists> · added by <name | you>" with `by`, as Up Next), and at the right the 22 pt avatar of who added
// it (ENAvatarView), then the speaker while playing. Playing: the green title on a light green fill (the playing row's
// look); muted (Next from): grey text and a faded cover; x / un rows: "Loading…" / "Unavailable song", dimmed. Editing:
// UIKit narrows the content view (the delete and reorder controls) and the layout follows it.
// (1.0, C5) Tokens: groupedCard / jamPlayingFill, jamMutedTitle / jamMutedSub, the cover box in thumbBorder; on the green
// selection (Now playing) the text turns white (cellSelectedTitle / cellSelectedSub).
@interface ENJamSongCell : UITableViewCell
@property (nonatomic, readonly) UIColor *fill;     // the grouped row's fill: groupedCard, or the light green playing one
                                                   // (applied in -tableView:willDisplayCell:..., where UIKit takes a cell's colour)
- (void)showTrack:(ENTrack *)t by:(ENJamMember *)m playing:(BOOL)playing muted:(BOOL)muted;
@end

@implementation ENJamSongCell {
	UIView *_box;              // the cover's border (ENListCell's black .18 box)
	UIImageView *_art;
	UILabel *_title, *_sub;
	ENAvatarView *_by;
	UIImageView *_speaker;
	NSString *_artToken;       // the cover shown or loading
	NSString *_artKey;         // its outstanding ENImageCache load (nil = none): one cancel: balances it
	BOOL _artLoaded;           // _art shows _artToken's image (not the placeholder)
}

- (id)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)rid {
	if ((self = [super initWithStyle:UITableViewCellStyleDefault reuseIdentifier:rid])) {
		ENTheme *th = [ENTheme current];
		self.selectionStyle = UITableViewCellSelectionStyleNone;
		_fill = th.groupedCard;
		UIView *cv = self.contentView;
		_box = [[UIView alloc] initWithFrame:CGRectMake(6, 6, 44, 44)];
		_box.backgroundColor = th.thumbBorder;
		_box.userInteractionEnabled = NO;
		[cv addSubview:_box];
		_art = [[UIImageView alloc] initWithFrame:CGRectMake(1, 1, 42, 42)];
		_art.contentMode = UIViewContentModeScaleAspectFill;
		_art.clipsToBounds = YES;
		[_box addSubview:_art];
		_title = [self label:[ENTheme fontOfSize:16 bold:YES]];
		_sub = [self label:[ENTheme fontOfSize:13 bold:NO]];
		_by = [[ENAvatarView alloc] initWithFrame:CGRectMake(0, 0, 22, 22)];
		_by.hidden = YES;
		_by.userInteractionEnabled = NO;
		[cv addSubview:_by];
		_speaker = [[UIImageView alloc] initWithImage:th.speakerGlyph];
		_speaker.hidden = YES;
		[cv addSubview:_speaker];
	}
	return self;
}

- (UILabel *)label:(UIFont *)f {
	UILabel *l = [[UILabel alloc] initWithFrame:CGRectZero];
	l.font = f;
	l.backgroundColor = [UIColor clearColor];
	[self.contentView addSubview:l];
	return l;
}

- (void)dealloc {
	[self stopArt];
}

- (void)stopArt {
	if (!_artKey) return;
	[[ENImageCache shared] cancel:_artKey];
	_artKey = nil;
}

- (void)prepareForReuse {
	[super prepareForReuse];
	self.accessoryType = UITableViewCellAccessoryNone;
	self.accessoryView = nil;
	self.selectionStyle = UITableViewCellSelectionStyleNone;
	_by.member = nil;
	_by.hidden = YES;
	_speaker.hidden = YES;
}

// the 88-tier cover: the memory copy at once, else the placeholder and a load that only lands while this cell still waits
// for that key (ENListCell's rule)
- (void)setArtToken:(NSString *)token {
	BOOL same = token == _artToken || [token isEqualToString:_artToken];
	if (same && (_artKey || _artLoaded)) return;
	[self stopArt];
	_artToken = [token copy];
	ENImageCache *cache = [ENImageCache shared];
	UIImage *mem = token ? [cache memoryImage:token size:ENImg88 round:NO] : nil;
	_artLoaded = mem != nil;
	_art.image = mem ?: [ENTheme current].placeholderCover;
	if (!token || mem) return;
	__weak ENJamSongCell *w = self;
	_artKey = [[cache load:token size:ENImg88 round:NO done:^(UIImage *img, NSString *key) {
		ENJamSongCell *s = w;
		if (!s || !s->_artKey || ![s->_artKey isEqualToString:key]) return;
		s->_artKey = nil;                      // finished: nothing left to cancel
		if (!img) return;
		s->_art.image = img;
		s->_artLoaded = YES;
	}] copy];
}

- (void)showTrack:(ENTrack *)t by:(ENJamMember *)m playing:(BOOL)playing muted:(BOOL)muted {
	ENTheme *th = [ENTheme current];
	BOOL ok = t.playable;
	playing = playing && ok;
	if (t.loading) _title.text = ENL(@"Loading…");
	else if (t.unavailable) _title.text = ENL(@"Unavailable song");
	else _title.text = t.name ?: @"";
	NSString *sub = ok ? t.subline : nil;
	if (ok && m) {
		NSString *who = m.isMe ? ENL(@"you") : m.name;
		sub = sub.length ? [NSString stringWithFormat:ENL(@"%@ · added by %@"), sub, who] : [NSString stringWithFormat:ENL(@"added by %@"), who];
	}
	_sub.text = sub;
	_title.textColor = !ok ? th.cellDimmed : playing ? th.cellPlaying : muted ? th.jamMutedTitle : th.cellTitle;
	_sub.textColor = !ok ? th.cellDimmed : muted ? th.jamMutedSub : th.cellSub;
	_title.highlightedTextColor = th.cellSelectedTitle;
	_sub.highlightedTextColor = th.cellSelectedSub;
	_box.backgroundColor = th.thumbBorder;
	_box.alpha = muted || !ok ? 0.7f : 1;
	_by.member = ok ? m : nil;
	_by.hidden = !(ok && m);
	_speaker.image = th.speakerGlyph;
	_speaker.hidden = !playing;
	_fill = playing ? th.jamPlayingFill : th.groupedCard;
	self.backgroundColor = _fill;
	[self setArtToken:(t.loading ? nil : t.image)];
	[self setNeedsLayout];
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGRect b = self.contentView.bounds;
	CGFloat h = b.size.height, x = 6 + 44 + 10, right = b.size.width - 8;
	_box.frame = CGRectMake(6, floorf((h - 44) / 2), 44, 44);
	if (!_by.hidden) {
		_by.frame = CGRectMake(right - 22, floorf((h - 22) / 2), 22, 22);
		right -= 22 + 8;
	}
	if (!_speaker.hidden) {
		CGSize s = _speaker.image.size;
		_speaker.frame = CGRectMake(right - s.width, floorf((h - s.height) / 2), s.width, s.height);
		right -= s.width + 6;
	}
	CGFloat w = MAX(right - x, 10), th = ceilf(_title.font.lineHeight), sh = ceilf(_sub.font.lineHeight);
	BOOL two = _sub.text.length > 0;
	CGFloat top = floorf((h - th - (two ? sh : 0)) / 2);
	_title.frame = CGRectMake(x, top, w, th);
	_sub.frame = two ? CGRectMake(x, top + th, w, sh) : CGRectZero;
}

@end

// The Spotify Code (280 x 70 pt from the 640 tier) and its note.
@interface ENJamCodeCell : UITableViewCell
@property (nonatomic, readonly) UIImageView *code;
@end

@implementation ENJamCodeCell {
	UILabel *_note;
}

- (id)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)rid {
	if ((self = [super initWithStyle:UITableViewCellStyleDefault reuseIdentifier:rid])) {
		self.selectionStyle = UITableViewCellSelectionStyleNone;
		_code = [[UIImageView alloc] initWithFrame:CGRectMake(0, 10, 280, 70)];
		_code.contentMode = UIViewContentModeScaleAspectFit;
		[self.contentView addSubview:_code];
		_note = [[UILabel alloc] initWithFrame:CGRectZero];
		_note.font = [ENTheme current].groupedSmallFont;
		_note.textColor = [ENTheme current].groupedNote;
		_note.backgroundColor = [UIColor clearColor];
		_note.textAlignment = NSTextAlignmentCenter;
		_note.text = ENL(@"Friends scan this with the Spotify app camera");
		[self.contentView addSubview:_note];
	}
	return self;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGRect b = self.contentView.bounds;
	_code.frame = CGRectMake(floorf((b.size.width - 280) / 2), 10, 280, 70);
	_note.frame = CGRectMake(8, 84, b.size.width - 16, 18);
}

@end

// Message + Copy Link, two silver buttons side by side (1.0: the C7 kit's 34 pt silver gbtn with its 16 pt glyph, as the
// mockup's Jam sheet).
@interface ENJamShareCell : UITableViewCell
@property (nonatomic, readonly) UIButton *message, *linkButton;
@end

@implementation ENJamShareCell

- (UIButton *)silver:(NSString *)title glyph:(NSString *)glyph {
	UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
	b.frame = CGRectMake(0, 0, 140, 34);         // the kit sizes the images and font by this height (laid out below)
	[ENTheme configureButton:b style:ENButtonStyleSilver title:title glyph:glyph];
	[self.contentView addSubview:b];
	return b;
}

- (id)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)rid {
	if ((self = [super initWithStyle:UITableViewCellStyleDefault reuseIdentifier:rid])) {
		self.selectionStyle = UITableViewCellSelectionStyleNone;
		_message = [self silver:ENL(@"Message") glyph:@"message"];
		_linkButton = [self silver:ENL(@"Copy Link") glyph:@"link"];
	}
	return self;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGRect b = self.contentView.bounds;
	CGFloat w = floorf((b.size.width - 30) / 2), y = floorf((b.size.height - 34) / 2);
	_message.frame = CGRectMake(10, y, w, 34);
	_linkButton.frame = CGRectMake(20 + w, y, b.size.width - 30 - w, 34);
}

@end

#pragma mark - the screen

// The join QR code (made by the gateway from the Jam's link): any phone camera opens the link.
// (1.0, C5) The card is white in every palette (it must stay scannable, DESIGN-5 §1.4 "QR card": the Light palette's
// groupedCard) inside the qrBorder line (grey .82 in Light; the dark border once Dark mode exists).
@interface ENJamQRCell : UITableViewCell
@property (nonatomic, readonly) UIImageView *qr;
@end

@implementation ENJamQRCell {
	UIView *_card;
	UILabel *_note;
}

- (id)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)rid {
	if ((self = [super initWithStyle:UITableViewCellStyleDefault reuseIdentifier:rid])) {
		self.selectionStyle = UITableViewCellSelectionStyleNone;
		_card = [[UIView alloc] initWithFrame:CGRectZero];
		_card.backgroundColor = [ENTheme light].groupedCard;
		_card.layer.cornerRadius = 10;
		_card.layer.borderColor = [ENTheme current].qrBorder.CGColor;
		_card.layer.borderWidth = 1;
		[self.contentView addSubview:_card];
		_qr = [[UIImageView alloc] initWithFrame:CGRectZero];
		_qr.contentMode = UIViewContentModeScaleAspectFit;
		_qr.layer.magnificationFilter = kCAFilterNearest;      // crisp modules at any size
		[_card addSubview:_qr];
		_note = [[UILabel alloc] initWithFrame:CGRectZero];
		_note.font = [ENTheme current].groupedSmallFont;
		_note.textColor = [ENTheme current].groupedNote;
		_note.backgroundColor = [UIColor clearColor];
		_note.textAlignment = NSTextAlignmentCenter;
		_note.text = ENL(@"Friends scan this with their phone camera to join");
		[self.contentView addSubview:_note];
	}
	return self;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGRect b = self.contentView.bounds;
	CGFloat side = 200;
	_card.frame = CGRectMake(floorf((b.size.width - side) / 2), 12, side, side);
	_qr.frame = CGRectInset(_card.bounds, 6, 6);
	_note.frame = CGRectMake(8, 12 + side + 6, b.size.width - 16, 18);
}

@end

@interface ENJamViewController () <ENQueueEditorDelegate>
@end

@implementation ENJamViewController {
	ENJamScreenState _state;
	NSArray *_sections;                 // ENJamSection
	NSArray *_members;                  // what the member rows show (ENJam's at the last rebuild)
	UISwitch *_gcSwitch;
	BOOL _gcWriting;                    // the switch's write is out: its value isn't reset under the finger
	UIImage *_codeImage;
	NSString *_codeToken, *_codeKey;    // the Spotify Code shown / still loading (never logged)
	UIImage *_qrImage;
	NSString *_qrLink;                  // the link _qrImage encodes / is loading (never logged)
	NSString *_heroKey;                 // what the current hero shows (rebuilt only when it changes)
	BOOL _metering;                     // the ENDiag scroll meter runs (a fling, T-j4)
	// 0.9.3 (DESIGN-JAM-UI) the Jam's songs: Up Next's queue (GET /v1/player/queue) and its edits, as Up Next does them
	BOOL _visible;                      // between viewWillAppear: and viewWillDisappear: (covered by a sheet: NO)
	UIBarButtonItem *_doneItem;         // the left "Done", hidden while editing so only one Done shows
	ENQueue *_queue;                    // what the song rows were built from (nil: none yet, or no Up Next on this engine)
	BOOL _qLoading, _qAgain, _qRetried; // a GET is out / one more after it (or after the edits settle) / the retry_ms re-poll used
	ENQueueEditor *_editor;             // the edits FIFO, rev, reply check and the gateway's newest queue (shared with Up Next)
	BOOL _swiping;                      // a swipe's Remove button is up
	BOOL _dragging;                     // a row is under the finger (targetIndexPathForMove… until its drop)
	BOOL _rollbackDue;                  // a failure (or a role change) during that drag: the rows go back after the drop
	BOOL _failing;                      // an edit failed: its own path puts the rows back
	BOOL _rebuildDue;                   // a rebuild was asked for while an edit was busy: it runs once they settle
	NSUInteger _shownGen, _editingGen;  // bumped by every rebuild (new rows) / its value when edit mode or a swipe began
	NSString *_editNote;                // the last edit failure, the footer of the edited section until an edit succeeds or
	                                    // ENJamNoteTime s pass
	BOOL _editNoteContext;              // that edit was a Next from (cq) row's, else Up next's
	BOOL _lastEditContext;              // the section of the last edit handed to the editor
	NSString *_jamRole;                 // the Jam role the edit rules last saw: off / host / guest / lim
	NSUInteger _jamEpoch;               // bumped when the Jam ends or is left: a queue from before it is never shown again
	NSUInteger _queueEpoch;             // the epoch whose GET last answered: the song rows show only while it is _jamEpoch
	NSString *_playingURI;              // the heard song the rows were last asked for with
	BOOL _shuffle;                      // the snapshot's shuffle the editable rows were last worked out with
	__weak UIButton *_editButton;       // Up next's header Edit / Done (the header on screen)
	__weak UINavigationController *_addSheet;   // "Add songs" while it is up
	BOOL _inviteShown;                  // (R2a) "Show Invite" was tapped for _inviteLink (Anonymous Mode); a new link or a
	NSString *_inviteLink;              // switch of the mode hides it again (never logged)
}

- (id)init {
	if ((self = [super initWithStyle:UITableViewStyleGrouped])) {
		_editor = [ENQueueEditor new];
		_editor.delegate = self;
	}
	return self;
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];
	[NSObject cancelPreviousPerformRequestsWithTarget:self];
	if (_codeKey) [[ENImageCache shared] cancel:_codeKey];
}

- (void)viewDidLoad {
	[super viewDidLoad];
	self.title = ENL(@"Jam");
	_doneItem = [[UIBarButtonItem alloc] initWithTitle:ENL(@"Done") style:UIBarButtonItemStyleDone target:self action:@selector(done)];
	[ENTheme skinBarItem:_doneItem];         // (1.1) iOS 5: the Done look on the item itself
	self.navigationItem.leftBarButtonItem = _doneItem;
	// (1.0, C5) the grouped kit's table (ENGroupedViewController's -applyTableTheme): the pinstripe, the card border and
	// separators in groupedBorder, etched in Light; the refresh control in refreshTint (was navTint)
	ENTheme *th = [ENTheme current];
	UITableView *tv = self.tableView;
	tv.backgroundView = nil;
	tv.backgroundColor = th.groupedPattern;
	tv.separatorColor = th.groupedBorder;
	tv.separatorStyle = th.isDark ? UITableViewCellSeparatorStyleSingleLine : UITableViewCellSeparatorStyleSingleLineEtched;
	tv.indicatorStyle = th.indicatorStyle;
	tv.allowsSelectionDuringEditing = NO;
	ENRefreshInstall(self, th.refreshTint, self, @selector(pulled));     // (1.1) UIRefreshControl; iOS 5: ENCompat's own
	_jamRole = [self jamRole];
	_shuffle = [ENPlayback shared].shuffle;
	_playingURI = [[[ENPlayback shared] playingURI] copy];
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(jamChanged) name:ENJamChangedNotification object:nil];
	[nc addObserver:self selector:@selector(textAvailability) name:MFMessageComposeViewControllerTextMessageAvailabilityDidChangeNotification object:nil];
	[nc addObserver:self selector:@selector(queueChanged) name:ENQueueChangedNotification object:nil];
	[nc addObserver:self selector:@selector(playbackChanged) name:ENPlaybackChangedNotification object:nil];
	[nc addObserver:self selector:@selector(anonChanged) name:ENAnonChangedNotification object:nil];     // (R2a)
	[self rebuild];
}

// (R2a) Anonymous Mode switched: names, pictures and the invite follow it (the invite starts hidden again)
- (void)anonChanged {
	_inviteShown = NO;
	_heroKey = nil;
	[self rebuild];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	_visible = YES;
	[[ENJam shared] watch:YES];
	[self rebuild];
	[self reloadQueue];
}

- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	[self becomeFirstResponder];               // lock screen / AirPods while it is up
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	_visible = NO;
	[[ENJam shared] watch:NO];
	[self endRefreshing];
	[self endMeter];
}

- (void)viewDidDisappear:(BOOL)animated {
	[super viewDidDisappear:animated];
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(debouncedReload) object:nil];
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(pollQueue) object:nil];
	// dismissed (not covered by the composer, "Add songs" or a pushed Up Next): the controls go back to whoever is under it
	if (!self.navigationController.presentedViewController && !self.navigationController.view.window)
		[[ENTabBarController shared] reclaimFirstResponder];
}

- (BOOL)canBecomeFirstResponder { return YES; }

- (void)remoteControlReceivedWithEvent:(UIEvent *)event {
	[[ENPlayback shared] handleRemoteEvent:event];
}

- (NSUInteger)supportedInterfaceOrientations { return UIInterfaceOrientationMaskPortrait; }

- (void)done {
	[self dismissViewControllerAnimated:YES completion:nil];
}

#pragma mark - updates

- (void)jamChanged {
	[self endRefreshing];
	[self closeAddSheetIfStale];
	NSString *role = [self jamRole];
	BOOL roleChanged = ![role isEqualToString:_jamRole];
	_jamRole = role;
	// the Jam ended or was left: its songs never show again (the next Jam's show once its own GET has answered)
	if (roleChanged && ![ENJam shared].active) _jamEpoch++;
	[self updateEditButton];                   // edit mode ends when it stops being allowed (a drag: after its drop)
	[self rebuild];                            // never under the finger: waits while an edit is busy
	if (roleChanged) [self queueChanged];      // a Jam began or ended, or the role moved: the songs and `ed` follow it
}

- (void)textAvailability {
	if (!self.isViewLoaded) return;
	if ([self editBusy]) _rebuildDue = YES;
	else [self.tableView reloadData];
}

- (void)pulled {
	[[ENJam shared] refresh:YES];
	[self reloadQueue];
	// a 304 posts nothing: the spinner stops by itself shortly after
	[self performSelector:@selector(endRefreshing) withObject:nil afterDelay:2.0];
}

#pragma mark - the songs (0.9.3: Up Next's queue, loaded as Up Next loads it)

- (NSString *)jamRole {
	ENJam *j = [ENJam shared];
	return !j.active ? @"off" : j.hosting ? @"host" : j.guest ? @"guest" : @"lim";
}

// the gateway's `queue` event, a song change, a role change: one GET 300 ms later (while shown; the next viewWillAppear
// loads anyway)
- (void)queueChanged {
	if (!_visible) return;
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(debouncedReload) object:nil];
	[self performSelector:@selector(debouncedReload) withObject:nil afterDelay:0.3];
}

- (void)debouncedReload {
	if (_visible) [self reloadQueue];
}

- (void)pollQueue {
	if (_visible) [self reloadQueue];
}

// The heard song changed: Now playing follows (the engine's `queue` event usually comes too). Shuffle on or off: whether
// the "Next from" rows may be edited, so the Edit button follows (Up Next's rule; the engine's reordered list arrives as
// a `queue` event).
- (void)playbackChanged {
	ENPlayback *pb = [ENPlayback shared];
	BOOL sh = pb.shuffle;
	if (sh != _shuffle) {
		_shuffle = sh;
		if (_queue) [self updateEditButton];
	}
	NSString *uri = [pb playingURI];
	if (uri == _playingURI || [uri isEqualToString:_playingURI]) return;
	_playingURI = [uri copy];
	[self queueChanged];
}

// GET /v1/player/queue while a Jam is on. As Up Next: one asked for while a GET is out, or while an edit is busy (the rows
// show what the user did, not yet the gateway's answer), runs once more after it; an answer to a GET sent before an edit
// is dropped, and so is one sent before the Jam ended or was left. A 404 (no Up Next on this engine) hides the songs;
// another failure keeps the rows shown (never those of an earlier Jam: -addSongSections).
- (void)reloadQueue {
	if (!self.isViewLoaded || ![ENJam shared].active) return;
	if (_qLoading || [self editBusy]) {
		_qAgain = YES;
		return;
	}
	_qLoading = YES;
	NSUInteger gen = _editor.generation, epoch = _jamEpoch;
	__weak ENJamViewController *w = self;
	[[ENPlayback shared] loadQueue:^(ENQueue *q, BOOL notModified, NSError *e) {
		ENJamViewController *s = w;
		if (!s) return;
		s->_qLoading = NO;
		if ([s editBusy] || gen != s->_editor.generation) {
			s->_qAgain = YES;
			[s editsSettled];
			return;
		}
		// sent before the Jam ended or was left: nothing is shown (the next Jam's role change asks for its own GET)
		BOOL current = epoch == s->_jamEpoch;
		if (current && e && e.code == 404) {
			s->_queueEpoch = epoch;
			[s showQueue:nil];
		} else if (current && !e && q) {
			BOOL hidden = s->_queueEpoch != epoch;     // a 304 for this Jam still shows rows hidden since the last one
			s->_queueEpoch = epoch;
			if (!notModified || q != s->_queue || hidden) [s showQueue:q];
		}
		if (s->_qAgain) {
			s->_qAgain = NO;
			if (s->_visible) [s reloadQueue];
		}
	}];
}

// New rows (every row the gateway sent): the screen is rebuilt at once (any Remove button goes); rows the engine has no
// metadata for yet: once more after retry_ms.
- (void)showQueue:(ENQueue *)q {
	_queue = q;
	[_editor showing:q];
	_swiping = NO;
	_dragging = NO;
	[self rebuildNow];
	BOOL loadingRows = q.now.loading;
	for (ENTrack *t in q.queued) if (t.loading) loadingRows = YES;
	for (ENTrack *t in q.contextRows) if (t.loading) loadingRows = YES;
	if (loadingRows && q.retryMs > 0 && !_qRetried) {
		_qRetried = YES;
		[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(pollQueue) object:nil];
		[self performSelector:@selector(pollQueue) withObject:nil afterDelay:q.retryMs / 1000.0];
	} else if (!loadingRows) {
		_qRetried = NO;
	}
}

// Now playing (the queue's `now`), Up next (`q`, then "Add songs" with x.add) and Next from <ctx.n> (`cq`: in a Jam the
// Jam's own list, where guests' adds most likely live), each only when it has something to show. Only from a GET answered
// during this Jam: rows kept from an earlier one (or a reply to its edits) never show.
- (void)addSongSections:(NSMutableArray *)secs {
	ENQueue *q = _queue;
	if (!ENJamShowsSongs(_state) || !q || _queueEpoch != _jamEpoch) return;
	if (q.now) {
		ENJamSection *s = [ENJamSection new];
		s.kind = ENJamSecNow;
		s.header = ENL(@"Now playing");
		s.tracks = @[ q.now ];
		[secs addObject:s];
	}
	BOOL add = [[ENJam shared] can:@"add"];
	if (q.queued.count || add) {
		ENJamSection *s = [ENJamSection new];
		s.kind = ENJamSecQueue;
		s.header = ENL(@"Up next");
		s.tracks = q.queued;
		s.addRow = add;
		[secs addObject:s];
	}
	if (q.contextRows.count) {
		ENJamSection *s = [ENJamSection new];
		s.kind = ENJamSecContext;
		NSString *from = q.contextName.length ? q.contextName : q.jam ? ENL(@"the Jam") : ENL(@"this list");
		s.header = [NSString stringWithFormat:ENL(@"Next from %@"), from];
		s.tracks = q.contextRows;
		[secs addObject:s];
	}
	if (_editNote) {                           // under the edited section, else the one with Edit / Done
		ENJamSecKind edited = _editNoteContext ? ENJamSecContext : ENJamSecQueue;
		NSInteger i = [self editHeaderSectionIn:secs];
		for (NSUInteger k = 0; k < secs.count; k++)
			if (((ENJamSection *)secs[k]).kind == edited) i = (NSInteger)k;
		if (i >= 0) ((ENJamSection *)secs[(NSUInteger)i]).footer = _editNote;
	}
}

// the section whose header carries Edit / Done: Up next, else Next from (-1: neither)
- (NSInteger)editHeaderSectionIn:(NSArray *)secs {
	NSInteger context = -1;
	for (NSUInteger i = 0; i < secs.count; i++) {
		ENJamSecKind k = ((ENJamSection *)secs[i]).kind;
		if (k == ENJamSecQueue) return (NSInteger)i;
		if (k == ENJamSecContext && context < 0) context = (NSInteger)i;
	}
	return context;
}

- (ENTrack *)trackAt:(NSIndexPath *)ip {
	ENJamSection *s = [self section:ip.section];
	return ip.row >= 0 && (NSUInteger)ip.row < s.tracks.count ? s.tracks[(NSUInteger)ip.row] : nil;
}

#pragma mark - editing (0.9.3: Up Next's remove and reorder, DESIGN-4b §6.10, on this screen's song rows)

// §4.4 "Who may edit": the gateway's `ed` while this screen shows the songs; a guest only while the host lets guests
// control (the gateway decides whether `ed` ever comes to a guest), so a queue fetched before a role change can't offer it
- (BOOL)canEdit {
	ENJam *j = [ENJam shared];
	if (!ENJamShowsSongs([self currentState]) || !_queue.editable) return NO;
	return !(j.guest && !j.canControl);
}

// Up next (`q`), and "Next from" (`cq`) while shuffle is off (Up Next's rule: the gateway and the engine refuse every cq
// edit of a shuffled context); never Now playing
- (BOOL)editsSection:(ENJamSection *)s {
	if (s.kind == ENJamSecQueue) return YES;
	return s.kind == ENJamSecContext && ![ENPlayback shared].shuffle;
}

// the song rows of those sections that have a uid ("Add songs" never)
- (BOOL)editableAt:(NSIndexPath *)ip {
	if (![self canEdit]) return NO;
	if (![self editsSection:[self section:ip.section]]) return NO;
	return [self trackAt:ip].uid.length > 0;
}

- (BOOL)hasEditableRows {
	for (ENJamSection *s in _sections) {
		if (![self editsSection:s]) continue;
		for (ENTrack *t in s.tracks) if (t.uid.length) return YES;
	}
	return NO;
}

// edit mode, a Remove button, or an edit waiting for its reply: loads and rebuilds wait, nothing reloads under the finger
- (BOOL)editBusy {
	return self.editing || _swiping || _editor.busy;
}

// Edit mode ends when editing stops being allowed (the Jam ended, a guest's Jam began, `ed` went away): while a row is
// being dragged, after its drop (-rollBackAfterDrop). Then the header button follows.
- (void)updateEditButton {
	if (![self canEdit] && self.editing) {
		if (_dragging) [self rollBackAfterDrop];
		else [self setEditing:NO animated:YES];
	}
	[self styleEditButton];
}

// Edit (silver) while this phone may edit and something can be edited; Done (green) while editing (1.0: the C7 kit's 28 pt
// gbtn, Bold 12.5)
- (void)styleEditButton {
	UIButton *b = _editButton;
	if (!b) return;
	BOOL done = self.editing;
	b.hidden = !(done || ([self canEdit] && [self hasEditableRows]));
	[ENTheme configureButton:b style:(done ? ENButtonStyleGreen : ENButtonStyleSilver) title:(done ? ENL(@"Done") : ENL(@"Edit")) glyph:nil];
}

- (void)tapEdit {
	[self setEditing:!self.editing animated:YES];
}

// Edit mode (Up next's header button). While editing the left Done hides, so only one Done shows; when editing ends the
// rows settle (a deferred reply, load or rebuild runs), or a rollback waiting for a drop runs now.
- (void)setEditing:(BOOL)editing animated:(BOOL)animated {
	if (editing == self.editing) return;
	if (editing && ![self canEdit]) return;
	// Edit tapped while a swipe's Remove button is up: the table is already editing that row and would take the whole-table
	// setEditing:YES as nothing to do (no reorder controls), so the swipe ends first
	if (editing && _swiping) [self.tableView setEditing:NO animated:NO];
	// the reorder controls as the rows are editable now (shuffle may have changed since a row was drawn)
	if (editing) for (NSIndexPath *ip in self.tableView.indexPathsForVisibleRows)
		[self.tableView cellForRowAtIndexPath:ip].showsReorderControl = [self editableAt:ip];
	[super setEditing:editing animated:animated];
	_swiping = NO;                             // entering or leaving edit mode takes any Remove button away
	_dragging = NO;
	if (editing) _editingGen = _shownGen;     // the rows every drop of this edit session must still be on
	[self.navigationItem setLeftBarButtonItem:(editing ? nil : _doneItem) animated:animated];
	[self styleEditButton];
	if (editing) return;
	if (_rollbackDue) [self rollBack];
	else [self editsSettled];
}

// Edit mode is over, no Remove button is up and every edit has its reply: the newest gateway queue replaces the edited
// rows (the last reply, already in the user's order), else a rebuild asked for meanwhile runs; then a load asked for
// meanwhile.
- (void)editsSettled {
	if (_failing || [self editBusy]) return;
	ENQueue *latest = _editor.latest;
	if (latest && latest != _queue) [self showQueue:latest];
	else if (_rebuildDue) [self rebuild];
	if (_qAgain) {
		_qAgain = NO;
		if (_visible) [self reloadQueue];
	}
}

// the shown q and cq rows (the optimistic edits applied)
- (NSArray *)shownEditKeys {
	NSArray *q = @[], *cq = @[];
	for (ENJamSection *s in _sections) {
		if (s.kind == ENJamSecQueue) q = s.tracks ?: @[];
		else if (s.kind == ENJamSecContext) cq = s.tracks ?: @[];
	}
	return [ENQueueEditor keysForQueued:q context:cq];
}

// ENQueueEditor: one edit out at a time with the rev of the reply before it; this screen lives until its FIFO drains
- (void)enqueueEdit:(ENTrack *)row before:(ENTrack *)before move:(BOOL)move context:(BOOL)context {
	NSArray *after = [self shownEditKeys];     // the callers have already applied it to the rows
	_lastEditContext = context;
	if (move) [_editor move:row before:before context:context shown:after];
	else [_editor remove:row context:context shown:after];
}

// a reply matched (no HUD: the row has already moved or gone); with nothing waiting, the edits have settled
- (void)queueEditorDidApply:(ENQueueEditor *)editor {
	_editNote = nil;                           // gone at the next rebuild
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(clearEditNote) object:nil];
	if (!_editor.busy) [self editsSettled];
}

// §6.10 Errors: the edits behind it are dropped (by the editor), the note under the edited section says why (for
// ENJamNoteTime s), edit mode ends and the rows go back to the gateway's order: the newest queue known at once, then a
// fresh GET. e nil: a reply that showed more than this phone's own edit, handled as queue_changed.
- (void)queueEditor:(ENQueueEditor *)editor didFail:(NSError *)e {
	NSString *text = !e || [[ENCatalog codeOfError:e] isEqualToString:@"queue_changed"] ? ENL(@"The queue changed, so it was refreshed.")
		: [ENCatalog messageForError:e];
	_editNote = [text copy];
	_editNoteContext = _lastEditContext;
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(clearEditNote) object:nil];
	[self performSelector:@selector(clearEditNote) withObject:nil afterDelay:ENJamNoteTime];
	[self rollBackAfterDrop];
}

// the note goes with the next rebuild (which waits while an edit is busy)
- (void)clearEditNote {
	if (!_editNote) return;
	_editNote = nil;
	[self rebuild];
}

// The rows go back to the newest queue the gateway confirmed and edit mode ends, but never under the finger: while a row
// is being dragged this waits for its drop (which is then refused: nothing is sent), ENJamDropWait s at most.
- (void)rollBackAfterDrop {
	if (!(self.editing && _dragging)) {
		[self rollBack];
		return;
	}
	if (_rollbackDue) return;
	_rollbackDue = YES;
	[self performSelector:@selector(rollBackIfDue) withObject:nil afterDelay:ENJamDropWait];
}

- (void)rollBackIfDue {
	if (_rollbackDue) [self rollBack];
}

- (void)rollBack {
	_rollbackDue = NO;
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(rollBackIfDue) object:nil];
	_failing = YES;
	if (self.editing) [self setEditing:NO animated:YES];
	_failing = NO;
	[self showQueue:_editor.latest];
	_qAgain = NO;
	if (_visible) [self reloadQueue];         // off screen: the next viewWillAppear loads
}

// Called back by UITableView inside its own update: a drop the model can't follow is put right on the next turn (edit
// mode ends; with an edit out or waiting its reply settles the rows, else the newest gateway queue is shown).
- (void)abandonEditsLater {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (self.editing) [self setEditing:NO animated:YES];
		if (self->_editor.busy) [self.tableView reloadData];
		else [self showQueue:self->_editor.latest];
	});
}

// a rollback was waiting for a drop: this callback refuses its edit, and the rows go back on the next turn
- (BOOL)refuseForRollback {
	_dragging = NO;
	if (!_rollbackDue) return NO;
	dispatch_async(dispatch_get_main_queue(), ^{ [self rollBackIfDue]; });
	return YES;
}

#pragma mark - Now Playing and Add songs (0.9.3)

// Now Playing: under this sheet when it presented it (closing the Jam shows it), else once every sheet is down
- (void)openNowPlaying {
	ENTabBarController *tabs = [ENTabBarController shared];
	if ([self.navigationController.presentingViewController isKindOfClass:[ENNowPlayingViewController class]] || !tabs) {
		[self done];
		return;
	}
	[tabs dismissViewControllerAnimated:YES completion:^{ [tabs presentNowPlaying]; }];
}

// Search in its "Add songs" mode, in its own navigation stack over this one: song taps add to the Jam, the sheet stays
- (void)tapAddSongs {
	UINavigationController *nav = self.navigationController;
	if (!nav || nav.presentedViewController || ![[ENJam shared] can:@"add"]) return;
	// (1.0) its bar is the green appearance's (+[ENTheme applyChrome]); no per-screen tint (NAV1)
	UINavigationController *sheet = [[UINavigationController alloc] initWithRootViewController:[[ENSearchViewController alloc] initForJam]];
	_addSheet = sheet;
	__weak ENJamViewController *w = self;
	[nav presentViewController:sheet animated:YES completion:^{
		// a Jam change during the slide-up couldn't close it: looked at again once it is up (on the next turn, so the
		// transition has fully ended)
		dispatch_async(dispatch_get_main_queue(), ^{ [w closeAddSheetIfStale]; });
	}];
}

// "Add songs" adds to this Jam only, and only while it takes adds (x.add): otherwise the sheet goes
- (void)closeAddSheetIfStale {
	ENJam *j = [ENJam shared];
	if (!j.active || ![j can:@"add"]) [self closeAddSheet];
}

- (void)closeAddSheet {
	UINavigationController *sheet = _addSheet;
	if (!sheet.presentingViewController || sheet.isBeingPresented || sheet.isBeingDismissed) return;
	[sheet.presentingViewController dismissViewControllerAnimated:YES completion:nil];
}

- (void)endRefreshing {
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(endRefreshing) object:nil];
	ENRefreshEnd(self);
}

- (ENJamScreenState)currentState {
	ENJam *j = [ENJam shared];
	if (!j.active) return [j can:@"sc"] ? ENJamOff : ENJamOffNoSC;
	if (j.away) return ENJamAway;
	if (j.limited) return ENJamLim;
	if (j.waiting) return ENJamWait;
	if (j.hosting) return ENJamHost;
	if (j.guest) return ENJamGuest;
	return ENJamLim;                           // on, role unknown: what plan B shows
}

// (0.9.3) never while an edit is busy (edit mode, a Remove button, an edit out): the table isn't reloaded under the finger
// and the edited rows stay as the user left them; it runs once the edits settle (-editsSettled)
- (void)rebuild {
	if (!self.isViewLoaded) return;
	if ([self editBusy]) {
		_rebuildDue = YES;
		return;
	}
	[self rebuildNow];
}

- (void)rebuildNow {
	if (!self.isViewLoaded) return;
	_rebuildDue = NO;
	_shownGen++;                               // new rows: a drop or a Remove of the old ones sends nothing
	ENJam *j = [ENJam shared];
	_state = [self currentState];
	_members = j.members;
	[self loadCode];
	[self loadQR];
	NSMutableArray *secs = [NSMutableArray array];
	[self addSongSections:secs];               // 0.9.3: Now playing, Up next, Next from (B, C, L, Away)
	BOOL songsShown = secs.count > 0;
	BOOL hostOrGuest = _state == ENJamHost || _state == ENJamGuest;
	// the invite stays as long as the Jam exists and has a link: hosting, a guest, waiting for Spotify, or plan B
	if (j.active && j.link.length && _state != ENJamAway) {
		ENJamSection *s = [ENJamSection new];
		s.header = ENL(@"Invite friends");
		// (R2a, D1) the link, QR and Spotify Code let anyone who sees them join: behind "Show Invite" while Anonymous Mode
		// is on, until the link changes
		if (![j.link isEqualToString:_inviteLink]) {
			_inviteLink = [j.link copy];
			_inviteShown = NO;
		}
		if ([ENAnon on] && !_inviteShown) {
			[s.rows addObject:@(ENJamRowShowInvite)];
			s.footer = ENL(@"The link, QR code and Spotify Code are hidden while Anonymous Mode is on.");
		} else {
			if (_qrImage) [s.rows addObject:@(ENJamRowQR)];
			if ([j can:@"code"] && _codeImage) [s.rows addObject:@(ENJamRowCode)];
			[s.rows addObject:@(ENJamRowLink)];
			[s.rows addObject:@(ENJamRowShare)];
		}
		[secs addObject:s];
	}
	if ((hostOrGuest || _state == ENJamWait) && _members.count) {
		ENJamSection *s = [ENJamSection new];
		s.header = [NSString stringWithFormat:ENL(@"Listening (%lu)"), (unsigned long)MAX(j.count, _members.count)];
		for (NSUInteger i = 0; i < _members.count; i++) [s.rows addObject:@(ENJamRowMember)];
		[secs addObject:s];
	}
	if (_state == ENJamHost && [j can:@"gc"]) {
		ENJamSection *s = [ENJamSection new];
		s.header = ENL(@"Settings");
		[s.rows addObject:@(ENJamRowGuestControl)];
		[secs addObject:s];
	}
	// End and Leave only with x.sc (4b-c): a session known from session_update pushes alone shows its members and the
	// invite, but the gateway can't end or leave it, so the row's place says where to do it (§4.2 lim, §6.5 B and C)
	BOOL sc = [j can:@"sc"];
	if (_state == ENJamHost || _state == ENJamWait) {
		ENJamSection *s = [ENJamSection new];
		if (sc) [s.rows addObject:@(ENJamRowEnd)];
		NSString *note = _state != ENJamHost ? nil : songsShown ? ENL(@"Songs your friends add show their picture above.")
			: ENL(@"Songs your friends add show their picture in Up Next.");
		if (!sc) note = note ? [NSString stringWithFormat:@"%@\n\n%@", ENL(@"End it in Spotify on your computer."), note] : ENL(@"End it in Spotify on your computer.");
		s.footer = note;
		[secs addObject:s];
	} else if (_state == ENJamGuest || (_state == ENJamAway && j.guest)) {
		ENJamSection *s = [ENJamSection new];
		if (sc) [s.rows addObject:@(ENJamRowLeave)];
		NSString *hn = j.hostName ?: ENL(@"the host");
		NSString *note;
		if (_state == ENJamGuest)              // fixed text: L3 step 2 measures the real offset (§6.5 C)
			note = [NSString stringWithFormat:ENL(@"You hear the Jam a second or two after %@, through Encore’s stream."), hn];
		else                                   // away: a guest's resume is never sent (§6.3) and the gateway refuses one (§4.4)
			note = [NSString stringWithFormat:ENL(@"Playing on %@’s Jam elsewhere."), hn];
		s.footer = sc ? note : [NSString stringWithFormat:@"%@\n\n%@", ENL(@"Leave it in Spotify on your computer."), note];
		[secs addObject:s];
	}
	_sections = [secs copy];
	if (!_gcWriting) _gcSwitch.on = j.guestsCanControl;
	[self buildHero];
	[self buildFooter];
	[self.tableView reloadData];
	[self styleEditButton];
}

// The QR of the Jam's link, from the gateway (GET /v1/jam/qr, a PNG); kept until the link changes.
- (void)loadQR {
	ENJam *j = [ENJam shared];
	NSString *link = j.active ? j.link : nil;
	if (!link.length) { _qrImage = nil; _qrLink = nil; return; }
	if ([link isEqualToString:_qrLink]) return;
	_qrLink = [link copy];
	_qrImage = nil;
	__weak ENJamViewController *w = self;
	[[ENGateway shared] fetchData:@"/v1/jam/qr" etag:nil timeout:15 completion:^(NSData *data, NSInteger st, NSString *etag, NSError *err) {
		ENJamViewController *s = w;
		if (!s || ![link isEqualToString:s->_qrLink]) return;
		UIImage *img = st == 200 && data.length ? [UIImage imageWithData:data] : nil;
		if (!img) { s->_qrLink = nil; return; }        // try again at the next rebuild
		s->_qrImage = img;
		[s rebuild];
	}];
}

// the Spotify Code: the 640 tier of ci (a PNG passed through unchanged); a refused width (404) hides the row
- (void)loadCode {
	ENJam *j = [ENJam shared];
	NSString *ci = [j can:@"code"] && j.active && _state != ENJamAway ? j.codeImageToken : nil;
	if (ci == _codeToken || [ci isEqualToString:_codeToken]) return;
	if (_codeKey) [[ENImageCache shared] cancel:_codeKey];
	_codeKey = nil;
	_codeToken = [ci copy];
	_codeImage = ci ? [[ENImageCache shared] memoryImage:ci size:ENImg640 round:NO] : nil;
	if (!ci || _codeImage) return;
	__weak ENJamViewController *w = self;
	_codeKey = [[[ENImageCache shared] load:ci size:ENImg640 round:NO done:^(UIImage *img, NSString *key) {
		ENJamViewController *s = w;
		if (!s || ![s->_codeKey isEqualToString:key]) return;
		s->_codeKey = nil;
		s->_codeImage = img;
		if (img) [s rebuild];
	}] copy];
}

#pragma mark - hero and footer

- (void)buildHero {
	ENJam *j = [ENJam shared];
	NSString *title, *sub;
	BOOL avatars = NO;
	switch (_state) {
		case ENJamOff:
		case ENJamOffNoSC:
			title = ENL(@"Start a Jam");
			sub = ENL(@"Listen together in real time. Friends join from anywhere with a link, add songs, and hear the same queue.");
			break;
		case ENJamHost:
			title = [j title];
			sub = [NSString stringWithFormat:ENL(@"Hosting · %lu listening"), (unsigned long)j.count];
			avatars = YES;
			break;
		case ENJamGuest:
			title = [j title];
			sub = [NSString stringWithFormat:ENL(@"You’re listening along · %lu listening"), (unsigned long)j.count];
			avatars = YES;
			break;
		case ENJamLim:
			title = ENL(@"Jam on Encore");
			sub = ENL(@"Started in Spotify");
			break;
		case ENJamAway:
			title = [j title];
			sub = ENL(@"Your Jam is playing on another device.");
			break;
		case ENJamWait:
			title = [j title];
			sub = ENL(@"Your Jam is live. Invite friends below.");
			avatars = YES;
			break;
	}
	NSArray *ms = avatars ? _members : nil;
	NSUInteger shown = MIN(ms.count, ENJamHeroMaxAvatars);
	NSUInteger total = MAX(j.count, ms.count);
	NSUInteger more = ms.count && total > shown ? total - shown : 0;
	NSMutableString *key = [NSMutableString stringWithFormat:@"%d|%@|%@|%lu|%lu", (int)_state, title, sub, (unsigned long)shown, (unsigned long)more];
	for (NSUInteger i = 0; i < shown; i++) {
		ENJamMember *m = ms[i];
		[key appendFormat:@"|%@%@", m.memberID, m.imageToken ?: @""];
	}
	if ([key isEqualToString:_heroKey] && self.tableView.tableHeaderView) return;
	_heroKey = [key copy];

	CGFloat W = self.tableView.bounds.size.width ?: 320;
	ENTheme *th = [ENTheme current];          // (1.0) the jamHero… tokens: the same look as before (§1.3 "Jam hero: unchanged")
	UIFont *tf = [ENTheme fontOfSize:22 bold:YES], *sf = [ENTheme fontOfSize:13.5f bold:NO];
	CGFloat tw = W - 28;
	CGFloat titleH = ceilf([title sizeWithFont:tf constrainedToSize:CGSizeMake(tw, tf.lineHeight * 2 + 1) lineBreakMode:NSLineBreakByWordWrapping].height);
	CGFloat sh = ceilf([sub sizeWithFont:sf constrainedToSize:CGSizeMake(tw, sf.lineHeight * 4 + 1) lineBreakMode:NSLineBreakByWordWrapping].height);
	BOOL row = shown > 0;
	CGFloat topH = row ? ENJamHeroAvatar : ENJamHeroIcon;
	CGFloat H = 18 + topH + 8 + titleH + 4 + sh + 16;
	NSUInteger slots = shown + (more ? 1 : 0);
	CGFloat rowW = slots ? slots * ENJamHeroAvatar - (slots - 1) * ENJamHeroOverlap : 0;
	CGFloat x0 = floorf((W - rowW) / 2);

	UIImage *img = [th jamHeroImageOfSize:CGSizeMake(W, H) drawing:^(CGContextRef c, CGSize s) {
		if (row) {
			// the avatars' shadows (the views drawn over them have none), and the "+N" bubble
			for (NSUInteger i = 0; i < slots; i++) {
				CGRect r = CGRectMake(x0 + i * (ENJamHeroAvatar - ENJamHeroOverlap), 18, ENJamHeroAvatar, ENJamHeroAvatar);
				CGContextSaveGState(c);
				CGContextSetShadowWithColor(c, CGSizeMake(0, 1), 2, th.jamHeroAvatarShadow.CGColor);
				[th.jamHeroAvatarBacking setFill];
				CGContextFillEllipseInRect(c, CGRectInset(r, 1, 1));
				CGContextRestoreGState(c);
				if (i < shown) continue;
				[th.jamHeroMoreFill setFill];
				CGContextFillEllipseInRect(c, r);
				[th.avatarRing setStroke];
				CGContextSetLineWidth(c, 2);
				CGContextStrokeEllipseInRect(c, CGRectInset(r, 1, 1));
				UIFont *bf = [ENTheme fontOfSize:14 bold:YES];
				NSString *plus = [NSString stringWithFormat:@"+%lu", (unsigned long)more];
				[th.jamHeroText set];
				[plus drawInRect:CGRectMake(r.origin.x, r.origin.y + floorf((ENJamHeroAvatar - bf.lineHeight) / 2), ENJamHeroAvatar, bf.lineHeight)
				        withFont:bf lineBreakMode:NSLineBreakByClipping alignment:NSTextAlignmentCenter];
			}
		} else {
			// the 76 pt dark well with the people glyph (an inner shadow and a light lower edge, as the mockup's .jam-ic)
			CGRect r = CGRectMake(floorf((s.width - ENJamHeroIcon) / 2), 18, ENJamHeroIcon, ENJamHeroIcon);
			CGContextSaveGState(c);                // the light lower edge: only outside the well
			CGContextAddRect(c, CGRectInset(r, -4, -4));
			CGContextAddEllipseInRect(c, r);
			CGContextEOClip(c);
			[th.jamHeroWellEdge setFill];
			CGContextFillEllipseInRect(c, CGRectOffset(r, 0, 1));
			CGContextRestoreGState(c);
			[th.jamHeroWell setFill];
			CGContextFillEllipseInRect(c, r);
			CGContextSaveGState(c);
			CGContextAddEllipseInRect(c, r);
			CGContextClip(c);
			CGContextSetShadowWithColor(c, CGSizeMake(0, 2), 4, th.jamHeroWellShadow.CGColor);
			CGContextAddRect(c, CGRectInset(r, -20, -20));
			CGContextAddEllipseInRect(c, r);
			CGContextEOFillPath(c);
			CGContextRestoreGState(c);
			UIImage *g = [th glyphNamed:@"people" size:44 color:th.jamHeroText];
			[g drawAtPoint:CGPointMake(floorf(CGRectGetMidX(r) - 22), floorf(CGRectGetMidY(r) - 22))];
		}
		CGContextSaveGState(c);
		CGContextSetShadowWithColor(c, CGSizeMake(0, -1), 0, th.jamHeroTextShadow.CGColor);
		CGFloat y = 18 + topH + 8;
		[th.jamHeroText set];
		[title drawInRect:CGRectMake(14, y, tw, titleH) withFont:tf lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentCenter];
		[th.jamHeroSub set];
		[sub drawInRect:CGRectMake(14, y + titleH + 4, tw, sh) withFont:sf lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentCenter];
		CGContextRestoreGState(c);
	}];

	UIView *hero = [[UIView alloc] initWithFrame:CGRectMake(0, 0, W, H)];
	hero.backgroundColor = th.jamHeroFill;
	UIImageView *iv = [[UIImageView alloc] initWithFrame:hero.bounds];
	iv.image = img;
	[hero addSubview:iv];
	for (NSUInteger i = 0; i < shown; i++) {
		ENAvatarView *av = [[ENAvatarView alloc] initWithFrame:CGRectMake(x0 + i * (ENJamHeroAvatar - ENJamHeroOverlap), 18, ENJamHeroAvatar, ENJamHeroAvatar)];
		av.member = ms[i];
		[hero addSubview:av];
	}
	self.tableView.tableHeaderView = hero;
}

// (1.0, C5) the C7 kit's wide gbtn: 44 pt, radius 9, Bold 18 (mockup .gbtn.wide), Green or Silver. Disabled (A′) it keeps
// today's look: the whole button at the caller's alpha, its title in the Normal colour.
- (UIButton *)wideButton:(NSString *)title green:(BOOL)green frame:(CGRect)f action:(SEL)sel {
	UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
	b.frame = f;
	[ENTheme configureButton:b style:(green ? ENButtonStyleGreen : ENButtonStyleSilver) title:title glyph:nil];
	ENTheme *th = [ENTheme current];
	[b setTitleColor:(green ? th.greenButtonText : th.silverText) forState:UIControlStateDisabled];     // (the kit's Normal colour)
	[b addTarget:self action:sel forControlEvents:UIControlEventTouchUpInside];
	return b;
}

// a section footer's note (and the footer-only states' note): the grouped footer tokens (14 in groupedFooter with its white
// shadow; centred, wrapping), the same look as before
- (UILabel *)noteLabel:(NSString *)text width:(CGFloat)w y:(CGFloat)y {
	ENTheme *th = [ENTheme current];
	UIFont *f = th.groupedFooterFont;
	CGFloat h = ceilf([text sizeWithFont:f constrainedToSize:CGSizeMake(w - 38, 200) lineBreakMode:NSLineBreakByWordWrapping].height);
	UILabel *l = [[UILabel alloc] initWithFrame:CGRectMake(19, y, w - 38, h)];
	l.font = f;
	l.textColor = th.groupedFooter;
	l.shadowColor = th.groupedFooterShadow;
	l.shadowOffset = CGSizeMake(0, 1);
	l.backgroundColor = [UIColor clearColor];
	l.textAlignment = NSTextAlignmentCenter;
	l.numberOfLines = 0;
	l.text = text;
	return l;
}

// The states without sections carry their buttons and their note in the table's footer.
- (void)buildFooter {
	UITableView *tv = self.tableView;
	CGFloat W = tv.bounds.size.width ?: 320, y = 14;
	UIView *f = [[UIView alloc] initWithFrame:CGRectMake(0, 0, W, 10)];
	f.backgroundColor = [UIColor clearColor];
	NSString *note = nil;
	switch (_state) {
		case ENJamOff:
		case ENJamOffNoSC: {
			BOOL on = _state == ENJamOff;
			UIButton *start = [self wideButton:ENL(@"Start a Jam") green:YES frame:CGRectMake(12, y, W - 24, 44) action:@selector(tapStart)];
			UIButton *join = [self wideButton:ENL(@"Join a Jam…") green:NO frame:CGRectMake(12, y + 54, W - 24, 44) action:@selector(tapJoin)];
			start.enabled = join.enabled = on;
			start.alpha = join.alpha = on ? 1 : 0.5f;
			[f addSubview:start];
			[f addSubview:join];
			y += 54 + 44 + 14;
			if (on) note = ENL(@"You host with Premium; friends need Premium to join from anywhere. The music plays on the computer running your Encore Bridge and streams here like always.");
			else if ([ENCatalog shared].jamSocialState < 0)
				note = ENL(@"Start a Jam in Spotify on your computer with Encore selected; it shows up here; your Encore Bridge’s admin page has a one-time check to enable it here.");
			else note = ENL(@"Start a Jam in Spotify on your computer with Encore selected; it shows up here.");
			break;
		}
		case ENJamLim:
			[f addSubview:[self wideButton:ENL(@"Show Up Next") green:NO frame:CGRectMake(12, y, W - 24, 44) action:@selector(tapUpNext)]];
			y += 44 + 14;
			note = ENL(@"End it in Spotify on your computer.");
			break;
		case ENJamAway: {
			ENJam *j = [ENJam shared];
			if (j.guest) {                         // a guest's resume can't work: the guest Leave row instead (-rebuild)
				tv.tableFooterView = nil;
				return;
			}
			[f addSubview:[self wideButton:ENL(@"Play on Encore") green:YES frame:CGRectMake(12, y, W - 24, 44) action:@selector(tapPlayHere)]];
			y += 54;
			if (j.hosting && [j can:@"sc"]) {      // the gateway ends an away Jam too (lim has nothing to end; no sc, no End)
				UIButton *b = [self wideButton:ENL(@"End Jam") green:NO frame:CGRectMake(12, y, W - 24, 44) action:@selector(tapEnd)];
				[b setTitleColor:[ENTheme current].jamRed forState:UIControlStateNormal];
				[b setTitleColor:[ENTheme current].jamRed forState:UIControlStateHighlighted];     // (the kit sets one for it)
				[f addSubview:b];
				y += 54;
			} else if (j.hosting) {
				note = ENL(@"End it in Spotify on your computer.");
			}
			y += 4;
			break;
		}
		default:
			tv.tableFooterView = nil;
			return;
	}
	if (note) {
		UILabel *l = [self noteLabel:note width:W y:y];
		[f addSubview:l];
		y += l.frame.size.height;
	}
	f.frame = CGRectMake(0, 0, W, y + 20);
	tv.tableFooterView = f;
}

#pragma mark - table

- (ENJamSection *)section:(NSInteger)i {
	return i >= 0 && (NSUInteger)i < _sections.count ? _sections[(NSUInteger)i] : nil;
}

- (ENJamRowKind)kindAt:(NSIndexPath *)ip {
	ENJamSection *s = [self section:ip.section];
	if (ip.row < 0) return ENJamRowNone;
	NSUInteger r = (NSUInteger)ip.row;
	if (s.kind != ENJamSecOther) {             // 0.9.3: the songs, then Up next's "Add songs"
		if (r < s.tracks.count) return s.kind == ENJamSecNow ? ENJamRowNow : ENJamRowSong;
		return s.addRow && r == s.tracks.count ? ENJamRowAdd : ENJamRowNone;
	}
	return r < s.rows.count ? (ENJamRowKind)[s.rows[r] intValue] : ENJamRowNone;
}

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return (NSInteger)_sections.count; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return (NSInteger)[self section:section].rowCount;
}

- (CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)ip {
	switch ([self kindAt:ip]) {
		case ENJamRowCode: return 112;
		case ENJamRowQR: return 242;
		case ENJamRowShare: return 54;
		case ENJamRowMember: return 52;
		case ENJamRowGuestControl: return 62;
		case ENJamRowNow:
		case ENJamRowSong: return ENJamSongHeight;
		default: return 44;
	}
}

- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	NSString *t = [self section:section].header;
	if (!t) return nil;
	CGFloat w = tableView.bounds.size.width;
	BOOL edit = section == [self editHeaderSectionIn:_sections];      // 0.9.3: Up next's Edit / Done at the right
	ENTheme *th = [ENTheme current];
	UIView *v = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, 45)];
	v.backgroundColor = [UIColor clearColor];
	UILabel *l = [[UILabel alloc] initWithFrame:CGRectMake(19, 18, w - 38 - (edit ? 66 : 0), 21)];
	l.font = th.groupedHeaderFont;
	l.textColor = th.groupedHeader;
	l.shadowColor = th.groupedHeaderShadow;
	l.shadowOffset = th.groupedHeaderShadowOffset;
	l.backgroundColor = [UIColor clearColor];
	l.text = t;
	[v addSubview:l];
	if (edit) {
		UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
		b.frame = CGRectMake(w - 10 - 58, 14, 58, 28);       // (the kit's 28 pt gbtn: -styleEditButton)
		b.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin;
		[b addTarget:self action:@selector(tapEdit) forControlEvents:UIControlEventTouchUpInside];
		[v addSubview:b];
		_editButton = b;
		[self styleEditButton];
	}
	return v;
}

- (CGFloat)tableView:(UITableView *)tableView heightForHeaderInSection:(NSInteger)section {
	return [self section:section].header ? 45 : 18;
}

- (CGFloat)footerTextHeight:(NSString *)t width:(CGFloat)w {
	return ceilf([t sizeWithFont:[ENTheme current].groupedFooterFont constrainedToSize:CGSizeMake(w - 38, 200)
	                lineBreakMode:NSLineBreakByWordWrapping].height);
}

- (UIView *)tableView:(UITableView *)tableView viewForFooterInSection:(NSInteger)section {
	NSString *t = [self section:section].footer;
	if (!t) return nil;
	CGFloat w = tableView.bounds.size.width;
	UIView *v = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, [self footerTextHeight:t width:w] + 20)];
	v.backgroundColor = [UIColor clearColor];
	[v addSubview:[self noteLabel:t width:w y:6]];
	return v;
}

- (CGFloat)tableView:(UITableView *)tableView heightForFooterInSection:(NSInteger)section {
	NSString *t = [self section:section].footer;
	return t ? [self footerTextHeight:t width:tableView.bounds.size.width] + 20 : 2;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENJam *j = [ENJam shared];
	ENJamRowKind kind = [self kindAt:ip];
	if (kind == ENJamRowNow || kind == ENJamRowSong) {       // 0.9.3
		ENJamSongCell *c = [tableView dequeueReusableCellWithIdentifier:@"song"] ?: [[ENJamSongCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:@"song"];
		ENTrack *t = [self trackAt:ip];
		ENJamMember *m = t.byMemberID ? [j memberWithID:t.byMemberID] : nil;
		BOOL now = kind == ENJamRowNow;
		[c showTrack:t by:m playing:now muted:([self section:ip.section].kind == ENJamSecContext)];
		c.selectionStyle = now ? UITableViewCellSelectionStyleBlue : UITableViewCellSelectionStyleNone;
		// (1.0) Now playing's chevron is the grouped kit's (chevRight 13, white on the green selection), as Settings' rows
		c.accessoryType = UITableViewCellAccessoryNone;
		c.accessoryView = now ? [self chevronView] : nil;
		c.showsReorderControl = [self editableAt:ip];
		return c;
	}
	if (kind == ENJamRowQR) {
		ENJamQRCell *c = [tableView dequeueReusableCellWithIdentifier:@"qr"] ?: [[ENJamQRCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:@"qr"];
		c.qr.image = _qrImage;
		return c;
	}
	if (kind == ENJamRowCode) {
		ENJamCodeCell *c = [tableView dequeueReusableCellWithIdentifier:@"code"] ?: [[ENJamCodeCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:@"code"];
		c.code.image = _codeImage;
		return c;
	}
	if (kind == ENJamRowShare) {
		ENJamShareCell *c = [tableView dequeueReusableCellWithIdentifier:@"share"];
		if (!c) {
			c = [[ENJamShareCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:@"share"];
			[c.message addTarget:self action:@selector(tapMessage) forControlEvents:UIControlEventTouchUpInside];
			[c.linkButton addTarget:self action:@selector(tapCopy) forControlEvents:UIControlEventTouchUpInside];
		}
		c.message.alpha = [ENJamActions canSendText] ? 1 : 0.5f;      // looks disabled; a tap explains (§6.8)
		return c;
	}
	ENJamCell *c = [tableView dequeueReusableCellWithIdentifier:@"row"] ?: [[ENJamCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:@"row"];
	c.selectionStyle = UITableViewCellSelectionStyleNone;
	c.accessoryView = nil;
	c.avatar.hidden = YES;
	c.icon.hidden = YES;
	c.centered = NO;
	[c resetColors];
	c.small.text = c.value.text = nil;
	switch (kind) {
		case ENJamRowLink:
			c.title.text = ENL(@"Link");
			c.value.text = j.link;
			break;
		case ENJamRowMember: {
			ENJamMember *m = (NSUInteger)ip.row < _members.count ? _members[(NSUInteger)ip.row] : nil;
			c.avatar.hidden = NO;
			c.avatar.member = m;
			c.title.text = m.isMe ? ENL(@"You") : m.name;
			c.small.text = m.isMe ? ENL(@"Playing on Encore") : m.isHost ? ENL(@"Started the Jam") : ENL(@"Joined with a link");
			if (m.isHost) c.value.text = ENL(@"Host");
			if (_state == ENJamHost && [j can:@"kick"] && m && !m.isMe && !m.isHost) {
				UIButton *rm = [self removeButton];
				rm.tag = ip.row;
				c.accessoryView = rm;
			}
			if ([self memberOpensProfile:m]) c.selectionStyle = UITableViewCellSelectionStyleBlue;    // (0.11) a tap: the profile
			break;
		}
		case ENJamRowGuestControl:
			c.title.text = ENL(@"Guests Can Control");
			c.small.text = ENL(@"Pause, skip and reorder; adding songs always works");
			if (!_gcSwitch) {                  // (1.0) its onTintColor is the appearance's switchOnTint (+applyChrome)
				_gcSwitch = [[UISwitch alloc] initWithFrame:CGRectZero];
				[_gcSwitch addTarget:self action:@selector(gcChanged) forControlEvents:UIControlEventValueChanged];
			}
			if (!_gcWriting) _gcSwitch.on = j.guestsCanControl;
			c.accessoryView = _gcSwitch;
			break;
		case ENJamRowEnd:
		case ENJamRowLeave:
			c.centered = YES;
			c.title.text = kind == ENJamRowEnd ? ENL(@"End Jam") : ENL(@"Leave Jam");
			c.title.textColor = [ENTheme current].jamRed;
			c.selectionStyle = UITableViewCellSelectionStyleBlue;
			break;
		case ENJamRowShowInvite: {             // (R2a) green and centred, as a button row
			ENTheme *th = [ENTheme current];
			c.centered = YES;
			c.title.text = ENL(@"Show Invite");
			c.title.textColor = th.accent;
			c.selectionStyle = UITableViewCellSelectionStyleBlue;
			break;
		}
		case ENJamRowAdd: {                    // 0.9.3: Up next's last row, green (1.0: white on the green selection)
			ENTheme *th = [ENTheme current];
			c.icon.hidden = NO;
			c.icon.image = [th glyphNamed:@"plus" size:26 color:th.accent];
			c.icon.highlightedImage = [th glyphNamed:@"plus" size:26 color:th.cellSelectedTitle];
			c.title.text = ENL(@"Add songs");
			c.title.textColor = th.accent;
			c.selectionStyle = UITableViewCellSelectionStyleBlue;
			break;
		}
		default:
			break;
	}
	[c setNeedsLayout];
	return c;
}

// the grouped kit's chevron as an accessory view (ENGroupedCell's: groupedChevronImage, the white chevRight when highlighted)
- (UIImageView *)chevronView {
	ENTheme *th = [ENTheme current];
	UIImageView *v = [[UIImageView alloc] initWithImage:th.groupedChevronImage
	                                   highlightedImage:[th glyphNamed:@"chevRight" size:13 color:th.cellSelectedTitle]];
	v.contentMode = UIViewContentModeCenter;
	return v;
}

// a member row's Remove: the C7 kit's 28 pt silver gbtn (Bold 12.5; mockup: the Jam sheet's 28 px Remove)
- (UIButton *)removeButton {
	UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
	b.frame = CGRectMake(0, 0, 72, 28);
	[ENTheme configureButton:b style:ENButtonStyleSilver title:ENL(@"Remove") glyph:nil];
	[b addTarget:self action:@selector(tapRemove:) forControlEvents:UIControlEventTouchUpInside];
	return b;
}

// The green selection with this row's corners (1.0, C5: instead of iOS's blue; -[ENTheme groupedSelectionImage:], as the
// grouped kit's willDisplayCell), for every row; it shows only on the rows whose selectionStyle isn't None (the tappable
// ones, as before).
- (void)applySelectionToCell:(UITableViewCell *)cell atIndexPath:(NSIndexPath *)ip {
	NSInteger n = [self.tableView numberOfRowsInSection:ip.section];
	ENGroupedPosition pos = n <= 1 ? ENGroupedSingle : ip.row == 0 ? ENGroupedTop : ip.row == n - 1 ? ENGroupedBottom : ENGroupedMiddle;
	UIImage *sel = [[ENTheme current] groupedSelectionImage:pos];
	UIImageView *sv = (UIImageView *)cell.selectedBackgroundView;
	if ([sv isKindOfClass:[UIImageView class]]) sv.image = sel;
	else cell.selectedBackgroundView = [[UIImageView alloc] initWithImage:sel];
}

// A row removed in place (a swipe's or edit mode's Remove) changes its neighbours' corners: the visible rows of that section
// take theirs again (the rebuild after the edits settle redoes every row anyway).
- (void)refreshSelectionInSection:(NSInteger)section {
	for (NSIndexPath *ip in self.tableView.indexPathsForVisibleRows) {
		if (ip.section != section) continue;
		UITableViewCell *cell = [self.tableView cellForRowAtIndexPath:ip];
		if (cell) [self applySelectionToCell:cell atIndexPath:ip];
	}
}

// (0.9.3) a song row's fill: a grouped cell's colour is only reliable when set here. (1.0) Every other row's card is
// groupedCard, and every row gets the green selection.
- (void)tableView:(UITableView *)tableView willDisplayCell:(UITableViewCell *)cell forRowAtIndexPath:(NSIndexPath *)ip {
	if ([cell isKindOfClass:[ENJamSongCell class]]) cell.backgroundColor = ((ENJamSongCell *)cell).fill;
	else cell.backgroundColor = [ENTheme current].groupedCard;
	[self applySelectionToCell:cell atIndexPath:ip];
}

// Now playing opens Now Playing and "Add songs" its sheet (0.9.3); the other song rows do what Up Next's do: nothing.
// (0.11) A member row opens that person's profile while profiles are available.
- (NSIndexPath *)tableView:(UITableView *)tableView willSelectRowAtIndexPath:(NSIndexPath *)ip {
	ENJamRowKind k = [self kindAt:ip];
	if (k == ENJamRowMember) return [self memberOpensProfile:[self memberAt:ip]] ? ip : nil;
	return k == ENJamRowEnd || k == ENJamRowLeave || k == ENJamRowNow || k == ENJamRowAdd || k == ENJamRowShowInvite ? ip : nil;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	ENJamRowKind k = [self kindAt:ip];
	if (k == ENJamRowEnd) [ENJamActions confirmEnd];
	else if (k == ENJamRowLeave) [ENJamActions confirmLeave];
	else if (k == ENJamRowNow) [self openNowPlaying];
	else if (k == ENJamRowAdd) [self tapAddSongs];
	else if (k == ENJamRowMember) [self openMember:[self memberAt:ip]];
	else if (k == ENJamRowShowInvite) {        // (R2a) for this link, until the mode switches
		_inviteShown = YES;
		[self rebuild];
	}
}

#pragma mark - member rows -> profiles (0.11, DESIGN-PROFILES §4.4)

- (ENJamMember *)memberAt:(NSIndexPath *)ip {
	return [self kindAt:ip] == ENJamRowMember && (NSUInteger)ip.row < _members.count ? _members[(NSUInteger)ip.row] : nil;
}

// "You" always (the user's own profile); anyone else whose id makes a spotify:user: uri; only while profiles are available
- (BOOL)memberOpensProfile:(ENJamMember *)m {
	if (!m || ![ENCatalog shared].profilesAvailable) return NO;
	return m.isMe || ENUserURIFromID(m.memberID) != nil;
}

// pushed in the Jam's own navigation controller, with no mini player inset (the sheet has none)
- (void)openMember:(ENJamMember *)m {
	if (![self memberOpensProfile:m]) return;
	ENProfileViewController *vc = m.isMe ? [[ENProfileViewController alloc] init]
		: [[ENProfileViewController alloc] initWithUserURI:ENUserURIFromID(m.memberID) name:m.name image:m.imageToken];
	vc.ignoresMiniPlayer = YES;
	[self.navigationController pushViewController:vc animated:YES];
}

#pragma mark - table editing (0.9.3: Up Next's, on the song rows; every other row is never editable)

- (BOOL)tableView:(UITableView *)tableView canEditRowAtIndexPath:(NSIndexPath *)ip {
	return [self editableAt:ip];               // also what offers swipe-to-remove outside edit mode
}

- (BOOL)tableView:(UITableView *)tableView canMoveRowAtIndexPath:(NSIndexPath *)ip {
	return [self editableAt:ip];
}

- (UITableViewCellEditingStyle)tableView:(UITableView *)tableView editingStyleForRowAtIndexPath:(NSIndexPath *)ip {
	return [self editableAt:ip] ? UITableViewCellEditingStyleDelete : UITableViewCellEditingStyleNone;
}

- (BOOL)tableView:(UITableView *)tableView shouldIndentWhileEditingRowAtIndexPath:(NSIndexPath *)ip {
	return [self editableAt:ip];
}

- (NSString *)tableView:(UITableView *)tableView titleForDeleteConfirmationButtonForRowAtIndexPath:(NSIndexPath *)ip {
	return ENL(@"Remove");
}

// a swipe's Remove button (only for a swipe; edit mode itself goes through -setEditing:animated:)
- (void)tableView:(UITableView *)tableView willBeginEditingRowAtIndexPath:(NSIndexPath *)ip {
	_swiping = YES;
	_editingGen = _shownGen;                   // the rows its Remove must still be on
}

- (void)tableView:(UITableView *)tableView didEndEditingRowAtIndexPath:(NSIndexPath *)ip {
	_swiping = NO;
	__weak ENJamViewController *w = self;
	dispatch_async(dispatch_get_main_queue(), ^{ [w editsSettled]; });     // not from inside the table's own callback
}

// Remove: the row leaves its section at once, then the request goes out. The section and its header stay (Up next's holds
// Done) until the edits settle and the screen is rebuilt.
- (void)tableView:(UITableView *)tableView commitEditingStyle:(UITableViewCellEditingStyle)style forRowAtIndexPath:(NSIndexPath *)ip {
	if ([self refuseForRollback]) return;
	if (_editingGen != _shownGen) {            // the rows were replaced since the swipe or edit mode began: nothing is sent
		[self abandonEditsLater];
		return;
	}
	if (style != UITableViewCellEditingStyleDelete || ![self editableAt:ip]) return;
	ENJamSection *s = [self section:ip.section];
	NSMutableArray *rows = [s.tracks mutableCopy];
	ENTrack *row = rows[(NSUInteger)ip.row];
	[rows removeObjectAtIndex:(NSUInteger)ip.row];
	s.tracks = rows;
	[tableView deleteRowsAtIndexPaths:@[ ip ] withRowAnimation:UITableViewRowAnimationFade];
	[self refreshSelectionInSection:ip.section];     // (1.0) "Add songs" may now be the section's only row: its corners
	[self enqueueEdit:row before:nil move:NO context:(s.kind == ENJamSecContext)];
	if (!self.editing) [self updateEditButton];     // the last editable row may have gone
}

// Reorder stays among the songs of the row's own section: a proposal above them -> the first song, below them (or onto
// "Add songs") -> the last song. Called while a row is dragged, so it also marks the drag (a rollback waits for its drop).
- (NSIndexPath *)tableView:(UITableView *)tableView targetIndexPathForMoveFromRowAtIndexPath:(NSIndexPath *)from
       toProposedIndexPath:(NSIndexPath *)to {
	_dragging = YES;
	NSInteger last = MAX((NSInteger)[self section:from.section].tracks.count - 1, (NSInteger)0);
	if (to.section == from.section) return to.row > last ? [NSIndexPath indexPathForRow:last inSection:from.section] : to;
	return [NSIndexPath indexPathForRow:(to.section < from.section ? 0 : last) inSection:from.section];
}

// The table already shows the move: the section's songs follow it, then the request goes out with `before` = the song now
// after it in that section (nil at the end: ENQueueEditor then names the first row past the shown ones, if any). A drop
// that may not belong to the rows the model has (edit mode ended or the rows were replaced since the drag began, the row
// no longer editable, another section, an index out of range) sends nothing and the table is put right.
- (void)tableView:(UITableView *)tableView moveRowAtIndexPath:(NSIndexPath *)from toIndexPath:(NSIndexPath *)to {
	if ([self refuseForRollback]) return;
	if (from.section == to.section && from.row == to.row) return;
	ENJamSection *s = [self section:from.section];
	NSUInteger n = s.tracks.count;
	if (!self.editing || _editingGen != _shownGen || ![self editableAt:from] || from.section != to.section || to.row < 0
		|| (NSUInteger)to.row >= n) {
		[self abandonEditsLater];
		return;
	}
	NSMutableArray *rows = [s.tracks mutableCopy];
	ENTrack *row = rows[(NSUInteger)from.row];
	[rows removeObjectAtIndex:(NSUInteger)from.row];
	[rows insertObject:row atIndex:(NSUInteger)to.row];
	s.tracks = rows;
	ENTrack *before = (NSUInteger)to.row + 1 < rows.count ? rows[(NSUInteger)to.row + 1] : nil;
	[self enqueueEdit:row before:before move:YES context:(s.kind == ENJamSecContext)];
}

#pragma mark - the scroll meter (§6.12: T-j4 flings this screen)

- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView {
	if (_metering) return;
	_metering = YES;
	[ENDiag scrollBegan:@"jam"];
}

- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView willDecelerate:(BOOL)decelerate {
	ENRefreshDragEnded(self);          // (1.1) iOS 5's pull to refresh (nothing on iOS 6)
	if (!decelerate) [self endMeter];
}

- (void)scrollViewDidScroll:(UIScrollView *)scrollView {
	ENRefreshScrolled(self);           // (1.1) iOS 5's pull to refresh (nothing on iOS 6)
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView { [self endMeter]; }

- (void)endMeter {
	if (!_metering) return;
	_metering = NO;
	[ENDiag scrollEnded];
}

#pragma mark - actions (all of them ENJamActions')

- (void)tapStart { [ENJamActions startJamFrom:self]; }
- (void)tapJoin { [ENJamActions promptJoin]; }
- (void)tapMessage { [ENJamActions messageLinkFrom:self.navigationController ?: self]; }
- (void)tapCopy { [ENJamActions copyLink]; }
- (void)tapPlayHere { [ENJamActions playOnEncore]; }
- (void)tapEnd { [ENJamActions confirmEnd]; }

- (void)tapUpNext {
	[self.navigationController pushViewController:[[ENQueueViewController alloc] init] animated:YES];
}

- (void)tapRemove:(UIButton *)b {
	NSUInteger i = (NSUInteger)b.tag;
	if (i < _members.count) [ENJamActions removeMember:_members[i]];
}

- (void)gcChanged {
	BOOL on = _gcSwitch.on;
	_gcWriting = YES;
	__weak ENJamViewController *w = self;
	[ENJamActions setGuestsCanControl:on done:^(BOOL ok) {
		ENJamViewController *s = w;
		if (!s) return;
		s->_gcWriting = NO;
		[s->_gcSwitch setOn:[ENJam shared].guestsCanControl animated:YES];     // the reply's state, or back on failure
	}];
}

@end

#import "ENTrackListViewController.h"
#import "ENTheme.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENImageCache.h"
#import "ENTrackActions.h"
#import "ENArtistViewController.h"
#import "ENUtil.h"
#import "ENAppDelegate.h"
#import "ENHUD.h"
#import "ENSheets.h"
#import "ENProfileViewController.h"
#import "ENAnon.h"
#import "ENL.h"

static const CGFloat ENHeaderTop = 136;           // the cover block (0.11: its least height; it grows with the text column);
                                                  // a description strip may follow. (3c) = the mockup's .hdr: 14 + 108 + 14
static const CGFloat ENHeaderTextX = 133;         // the text column: 12 + the 108 pt cover + 13
static const CGFloat ENHeaderPad = 14;            // (3c) .hdr padding: the cover's top, and the block's bottom under the cover /
                                                  // the button row
static const CGFloat ENHeaderCover = 108;         // the framed cover (white mat 3 pt + the 102 pt picture)
static const CGFloat ENHeaderButtonH = 34;        // (3c, DESIGN-5 §2.3 C2) Play / Shuffle / Save: the mockup's 34 pt .gbtn (0.10: 30)
static const CGFloat ENHeaderIconW = 38;          // (3c) the icon-only Shuffle and the album's Save pill (.gbtn.silver.iconly)
static const CGFloat ENHeaderButtonGap = 6;       // (3c) .h-btns gap
static const CGFloat ENHeaderIconPt = 19;         // (3c) the Save pill's heart: the iconly size (Shuffle's glyph, C7)
static const NSTimeInterval ENGiveUpAfter = 120;  // partial lists: stop polling after 2 minutes
#define ENGiveUpText ENL(@"Still loading. Pull to refresh.")
#define ENSavedCopyText ENL(@"Showing a saved copy")

static BOOL ENSame(NSString *a, NSString *b) { return a == b || [a isEqualToString:b]; }

static NSString *ENGrouped(NSInteger n) {         // "1,234"
	static NSNumberFormatter *f;
	if (!f) {
		f = [[NSNumberFormatter alloc] init];
		f.numberStyle = NSNumberFormatterDecimalStyle;
		f.usesGroupingSeparator = YES;
	}
	return [f stringFromNumber:@(n)] ?: [NSString stringWithFormat:@"%ld", (long)n];
}

// (3c, DESIGN-5 §2.3 C2) an album's footer, the mockup's "℗ <year> <label>": the answer's copyright (ENAlbumRow.copyright,
// the gateway's pick of Spotify's P text, else its C text). A leading "℗" / "(P)" keeps the ℗, a "©" / "(C)" (a C text) shows
// as ©, a text without a mark gets the ℗ (the gateway prefers P); the album's year goes in front when the text has no year of
// its own. nil without a copyright (no footer: the header's meta already says the count and length).
static NSString *ENCopyrightLine(NSString *text, NSInteger year) {
	NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];
	NSString *s = [text stringByTrimmingCharactersInSet:ws];
	if (!s.length) return nil;
	NSString *mark = @"℗";
	for (NSString *m in @[ @"℗", @"(P)", @"©", @"(C)" ]) {
		if ([s rangeOfString:m options:NSAnchoredSearch | NSCaseInsensitiveSearch].location == NSNotFound) continue;
		if (![m isEqualToString:@"℗"] && ![m isEqualToString:@"(P)"]) mark = @"©";
		s = [[s substringFromIndex:m.length] stringByTrimmingCharactersInSet:ws];
		break;
	}
	BOOL hasYear = [s rangeOfString:@"\\b(1[89]|20)[0-9][0-9]\\b" options:NSRegularExpressionSearch].location != NSNotFound;
	if (year > 0 && !hasYear) s = s.length ? [NSString stringWithFormat:@"%ld %@", (long)year, s] : [NSString stringWithFormat:@"%ld", (long)year];
	return s.length ? [NSString stringWithFormat:@"%@ %@", mark, s] : nil;
}

#pragma mark - sort (0.9.2)

// (0.9.2, DESIGN-0.9.2 §2) Sort inside playlists and Liked Songs. The choice is kept per list in NSUserDefaults under
// "encore.sort.<list uri>" (no key: the list's own order, the default).
// (0.9.4, DESIGN-DATE-ADDED) + Date added, newest / oldest first. Playlists: by the gateway's dates added
// ([ENCatalog loadAddedDates:]). Liked Songs: "Recently added" is its own order (Custom), and oldest first is that order
// backwards (no dates asked for); a stored "added_newest" there reads as Custom.
typedef enum { ENSortCustom = 0, ENSortTitle, ENSortArtist, ENSortAlbum, ENSortAddedNewest, ENSortAddedOldest, ENSortCount } ENSortMode;
static NSString *const ENSortKeys[ENSortCount] = { @"custom", @"title", @"artist", @"album", @"added_newest", @"added_oldest" };   // stored
static NSString *ENSortName(ENSortMode m) {                     // the sheet (Liked: "Recently added")
	NSString *names[ENSortCount] = { ENL(@"Custom order"), ENL(@"Title"), ENL(@"Artist"), ENL(@"Album"),
		ENL(@"Date added (newest first)"), ENL(@"Date added (oldest first)") };
	return names[m];
}
static NSString *ENSortButtonName(ENSortMode m) {               // "Sort: …"
	NSString *names[ENSortCount] = { @"", ENL(@"Title"), ENL(@"Artist"), ENL(@"Album"), ENL(@"Newest first"), ENL(@"Oldest first") };
	return names[m];
}

static BOOL ENSortByDate(ENSortMode m) { return m == ENSortAddedNewest || m == ENSortAddedOldest; }

static NSString *ENSortDefaultsKey(NSString *listURI) {
	return [@"encore.sort." stringByAppendingString:listURI ?: @""];
}

static ENSortMode ENSavedSort(NSString *listURI) {
	NSString *s = [[NSUserDefaults standardUserDefaults] stringForKey:ENSortDefaultsKey(listURI)];
	for (NSUInteger i = ENSortTitle; i < ENSortCount; i++) if ([s isEqualToString:ENSortKeys[i]]) return (ENSortMode)i;
	return ENSortCustom;
}

// One playable row while sorting: its keys folded once (case, diacritics, width), so the n log n compares are plain code
// point ones rather than a locale collation each (a 5,000-song list sorts on the main thread), and where it was in the list.
@interface ENSortRow : NSObject
@property (nonatomic, strong) ENTrack *track;
@property (nonatomic, copy) NSString *k1, *k2;      // Title: the name | Artist: the artists, the album | Album: the album
@property (nonatomic) NSInteger disc, number;       // Artist: the album's own order, when the rows carry it (album pages)
@property (nonatomic) NSUInteger index;             // the list's own order: breaks every tie (stable)
@property (nonatomic) long long added;              // (0.9.4) Date added: ms since 1970
@end

@implementation ENSortRow
@end

static NSString *ENSortFold(NSString *s, NSLocale *loc) {
	return s.length ? [s stringByFoldingWithOptions:NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch | NSWidthInsensitiveSearch locale:loc] : @"";
}

// tracks in `mode` order; Loading… / Unavailable rows keep their own order after the rest
static NSArray *ENSortedTracks(NSArray *tracks, ENSortMode mode) {
	NSLocale *loc = [NSLocale currentLocale];
	NSMutableArray *rows = [NSMutableArray arrayWithCapacity:tracks.count];
	NSMutableArray *rest = [NSMutableArray array];
	NSUInteger i = 0;
	for (ENTrack *t in tracks) {
		NSUInteger at = i++;
		if (!t.playable) { [rest addObject:t]; continue; }
		ENSortRow *r = [ENSortRow new];
		r.track = t;
		r.index = at;
		if (mode == ENSortTitle) r.k1 = ENSortFold(t.name, loc);
		else if (mode == ENSortAlbum) r.k1 = ENSortFold(t.album, loc);
		else {
			r.k1 = ENSortFold(t.artists, loc);
			r.k2 = ENSortFold(t.album, loc);
			r.disc = t.discNumber;
			r.number = t.trackNumber;
		}
		[rows addObject:r];
	}
	[rows sortUsingComparator:^NSComparisonResult(ENSortRow *a, ENSortRow *b) {
		NSComparisonResult c = [a.k1 compare:b.k1 options:NSLiteralSearch];
		if (c == NSOrderedSame && a.k2) c = [a.k2 compare:b.k2 options:NSLiteralSearch];
		if (c == NSOrderedSame && a.number > 0 && b.number > 0) {
			if (a.disc != b.disc) c = a.disc < b.disc ? NSOrderedAscending : NSOrderedDescending;
			else if (a.number != b.number) c = a.number < b.number ? NSOrderedAscending : NSOrderedDescending;
		}
		if (c == NSOrderedSame && a.index != b.index) c = a.index < b.index ? NSOrderedAscending : NSOrderedDescending;
		return c;
	}];
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:tracks.count];
	for (ENSortRow *r in rows) [out addObject:r.track];
	[out addObjectsFromArray:rest];
	return out;
}

// (0.9.4) The date added (NSNumber ms, 0 = none) of each of `tracks`, the rows shown: the catalog's copy `raw` less the songs
// being removed (raw's own objects, in raw's order). By position when the gateway's entries are raw's rows one for one (a
// partial list: its first rows), or else the rows shown one for one (dates read after a Remove whose re-read hasn't come
// yet), so a song in the playlist twice keeps each add's own date; else uri -> the latest date among its entries (a playlist
// changed since).
static BOOL ENAddedAligned(NSArray *rows, NSArray *entries) {
	BOOL aligned = rows.count > 0 && rows.count <= entries.count;
	for (NSUInteger i = 0; aligned && i < rows.count; i++)
		if (![[(ENTrack *)rows[i] uri] isEqualToString:[(NSArray *)entries[i] objectAtIndex:0]]) aligned = NO;
	return aligned;
}

static NSArray *ENAddedTimes(NSArray *tracks, NSArray *raw, NSArray *entries) {
	NSArray *base = ENAddedAligned(raw, entries) ? raw : ENAddedAligned(tracks, entries) ? tracks : nil;
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:tracks.count];
	NSMutableDictionary *latest = nil;
	NSUInteger j = 0;
	for (ENTrack *t in tracks) {
		NSNumber *ms = nil;
		if (base) {
			while (j < base.count && base[j] != t) j++;
			if (j < base.count) ms = [(NSArray *)entries[j++] objectAtIndex:1];
		}
		if (!ms) {
			if (!latest) {
				latest = [NSMutableDictionary dictionaryWithCapacity:entries.count];
				for (NSArray *e in entries) {
					NSString *u = e[0];
					NSNumber *n = e[1];
					if (u.length && [n longLongValue] > [(NSNumber *)latest[u] longLongValue]) latest[u] = n;
				}
			}
			ms = t.uri ? latest[t.uri] : nil;
		}
		[out addObject:ms ?: @0];
	}
	return out;
}

// (0.9.4) tracks by date added (times: ENAddedTimes, one per track), newest or oldest first; ties keep the list's order. Rows
// without a date (0 / none) and Loading… / Unavailable rows go after them, in the list's order.
static NSArray *ENSortedByDate(NSArray *tracks, NSArray *times, BOOL newest) {
	NSMutableArray *rows = [NSMutableArray arrayWithCapacity:tracks.count];
	NSMutableArray *rest = [NSMutableArray array];
	NSUInteger i = 0;
	for (ENTrack *t in tracks) {
		NSUInteger at = i++;
		long long ms = at < times.count ? [(NSNumber *)times[at] longLongValue] : 0;
		if (!t.playable || ms <= 0) { [rest addObject:t]; continue; }
		ENSortRow *r = [ENSortRow new];
		r.track = t;
		r.index = at;
		r.added = ms;
		[rows addObject:r];
	}
	[rows sortUsingComparator:^NSComparisonResult(ENSortRow *a, ENSortRow *b) {
		if (a.added != b.added) {
			BOOL first = newest ? a.added > b.added : a.added < b.added;
			return first ? NSOrderedAscending : NSOrderedDescending;
		}
		return a.index < b.index ? NSOrderedAscending : a.index > b.index ? NSOrderedDescending : NSOrderedSame;
	}];
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:tracks.count];
	for (ENSortRow *r in rows) [out addObject:r.track];
	[out addObjectsFromArray:rest];
	return out;
}

// (0.9.4) Liked Songs, Date added (oldest first): its own order (newest first) backwards; Loading… / Unavailable rows after
// them in their order, as for the other sorts
static NSArray *ENReversedTracks(NSArray *tracks) {
	NSMutableArray *out = [NSMutableArray arrayWithCapacity:tracks.count];
	for (ENTrack *t in [tracks reverseObjectEnumerator]) if (t.playable) [out addObject:t];
	for (ENTrack *t in tracks) if (!t.playable) [out addObject:t];
	return out;
}

#pragma mark - songs removed from a playlist (0.9.2)

// (0.9.2, DESIGN-0.9.2 §1) Songs removed from a playlist that a copy of the list may still hold: the catalog keeps the copy
// it had (memory and disk) until the gateway's re-read comes back, and hands it out again on every load. playlist uri ->
// song uri -> NSNull while the remove runs, then the NSDate of its answer. Every copy a screen shows has them taken out. A
// network copy of the whole list settles an answered one when it no longer has the song, or was asked for after the answer
// (the server's word then, even with the song back: added again elsewhere). Shared by the screens, so the playlist opened
// again meanwhile doesn't show the song either. Main thread.
static NSMutableDictionary *sRemoved;

// A remove started or failed: every other page of that playlist shows its copy again less the songs (the page that did it
// redraws itself, with the fade). object: that page (nil once it has gone); userInfo ENRemovalListKey: the playlist uri.
static NSString *const ENRemovalsChangedNotification = @"ENRemovalsChangedNotification";
static NSString *const ENRemovalListKey = @"list";

static void ENPostRemovalsChanged(NSString *listURI, id from) {
	[[NSNotificationCenter defaultCenter] postNotificationName:ENRemovalsChangedNotification object:from
	                                                  userInfo:@{ ENRemovalListKey: listURI }];
}

static void ENRemovalBegan(NSString *listURI, NSString *uri, id from) {
	if (!sRemoved) sRemoved = [NSMutableDictionary dictionary];
	NSMutableDictionary *m = sRemoved[listURI];
	if (!m) sRemoved[listURI] = m = [NSMutableDictionary dictionary];
	m[uri] = [NSNull null];
	ENPostRemovalsChanged(listURI, from);
}

// ok: the gateway has it (kept until a copy settles it); a failure forgets it (the rows come back)
static void ENRemovalAnswered(NSString *listURI, NSString *uri, BOOL ok, id from) {
	NSMutableDictionary *m = sRemoved[listURI];
	if (!m) return;
	if (ok) m[uri] = [NSDate date];
	else [m removeObjectForKey:uri];
	if (!m.count) [sRemoved removeObjectForKey:listURI];
	if (!ok) ENPostRemovalsChanged(listURI, from);
}

// a network copy (asked = when the screen asked for it)
static void ENSettleRemovals(NSString *listURI, ENTrackList *l, NSDate *asked) {
	NSMutableDictionary *m = sRemoved[listURI];
	if (!m || !l.done || l.stale) return;
	for (NSString *uri in [m allKeys]) {
		NSDate *at = m[uri];
		if (![at isKindOfClass:[NSDate class]]) continue;          // still running
		if ([l indexOfURI:uri] == NSNotFound || (asked && [asked compare:at] != NSOrderedAscending)) [m removeObjectForKey:uri];
	}
	if (!m.count) [sRemoved removeObjectForKey:listURI];
}

static ENTrackList *ENWithoutRemoved(ENTrackList *l, NSString *listURI) {
	NSDictionary *m = sRemoved[listURI];
	return m.count ? [l listByRemovingURIs:[NSSet setWithArray:[m allKeys]]] : l;
}

#pragma mark - header view

// The list header: the cover block (136 pt or more) + the description strip, drawn in one pass; the Play / Shuffle buttons,
// the link's tap target and (albums) the Save pill are the only subviews. It changes rarely (opened-from row, then the
// answer's h), never while scrolling.
// (0.11, DESIGN-5 §2.2 "Notes from 0.10.0": "the play and shuffle buttons sometimes overlap the title") The button row
// used to sit at a fixed y 94, while a 2-line title + the link + the meta line reach ~92-96, so the meta line (and with it
// the text) ran under the buttons. Now -relayout measures the text column and the buttons go below it: at their resting
// place when the text ends 8 pt or more above it (every 1-line title), else 8 pt under the meta line, the block growing to
// 14 pt under them (the gradient, the bottom line and the description strip follow; the controller re-sets the
// tableHeaderView on a new -heightForDesc:). The title keeps its 2-line cap with the second line truncated.
// (3c, DESIGN-5 §2.3 C2; the mockup's .hdr) The same measured layout with the 1.0 look: 34 pt buttons from the C7 kit
// (+[ENTheme configureButton:…]): Play = the green gbtn with the .pi disc at its natural width, Shuffle = an icon-only 38 pt
// silver button, and on albums the Save pill (38 pt silver, an outlined heart, the filled #3fae3a heart while saved) after
// it, 6 pt apart: Play ~75 + 6 + 38 + 6 + 38 = ~163 pt fits the 175 pt text column. The text column follows the mockup's
// spacing (the title 2 pt under the cover's top, the link 3 pt under the title, the meta line 2 pt under the link: +2/+3/+2),
// the link in linkFont (Bold 15) and accent, the meta line in metaFont (13); every colour and font is an ENTheme token.
@interface ENListHeaderView : UIView
@property (nonatomic, copy) NSString *title, *link, *meta, *desc;
@property (nonatomic, strong) UIImage *image;
@property (nonatomic, readonly) UIButton *playButton, *shuffleButton, *linkButton, *saveButton;
@property (nonatomic, readonly) CGFloat blockHeight;     // (0.11) the cover block as last laid out: >= ENHeaderTop
- (CGFloat)heightForDesc:(NSString *)desc;  // the whole header for the title / link it has now and this description
- (void)relayout;
- (UIButton *)addSaveButton;        // (3c) albums: the Save pill at the right of Shuffle (0.9: the ♥ at the row's right end)
@end

@implementation ENListHeaderView {
	CGRect _titleRect, _linkRect, _metaRect;
	CGFloat _buttonsY;              // (0.11) the button row's top, from -relayout
	CGFloat _playWidth;             // (3c) Play's natural width (C7's padding round the disc and "Play")
}

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		ENTheme *th = [ENTheme current];
		self.opaque = YES;
		self.backgroundColor = th.listBackground;
		self.contentMode = UIViewContentModeRedraw;
		CGFloat x = ENHeaderTextX, y = ENHeaderPad + ENHeaderCover - ENHeaderButtonH;      // (y: -relayout places the row)
		_playButton = [self buttonWithStyle:ENButtonStyleGreen title:ENL(@"Play") glyph:ENButtonGlyphPlayDisc
		                              frame:CGRectMake(x, y, 80, ENHeaderButtonH)];
		_playWidth = ceilf([_playButton sizeThatFits:CGSizeZero].width);
		_shuffleButton = [self buttonWithStyle:ENButtonStyleSilver title:nil glyph:@"shuffle"
		                                 frame:CGRectMake(x + _playWidth + ENHeaderButtonGap, y, ENHeaderIconW, ENHeaderButtonH)];
		_shuffleButton.accessibilityLabel = ENL(@"Shuffle");
		_linkButton = [UIButton buttonWithType:UIButtonTypeCustom];
		_linkButton.hidden = YES;
		[self addSubview:_linkButton];
		[self relayout];
	}
	return self;
}

// a C7 gbtn (its height set before +configureButton:…, which sizes the images and the font by it)
- (UIButton *)buttonWithStyle:(ENButtonStyle)style title:(NSString *)title glyph:(NSString *)glyph frame:(CGRect)f {
	UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
	b.frame = f;
	[ENTheme configureButton:b style:style title:title glyph:glyph];
	[self addSubview:b];
	return b;
}

// (3c) The album's Save pill (DESIGN-5 §2.3 C2; was the 0.9 ♥ at the row's right end): a 38 pt silver icon button after
// Shuffle. Not saved: the outlined heart (heartO) in the silver text colour, as the mockup's Save; saved (`selected`, which
// the controller sets from the catalog's state): the filled heart in heartSaved (#3fae3a). The pressed look is C7's.
- (UIButton *)addSaveButton {
	if (_saveButton) return _saveButton;
	ENTheme *th = [ENTheme current];
	_saveButton = [self buttonWithStyle:ENButtonStyleSilver title:nil glyph:nil
	                              frame:CGRectMake(ENHeaderTextX, _buttonsY, ENHeaderIconW, ENHeaderButtonH)];
	UIImage *off = [th glyphNamed:@"heartO" size:ENHeaderIconPt color:th.silverText];
	UIImage *on = [th glyphNamed:@"heart" size:ENHeaderIconPt color:th.heartSaved];
	[_saveButton setImage:off forState:UIControlStateNormal];
	[_saveButton setImage:off forState:UIControlStateHighlighted];
	[_saveButton setImage:on forState:UIControlStateSelected];
	[_saveButton setImage:on forState:UIControlStateSelected | UIControlStateHighlighted];
	_saveButton.exclusiveTouch = YES;
	_saveButton.accessibilityLabel = ENL(@"Save");
	[self placeButtons];
	return _saveButton;
}

// the button row at _buttonsY, left to right from the text column's x, 6 pt apart: Play (its natural width; narrowed only if
// a font fallback made it too wide for the column), Shuffle, and the Save pill on albums
- (void)placeButtons {
	CGFloat x = ENHeaderTextX, y = _buttonsY, room = self.bounds.size.width - x - 12;
	CGFloat icons = (ENHeaderIconW + ENHeaderButtonGap) * (_saveButton ? 2 : 1);
	CGFloat pw = MIN(_playWidth, MAX(ENHeaderIconW * 2, room - icons));
	_playButton.frame = CGRectMake(x, y, pw, ENHeaderButtonH);
	x += pw + ENHeaderButtonGap;
	_shuffleButton.frame = CGRectMake(x, y, ENHeaderIconW, ENHeaderButtonH);
	x += ENHeaderIconW + ENHeaderButtonGap;
	if (_saveButton) _saveButton.frame = CGRectMake(x, y, ENHeaderIconW, ENHeaderButtonH);
}

- (CGFloat)heightForDesc:(NSString *)desc {
	if (!desc.length) return _blockHeight;
	UIFont *df = [ENTheme current].descriptionFont;
	CGFloat w = self.bounds.size.width - 24, maxH = ceilf(df.lineHeight * 3);
	CGFloat h = [desc sizeWithFont:df constrainedToSize:CGSizeMake(w, maxH) lineBreakMode:NSLineBreakByWordWrapping].height;
	return _blockHeight + 9 + ceilf(h) + 10;
}

// The text column (x 133 to 12 pt from the right edge), measured top down: (3c) the title (bigTitleFont, 1-2 lines) from
// y 16 (2 pt under the cover's top), 3 pt, the link line (when there is one), 2 pt, the meta line (always kept, so a count
// arriving late moves nothing). (0.11) Then the button row: at its resting place, its bottom on the cover's (3c: y 88, the
// mockup's .h-btns margin-top auto), when that leaves 8 pt under the meta line, else 8 pt under it (.h-btns padding-top 8);
// the block ends 14 pt under the cover or the row, whichever is lower (>= ENHeaderTop). No header font follows Text size
// (bigTitleFont / linkFont / metaFont are fixed tokens; only the rows follow it), so neither does this layout: it is the same
// at Small, Default and Large. On 320 (column 175; Helvetica Neue lines: title ~23, link ~18, meta ~16): Liked, and a 1-line
// playlist or album, 16+23+3+18+2+16 = 78 keep the row at y 88 and the block at 136 pt; a 2-line (or longer, truncated) title
// with a link 16+46+3+18+2+16 = 101 puts the row at ~109 and the block at ~157. The buttons never reach into the text.
- (void)relayout {
	ENTheme *th = [ENTheme current];
	CGFloat x = ENHeaderTextX, w = self.bounds.size.width - x - 12, y = ENHeaderPad + 2;
	UIFont *tf = th.bigTitleFont;
	CGFloat tH = 0;
	if (_title.length) {
		// room for 2 lines and never a 3rd: lines are measured whole, so a box of exactly 2 x lineHeight can lose the second
		// to rounding (a 2-line title cut to 1); the second of more is truncated where it is drawn (TruncatingTail)
		CGFloat maxH = floorf(tf.lineHeight * 2.5f);
		tH = MIN(maxH, ceilf([_title sizeWithFont:tf constrainedToSize:CGSizeMake(w, maxH) lineBreakMode:NSLineBreakByWordWrapping].height));
	}
	_titleRect = CGRectMake(x, y, w, tH);
	y += tH;
	if (_link.length) {
		y += 3;
		_linkRect = CGRectMake(x, y, w, ceilf(th.linkFont.lineHeight));
		y += _linkRect.size.height;
	} else _linkRect = CGRectZero;
	y += 2;
	_metaRect = CGRectMake(x, y, w, ceilf(th.metaFont.lineHeight));
	y += _metaRect.size.height;
	_buttonsY = MAX(ENHeaderPad + ENHeaderCover - ENHeaderButtonH, ceilf(y) + 8);
	_blockHeight = MAX(ENHeaderTop, _buttonsY + ENHeaderButtonH + ENHeaderPad);
	[self placeButtons];
	CGSize ls = _link.length ? [_link sizeWithFont:th.linkFont forWidth:w lineBreakMode:NSLineBreakByTruncatingTail] : CGSizeZero;
	_linkButton.frame = CGRectMake(x - 4, _linkRect.origin.y - 6, ls.width + 8, _linkRect.size.height + 12);
	[self setNeedsDisplay];
}

- (void)setTitle:(NSString *)title { _title = [title copy]; [self relayout]; }
- (void)setLink:(NSString *)link { _link = [link copy]; [self relayout]; }
- (void)setMeta:(NSString *)meta { _meta = [meta copy]; [self setNeedsDisplay]; }
- (void)setDesc:(NSString *)desc { _desc = [desc copy]; [self setNeedsDisplay]; }
- (void)setImage:(UIImage *)image { _image = image; [self setNeedsDisplay]; }

// (3c) every colour and font from ENTheme's list-header tokens (§1.4 "list header", "cover mat"); Light is 0.11's look
- (void)drawRect:(CGRect)rect {
	ENTheme *th = [ENTheme current];
	CGContextRef c = UIGraphicsGetCurrentContext();
	CGFloat w = self.bounds.size.width;
	[th.listBackground setFill];
	CGContextFillRect(c, self.bounds);

	// background: listHeaderTop -> listHeaderBottom (#f5f8f2 -> #e0e8da), bottom line listHeaderBorder (#bccbb2)
	CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
	NSArray *cols = @[ (__bridge id)th.listHeaderTop.CGColor, (__bridge id)th.listHeaderBottom.CGColor ];
	CGGradientRef g = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)cols, NULL);
	CGFloat top = _blockHeight;        // (0.11) the cover block as laid out (>= 136)
	CGContextDrawLinearGradient(c, g, CGPointZero, CGPointMake(0, top), 0);
	CGGradientRelease(g);
	CGColorSpaceRelease(cs);
	[th.listHeaderBorder setFill];
	CGContextFillRect(c, CGRectMake(0, top - 1, w, 1));

	// the framed cover: the coverMat (white) with its soft shadow (black .35, (0,2), blur 5), the 216-tier image inside
	CGRect frame = CGRectMake(12, ENHeaderPad, ENHeaderCover, ENHeaderCover);
	CGContextSaveGState(c);
	CGContextSetShadowWithColor(c, CGSizeMake(0, 2), th.coverMatShadowBlur, th.coverMatShadow.CGColor);
	[th.coverMat setFill];
	CGContextFillRect(c, frame);
	CGContextRestoreGState(c);
	[(_image ?: th.placeholderLarge) drawInRect:CGRectInset(frame, 3, 3)];

	if (_title.length) {
		[th.listHeaderTitle set];
		[_title drawInRect:_titleRect withFont:th.bigTitleFont lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentLeft];
	}
	if (_link.length) {
		[th.accent set];
		[_link drawAtPoint:_linkRect.origin forWidth:_linkRect.size.width withFont:th.linkFont lineBreakMode:NSLineBreakByTruncatingTail];
	}
	if (_meta.length) {
		[th.listHeaderMeta set];
		[_meta drawAtPoint:_metaRect.origin forWidth:_metaRect.size.width withFont:th.metaFont lineBreakMode:NSLineBreakByTruncatingTail];
	}

	// description strip
	CGFloat h = self.bounds.size.height;
	if (_desc.length && h > top) {
		[th.listHeaderDescBackground setFill];
		CGContextFillRect(c, CGRectMake(0, top, w, h - top));
		[th.listHeaderDescBorder setFill];
		CGContextFillRect(c, CGRectMake(0, h - 1, w, 1));
		[th.listHeaderDescText set];
		[_desc drawInRect:CGRectMake(12, top + 9, w - 24, h - top - 19) withFont:th.descriptionFont
		    lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentLeft];
	}
}

@end

#pragma mark - the screen

@interface ENTrackListViewController () <ENTrackMenuPlaylistScreen, UIActionSheetDelegate>
@end

@implementation ENTrackListViewController {
	ENPlaylist *_pl;                // opened from (playlist)
	ENAlbumRow *_al;                // opened from (album)
	NSString *_initTitle, *_initToken;
	ENLibrary *_library;            // Liked: the count until the list arrives
	NSArray *_rows;                 // what the table shows: list.tracks, or the filtered subset
	NSString *_filter;              // lowercase words, nil = none
	ENCellArt _cellArt;
	UIView *_headerBox;
	ENListHeaderView *_header;
	UISearchBar *_filterBar;
	NSString *_headerToken;         // the cover token shown / loading
	BOOL _stale;                    // a kind list notification came while hidden
	ENTrackList *_update;           // a wait / partial answer that came while _list is done (a re-read): polled, not shown
	NSDate *_pollSince;             // first partial answer of this round
	BOOL _gaveUp;
	NSString *_removingURI;         // a Liked swipe "Remove" in progress (animated row delete)
	UIButton *_heart;               // (0.9) albums: the header's ♥ (Your Library; 3c: the Save pill); nil on other lists
	BOOL _heartSaved;               // what it shows (unknown = not saved)
	ENTrackList *_listRaw;          // (0.9.2) the catalog's copy behind _list (_list = it less the songs being removed)
	ENSortMode _sort;               // (0.9.2) the Sort choice (playlists, Liked; albums keep the album's order)
	NSArray *_sortedTracks;         // _list.tracks in Sort order, worked out for _sortedFrom / _sortedMode
	NSArray *_sortedFrom;
	ENSortMode _sortedMode;
	BOOL _rowsPending;              // (0.9.2) hidden: _rows are behind _list until -viewWillAppear: sorts them
	UIImageView *_filterBack;       // the filter row's background, under the bar and the Sort button
	UISegmentedControl *_sortButton;
	UIActionSheet *_sortSheet;      // "Sort by" while it is on screen
	UILabel *_sortNote;             // "Plays in the playlist's own order", under the rows while sorted
	CGFloat _filterY;               // the filter row's top in the header box
	BOOL _filterEditing;            // the filter is being typed in: the bar has the whole row
	NSArray *_sortChoices;          // (0.9.4) "Sort by" while it is on screen: the mode (NSNumber) of each button
	ENSortMode _shownSort;          // (0.9.4) the order the rows are in: _sort, except a playlist's Date added sort whose dates
	                                // aren't here yet (the order shown before stays) or failed (the list's own order)
	NSArray *_sortedDates;          // the dates added _sortedTracks was worked out with (nil: not by date)
	NSArray *_added;                // (0.9.4) this playlist's dates added ([ENCatalog loadAddedDates:]); nil until they come
	NSString *_addedRev;            // _listRaw's revision when they were last asked for
	NSInteger _addedSeq;            // per request: the answer to an older one is dropped
	BOOL _addedLoading;
	BOOL _addedDropped;             // a kind list for this playlist since they were asked for (the catalog dropped its copy)
	BOOL _addedFailed;              // the last request failed: the rows show the list's own order (the choice stays)
	BOOL _addedFinal;               // ... with an answer that won't change by itself (4xx: not_available, an old gateway): asked
	                                // again only on a pull to refresh or when the sort is chosen again
	NSString *_addedErrorText;      // the banner that failure showed
	BOOL _addedSaved;               // _added is the gateway's saved copy (Spotify failed): sorted by, "Showing a saved copy",
	                                // asked again on a pull to refresh or the sort chosen again (the catalog never reuses it)
	UIActivityIndicatorView *_addedSpin;   // in the filter row, left of Sort, while they load
	UIBarButtonItem *_followItem;   // (0.11 profiles, P3) someone else's playlist: Follow / Following; nil when not shown
	BOOL _followGone;               // a 501: the item is gone for the screen's life
}

- (instancetype)initWithKind:(ENListKind)kind uri:(NSString *)uri {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		_kind = kind;
		_listURI = [uri copy];
		_rows = @[];
		_cellArt = kind == ENListAlbum ? ENCellArtNumber : ENCellArtCover;     // (0.9.4) playlists show covers too, like Spotify
		if (kind != ENListAlbum) _sort = ENSavedSort(_listURI);
		if (kind == ENListLiked && _sort == ENSortAddedNewest) _sort = ENSortCustom;     // = Recently added, its own order
		// (0.9.4) a playlist's Date added sort shows the list's own order until its dates come
		_shownSort = kind == ENListPlaylist && ENSortByDate(_sort) ? ENSortCustom : _sort;
	}
	return self;
}

- (instancetype)initWithPlaylist:(ENPlaylist *)pl {
	if ((self = [self initWithKind:ENListPlaylist uri:pl.uri])) {
		_pl = pl;
		self.title = pl.name;
		self.meterName = @"list";              // (R2a: the scroll meter's log line names no playlist)
	}
	return self;
}

- (instancetype)initWithAlbum:(ENAlbumRow *)al {
	if ((self = [self initWithKind:ENListAlbum uri:al.uri])) {
		_al = al;
		self.title = al.name;
		self.meterName = @"album";             // (R2a: no name in the log line)
	}
	return self;
}

- (instancetype)initWithAlbumURI:(NSString *)uri title:(NSString *)title image:(NSString *)token {
	if ((self = [self initWithKind:ENListAlbum uri:uri])) {
		_initTitle = [title copy];
		_initToken = [token copy];
		self.title = title;
		self.meterName = @"album";
	}
	return self;
}

- (instancetype)initWithLikedLibrary:(ENLibrary *)library {
	if ((self = [self initWithKind:ENListLiked uri:ENLikedListURI])) {
		_library = library;
		self.title = ENL(@"Liked Songs");
		self.meterName = @"liked";
	}
	return self;
}

- (void)dealloc {
	_filterBar.delegate = nil;
	_sortSheet.delegate = nil;
}

- (void)viewDidLoad {
	[super viewDidLoad];
	// (R2a) Anonymous Mode switched: the header's title, owner line, description and cover follow it (the rows reload with
	// the lists' theme note)
	[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(anonChanged) name:ENAnonChangedNotification object:nil];
	CGFloat w = self.tableView.bounds.size.width;
	_header = [[ENListHeaderView alloc] initWithFrame:CGRectMake(0, 0, w, ENHeaderTop)];
	[_header.playButton addTarget:self action:@selector(tapPlay) forControlEvents:UIControlEventTouchUpInside];
	[_header.shuffleButton addTarget:self action:@selector(tapShuffle) forControlEvents:UIControlEventTouchUpInside];
	[_header.linkButton addTarget:self action:@selector(tapLink) forControlEvents:UIControlEventTouchUpInside];
	if (_kind == ENListAlbum) {
		_heart = [_header addSaveButton];          // (3c) the Save pill (was the 0.9 ♥); the same toggle
		[_heart addTarget:self action:@selector(tapHeart) forControlEvents:UIControlEventTouchUpInside];
		[self updateHeart:NO];
	}
	_filterBar =[[UISearchBar alloc] initWithFrame:CGRectMake(0, ENHeaderTop, w, 44)];
	_filterBar.backgroundImage = [ENTheme current].filterBarBackground;
	_filterBar.tintColor = [ENTheme current].filterButtonTint;       // (3c: the token, #8fa880 as before)
	_filterBar.placeholder = ENL(@"Filter");
	_filterBar.autocorrectionType = UITextAutocorrectionTypeNo;
	_filterBar.autocapitalizationType = UITextAutocapitalizationTypeNone;
	_filterBar.delegate = self;
	_headerBox = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, ENHeaderTop + 44)];
	_headerBox.backgroundColor = [ENTheme current].listBackground;
	[_headerBox addSubview:_header];
	if (_kind != ENListAlbum) {      // 0.9.2: Sort at the right end of the filter row, on the bar's own background
		_filterBack = [[UIImageView alloc] initWithImage:[ENTheme current].filterBarBackground];
		[_headerBox addSubview:_filterBack];
	}
	[_headerBox addSubview:_filterBar];
	if (_filterBack) {
		// a one-segment momentary bar-style control: the look of the bar's own Cancel button (same tint)
		_sortButton = [[UISegmentedControl alloc] initWithItems:@[ ENL(@"Sort") ]];
		_sortButton.segmentedControlStyle = UISegmentedControlStyleBar;
		_sortButton.tintColor = [ENTheme current].filterButtonTint;     // (3c: the token by name; the same value as the bar's)
		_sortButton.momentary = YES;
		[_sortButton addTarget:self action:@selector(tapSort) forControlEvents:UIControlEventValueChanged];
		[_headerBox addSubview:_sortButton];
		[self updateSortButton];
	}
	_filterY = ENHeaderTop;
	[self layoutFilterRow];
	if (_kind == ENListPlaylist) {     // (0.9.2) removes started / failed on another page of it (the base's dealloc unregisters)
		[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(removalsChanged:)
		                                             name:ENRemovalsChangedNotification object:nil];
	}
	[self updateHeader];
	[self updateState];
	[self reload:NO];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	if (_rowsPending) {                            // (0.9.2) the list changed while hidden: sorted now, once
		[self rebuildRowsAnimatingFrom:nil];
		[self updateState];
	}
	if (_stale) [self reload:NO];
	[self syncAddedDates];                         // (0.9.4) dates added dropped while hidden (a no-op otherwise)
	if (_heart) [[ENCatalog shared] checkAlbumSaved:_listURI done:nil];      // an answer that changes it posts kind albums
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	if (_filterBar.isFirstResponder) [_filterBar resignFirstResponder];
}

#pragma mark - loading

- (void)reload:(BOOL)fresh {
	_stale = NO;
	if (fresh) {
		_pollSince = nil;
		_gaveUp = NO;
		[self hideBanner];
		if ((_addedFailed || _addedSaved) && [self wantsAddedDates]) {   // (0.9.4) a pull to refresh tries the dates added
			_addedFailed = NO;                                           // again too (failed, or a saved copy)
			_addedFinal = NO;
			_addedDropped = YES;
			[self syncAddedDates];
		}
	}
	if (!_list) [self performSelector:@selector(showLoading) withObject:nil afterDelay:0.25];   // only if no cached copy comes
	__weak ENTrackListViewController *w = self;
	NSDate *asked = [NSDate date];
	[[ENCatalog shared] loadList:_listURI fresh:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENTrackListViewController *s = w;
		if (!s) return;
		[NSObject cancelPreviousPerformRequestsWithTarget:s selector:@selector(showLoading) object:nil];
		if (error) { [s loadFailed:error]; return; }
		if (!fromCache) [s finishRefreshing];
		if (![result isKindOfClass:[ENTrackList class]]) return;
		if (!fromCache) ENSettleRemovals(s->_listURI, result, asked);
		if (result != s->_listRaw && result != s->_update) [s applyList:result patch:NO];
	}];
}

- (void)showLoading {
	if (!_list) [self setBusy:YES];
}

- (void)loadFailed:(NSError *)error {
	[self finishRefreshing];
	[self showError:error];
	NSTimeInterval ra = [ENCatalog retryAfterOfError:error];
	if (!_list) {
		[self setBusy:NO];
		[self setEmptyTitle:ENL(@"Couldn't load these songs.") message:ENL(@"Pull to refresh.")];     // (3c: title / body)
		if (ra > 0 && !_gaveUp) [self schedulePoll:ra];        // e.g. 503 busy / listing_off: try again then (-poll reloads)
	} else {
		ENTrackList *cur = _update ?: _list;
		if (!cur.done && !_gaveUp) [self schedulePoll:MAX(ra, cur.retry)];
	}
}

- (void)poll {
	if (_gaveUp) return;
	if (!_list) { [self reload:NO]; return; }
	ENTrackList *cur = _update ?: _list;           // what is being read: the shown list, or the re-read of a done one
	if (cur.done) return;
	if (_pollSince && -[_pollSince timeIntervalSinceNow] > ENGiveUpAfter) { [self giveUp]; return; }
	[self schedulePoll:MAX(cur.retry, 1)];         // pollList calls nothing back on a 304, so the next poll is set now
	__weak ENTrackListViewController *w = self;
	NSDate *asked = [NSDate date];
	[[ENCatalog shared] pollList:_listURI done:^(id result, BOOL fromCache, NSError *error) {
		ENTrackListViewController *s = w;
		if (!s) return;
		if (error) {
			NSTimeInterval ra = [ENCatalog retryAfterOfError:error];
			if (ra > 0 && !s->_gaveUp) [s schedulePoll:ra];
			return;
		}
		if (![result isKindOfClass:[ENTrackList class]]) return;
		ENSettleRemovals(s->_listURI, result, asked);
		if (result != s->_listRaw && result != s->_update) [s applyList:result patch:NO];
	}];
}

- (void)giveUp {
	_gaveUp = YES;
	[self cancelPoll];
	[self setBusy:NO];
	self.footerBusy = NO;
	[self showBanner:ENGiveUpText];
}

// patch NO: an answer from the catalog (cached or network); YES: a local like patch (Liked's likedList, a swipe Remove).
// The gateway answers wait / partial for a list the phone already has in full whenever it re-reads it (pull to refresh,
// a like on another device, our own add, a new revision): the full rows and the filter stay, the footer says "Updating…" and the
// screen polls the re-read until its done answer swaps in. A partial patch for a done list is dropped the same way.
// (0.9.2) What shows is the list less the songs being removed from this playlist (sRemoved); _listRaw keeps the copy itself.
- (void)applyList:(ENTrackList *)list patch:(BOOL)patch {
	if (_list.done && !list.done) {
		if (!patch) [self noteUpdate:list];
		return;
	}
	if (!patch) _update = nil;                     // the server's whole list ends a re-read
	NSArray *old = _rows, *was = _list.tracks;
	_listRaw = list;
	_list = ENWithoutRemoved(list, _listURI);
	if (patch) [self keepSortedFrom:was dropping:_removingURI];      // a Liked swipe Remove: no new sort before the fade
	if (!list.done && !_pollSince) _pollSince = [NSDate date];
	if (list.done && !_update) {                   // this round is over: its give-up no longer applies
		_pollSince = nil;
		_gaveUp = NO;
		[self hideBannerIfShowing:ENGiveUpText];
	}
	[self rebuildRowsAnimatingFrom:old];
	[self updateHeader];
	[self updateState];
	if (list.done) {
		if (!_update) [self cancelPoll];
	} else if (!_gaveUp) [self pollAgain:list];
	if (list.stale && list.done) [self showBanner:ENSavedCopyText];
	else if (!list.stale && !(_addedSaved && [self sortDates])) [self hideBannerIfShowing:ENSavedCopyText];   // a later good
	                                               // answer clears it (errors stay; and while sorted by saved dates added)
	[self syncAddedDates];                         // (0.9.4) a new revision, or the catalog dropped its dates: ask again
}

- (void)noteUpdate:(ENTrackList *)list {
	_update = list;
	if (!_pollSince) _pollSince = [NSDate date];
	[self updateState];
	if (!_gaveUp) [self pollAgain:list];
}

// the next poll of a partial round, or the give-up after 2 minutes
- (void)pollAgain:(ENTrackList *)list {
	if (_pollSince && -[_pollSince timeIntervalSinceNow] > ENGiveUpAfter) [self giveUp];
	else [self schedulePoll:MAX(list.retry, 1)];
}

// rows = the list's tracks in the Sort order through the filter; a Liked "Remove" or a Remove from This Playlist deletes the
// song's rows (every copy of it: 0.9.2) with a fade. (0.9.2) A hidden page whose rows would need a new sort (a sorted
// Liked Songs under Now Playing, patched at every ♥) keeps the rows the table has and sorts once when it shows again.
- (void)rebuildRowsAnimatingFrom:(NSArray *)old {
	if (self.isViewLoaded && !self.visible && [self needsSort]) {
		_rowsPending = YES;
		_removingURI = nil;
		return;
	}
	_rowsPending = NO;
	_rows = [self filtered:[self sortedTracks]];
	if (!self.isViewLoaded) return;
	NSString *gone = _removingURI;
	_removingURI = nil;
	if (gone) {
		NSMutableArray *ips = [NSMutableArray array];
		NSUInteger i = 0;
		for (ENTrack *t in old) {
			if ([t.uri isEqualToString:gone]) [ips addObject:[NSIndexPath indexPathForRow:(NSInteger)i inSection:0]];
			i++;
		}
		NSUInteger j = [_rows indexOfObjectPassingTest:^BOOL(ENTrack *t, NSUInteger idx, BOOL *stop) { return [t.uri isEqualToString:gone]; }];
		if (ips.count && j == NSNotFound && _rows.count + ips.count == old.count) {
			[self.tableView deleteRowsAtIndexPaths:ips withRowAnimation:UITableViewRowAnimationFade];
			return;
		}
	}
	[self.tableView reloadData];
}

// (0.9.4) the dates added the rows are sorted with: a playlist shown by Date added (nil otherwise)
- (NSArray *)sortDates {
	return _kind == ENListPlaylist && ENSortByDate(_shownSort) ? _added : nil;
}

// the rows shown would need a new sort (another list, order or dates added)
- (BOOL)needsSort {
	NSArray *tracks = _list.tracks;
	return _shownSort != ENSortCustom && tracks.count > 1 &&
		(tracks != _sortedFrom || _shownSort != _sortedMode || [self sortDates] != _sortedDates);
}

// (0.9.2) the list's rows in the Sort order (worked out once per list and choice; 0.9.4: and dates added). The order is
// _shownSort's: a playlist's Date added sort only once its dates are here.
- (NSArray *)sortedTracks {
	NSArray *tracks = _list.tracks;
	if (!tracks) return @[];
	if (_shownSort == ENSortCustom || tracks.count < 2) return tracks;
	NSArray *dates = [self sortDates];
	BOOL byDate = _kind == ENListPlaylist && ENSortByDate(_shownSort);
	if (byDate && !dates) return tracks;           // (not shown without them)
	if ([self needsSort]) {
		if (byDate) _sortedTracks = ENSortedByDate(tracks, ENAddedTimes(tracks, _listRaw.tracks, dates), _shownSort == ENSortAddedNewest);
		else if (ENSortByDate(_shownSort)) _sortedTracks = ENReversedTracks(tracks);    // Liked, oldest first
		else _sortedTracks = ENSortedTracks(tracks, _shownSort);
		_sortedFrom = tracks;
		_sortedMode = _shownSort;
		_sortedDates = dates;
	}
	return _sortedTracks;
}

// (0.9.2) _list became `was` less every row of uri (a Remove from This Playlist, a Liked swipe Remove): the sorted rows
// worked out for `was` lose those rows too, without a new sort. Anything more changed (another song gone or back): they
// stay keyed to `was`, so -sortedTracks sorts again.
- (void)keepSortedFrom:(NSArray *)was dropping:(NSString *)uri {
	if (!uri || !_sortedTracks || _sortedFrom != was) return;
	NSArray *now = _list.tracks;
	NSUInteger j = 0;
	for (ENTrack *t in was) {
		if ([t.uri isEqualToString:uri]) continue;
		if (j >= now.count || now[j] != t) return;
		j++;
	}
	if (j != now.count) return;
	NSMutableArray *keep = [NSMutableArray arrayWithCapacity:_sortedTracks.count];
	for (ENTrack *t in _sortedTracks) if (![t.uri isEqualToString:uri]) [keep addObject:t];
	_sortedTracks = keep;
	_sortedFrom = now;
}

- (NSArray *)filtered:(NSArray *)tracks {
	if (!tracks) return @[];
	if (!_filter.length) return tracks;
	NSArray *words = [_filter componentsSeparatedByCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
	NSMutableArray *out = [NSMutableArray array];
	for (ENTrack *t in tracks) {
		NSString *k = t.filterKey;
		BOOL all = k.length > 0;
		for (NSString *wd in words) if (wd.length && [k rangeOfString:wd].location == NSNotFound) { all = NO; break; }
		if (all) [out addObject:t];
	}
	return out;
}

// spinner / footer / empty text / filter availability for the current list
- (void)updateState {
	ENTrackList *l = _list;
	if (!l) {
		self.footerText = nil;
		self.footerBusy = NO;
		[self setFilterEnabled:NO];
		return;
	}
	[self setEmptyTitle:nil message:nil];
	if (l.wait) {
		[self setBusy:!_gaveUp];
		self.footerText = nil;
		self.footerBusy = NO;
	} else if (!l.done) {
		[self setBusy:NO];
		self.footerBusy = !_gaveUp;
		self.footerText = l.length >= 0 ? [NSString stringWithFormat:ENL(@"Loading songs… %@ of %@"), ENGrouped(l.have), ENGrouped(l.length)]
		                                : [NSString stringWithFormat:ENL(@"Loading songs… %@"), ENGrouped(l.have)];
	} else {
		[self setBusy:NO];
		BOOL updating = _update && !(_filter.length && !_rows.count);     // (a filter with no match says so instead)
		self.footerBusy = updating && !_gaveUp;
		if (updating) {
			self.footerText = [self updatingText];
		} else if (l.length == 0 || !l.tracks.count) {
			self.footerText = nil;
			// (3c) the mockup's empty playlist: "No songs yet" over how to add some, on a playlist that can take them; Liked,
			// albums and other people's playlists keep the title alone
			[self setEmptyTitle:ENL(@"No songs yet")
			            message:([self editablePlaylist] ? ENL(@"Find songs in Search, tap ••• and choose “Add to Playlist…”.") : nil)];
		} else {
			NSString *f;
			if (_kind == ENListAlbum) {
				f = [self copyrightLine];          // (3c) "℗ <year> <label>" (nil: none), no longer the header's meta again
			} else {
				f = ENCountText(l.length, ENL(@"song"), ENL(@"songs"));
				if (l.totalMs > 0) f = [NSString stringWithFormat:@"%@, %@", f, ENDurationText(l.totalMs)];
			}
			if (l.truncated) f = f ? [NSString stringWithFormat:@"%@ · %@", f, ENL(@"Showing the first 5,000 songs")] : ENL(@"Showing the first 5,000 songs");
			if (_filter.length && !_rows.count) f = ENL(@"No matching songs");
			self.footerText = f;
		}
	}
	[self setFilterEnabled:l.done && l.tracks.count > 0];
}

// the re-read of a done list, under its full rows
- (NSString *)updatingText {
	ENTrackList *u = _update;
	if (u.wait) return ENL(@"Updating…");
	return u.length >= 0 ? [NSString stringWithFormat:ENL(@"Updating… %@ of %@"), ENGrouped(u.have), ENGrouped(u.length)]
	                     : [NSString stringWithFormat:ENL(@"Updating… %@"), ENGrouped(u.have)];
}

- (void)setFilterEnabled:(BOOL)on {
	_filterBar.userInteractionEnabled = on;
	_filterBar.alpha = on ? 1 : 0.55f;
	_sortButton.userInteractionEnabled = on;       // (0.9.2) Sort goes with the filter: a done list with songs
	if (!_filterEditing) _sortButton.alpha = on ? 1 : 0.55f;
}

#pragma mark - filter row and Sort (0.9.2, DESIGN-0.9.2 §2)

// The filter row: the bar, and on playlists / Liked the Sort button at its right end on the same background. While the
// filter is being typed in, the bar takes the whole row (its Cancel button needs the room) and Sort fades out.
- (void)layoutFilterRow {
	CGFloat w = _headerBox.bounds.size.width, y = _filterY;
	if (!_sortButton) {
		_filterBar.frame = CGRectMake(0, y, w, 44);
		return;
	}
	_filterBack.frame = CGRectMake(0, y, w, 44);
	CGFloat sw = _sortButton.bounds.size.width, x = w - 7 - sw;
	_sortButton.frame = CGRectMake(x, y + 7, sw, 30);
	_sortButton.alpha = _filterEditing ? 0 : (_sortButton.userInteractionEnabled ? 1 : 0.55f);
	// (0.9.4) the dates added loading: a small spinner just left of Sort (the bar gives it the room)
	BOOL spin = _addedSpin.isAnimating && !_filterEditing;
	if (_addedSpin) {
		_addedSpin.center = CGPointMake(x - 14, y + 22);
		_addedSpin.alpha = spin ? 1 : 0;
	}
	_filterBar.frame = CGRectMake(0, y, _filterEditing ? w : (spin ? x - 27 : x - 1), 44);
}

// (0.9.4) the filter row's spinner follows the dates added request (a playlist sorted by Date added)
- (void)updateAddedSpinner {
	BOOL on = _addedLoading && [self wantsAddedDates];
	if (!_sortButton || on == _addedSpin.isAnimating) return;
	if (!_addedSpin) {
		_addedSpin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:[ENTheme current].spinnerStyle];   // (Gray)
		_addedSpin.hidesWhenStopped = YES;
		[_headerBox insertSubview:_addedSpin aboveSubview:_filterBack];
	}
	if (on) [_addedSpin startAnimating];
	else [_addedSpin stopAnimating];
	[self layoutFilterRow];
}

// "Sort" for the list's own order, else "Sort: Title" (the button fits its title; 0.9.4: "Sort: Newest first")
- (void)updateSortButton {
	if (!_sortButton) return;
	NSString *t = _sort == ENSortCustom ? ENL(@"Sort") : [NSString stringWithFormat:ENL(@"Sort: %@"), ENSortButtonName(_sort)];
	[_sortButton setTitle:t forSegmentAtIndex:0];
	CGFloat tw = ceilf([t sizeWithFont:[ENTheme fontOfSize:12 bold:YES]].width);   // (3c: P2; Helvetica Neue measures a
	                                                                                // hair wider than the control's font: no cut)
	CGRect f = _sortButton.frame;
	f.size = CGSizeMake(MAX(54, tw + 24), 30);
	_sortButton.frame = f;
}

- (void)setFilterEditing:(BOOL)editing {
	if (_filterEditing == editing) return;
	_filterEditing = editing;
	if (!_sortButton) return;
	[UIView animateWithDuration:0.25 animations:^{
		[self layoutFilterRow];
	}];
}

// "Sort by": the choices with a check on the current one (playlists: Custom order, Title, Artist, Album, Date added (newest
// first), Date added (oldest first); Liked: Recently added, Title, Artist, Album, Date added (oldest first)), from the tab bar
// as the ••• sheets are
- (void)tapSort {
	if (_sortSheet || !_list) return;
	// (0.10, Drop 3a) the green sheet (ENSheets); the delegate, ✓ title, buttons and one-at-a-time guard are unchanged
	UIActionSheet *sheet = [[ENActionSheet alloc] initWithTitle:ENL(@"Sort by") delegate:self cancelButtonTitle:nil destructiveButtonTitle:nil
	                                          otherButtonTitles:nil];
	NSMutableArray *modes = [NSMutableArray array];
	for (NSUInteger i = ENSortCustom; i < ENSortCount; i++) {
		if (i == ENSortAddedNewest && _kind == ENListLiked) continue;     // that is Recently added, Liked's own order
		NSString *name = i == ENSortCustom && _kind == ENListLiked ? ENL(@"Recently added") : ENSortName((ENSortMode)i);
		[sheet addButtonWithTitle:(i == (NSUInteger)_sort ? [@"✓ " stringByAppendingString:name] : name)];
		[modes addObject:@(i)];
	}
	sheet.cancelButtonIndex = [sheet addButtonWithTitle:ENL(@"Cancel")];
	sheet.actionSheetStyle = UIActionSheetStyleBlackTranslucent;
	_sortSheet = sheet;
	_sortChoices = modes;
	UITabBarController *tabs = self.tabBarController;
	if (tabs.view.window) [sheet showFromTabBar:tabs.tabBar];
	else [sheet showInView:self.view];
}

- (void)actionSheet:(UIActionSheet *)sheet didDismissWithButtonIndex:(NSInteger)index {
	if (sheet != _sortSheet) return;
	_sortSheet.delegate = nil;
	_sortSheet = nil;
	NSArray *modes = _sortChoices;
	_sortChoices = nil;
	if (index < 0 || index == sheet.cancelButtonIndex || (NSUInteger)index >= modes.count) return;
	[self setSort:(ENSortMode)[(NSNumber *)modes[(NSUInteger)index] intValue]];
}

// remembered per list; the rows (and the filter on them) follow at once — (0.9.4) a playlist's Date added once its dates are
// here: until then the rows keep the order they are in (the filter row's spinner). Chosen again after its dates failed: they
// are asked for again.
- (void)setSort:(ENSortMode)mode {
	BOOL retry = mode == _sort && (_addedFailed || _addedSaved) && [self wantsAddedDates];
	if (mode == _sort && !retry) return;
	_sort = mode;
	NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
	if (mode == ENSortCustom) [ud removeObjectForKey:ENSortDefaultsKey(_listURI)];
	else [ud setObject:ENSortKeys[mode] forKey:ENSortDefaultsKey(_listURI)];
	[self updateSortButton];
	if ([self wantsAddedDates]) {
		_addedFailed = NO;
		_addedFinal = NO;
		if (_addedErrorText) [self hideBannerIfShowing:_addedErrorText];
		if (_addedSaved) _addedDropped = YES;     // a saved copy: asked for again (sorted by it meanwhile, and said so)
		if (_added) _shownSort = mode;            // here already (of an older revision: asked again below, sorted meanwhile)
		if (_added && _addedSaved) [self showBanner:ENSavedCopyText];
		[self syncAddedDates];
	} else {
		_shownSort = mode;
		if (_addedErrorText) [self hideBannerIfShowing:_addedErrorText];
		if (_addedSaved && !_listRaw.stale) [self hideBannerIfShowing:ENSavedCopyText];
	}
	[self updateAddedSpinner];
	[self layoutFilterRow];
	_rows = [self filtered:[self sortedTracks]];
	[self.tableView reloadData];
	[self updateState];
}

// (0.9.2) under the rows while a Sort other than the list's own order is on: tapping a row still plays the list from that
// song in its own order (the engine plays a context only in its order), so the screen says so (0.9.4: while the rows are in
// another order: not for a Date added sort still waiting for its dates, or showing the list's own order after they failed)
- (BOOL)showsSortNote {
	return _shownSort != ENSortCustom && _rows.count > 0;
}

#pragma mark - dates added (0.9.4, DESIGN-DATE-ADDED)

// a playlist sorted by Date added (Liked's oldest first is its own order backwards: no dates)
- (BOOL)wantsAddedDates {
	return _kind == ENListPlaylist && ENSortByDate(_sort);
}

// Asks for the dates added when the rows need them and the ones here don't fit the list any more: none yet, the list is at
// another revision than when they were asked for, or the catalog dropped its copy (a kind list). Not after a failure for the
// same revision (nor after a 4xx at all) until a pull to refresh or the sort chosen again; a saved copy likewise (they set
// _addedDropped). While a request runs, its answer calls this again.
- (void)syncAddedDates {
	if (![self wantsAddedDates] || !_listRaw || _addedLoading) return;
	BOOL moved = _addedDropped || !ENSame(_listRaw.revision, _addedRev);
	if (_addedFailed ? (_addedFinal || !moved) : (_added && !moved)) return;
	NSInteger seq = ++_addedSeq;
	_addedLoading = YES;
	_addedRev = [_listRaw.revision copy];
	_addedDropped = NO;
	[self updateAddedSpinner];
	__weak ENTrackListViewController *w = self;
	[[ENCatalog shared] loadAddedDates:_listURI done:^(NSArray *entries, NSError *error) {
		ENTrackListViewController *s = w;
		if (s && seq == s->_addedSeq) [s addedDates:entries error:error];
	}];
}

// The answer: the rows sorted by it (kept for later when the sort changed meanwhile). A failure shows the banner and the
// list's own order; the choice stays (Sort still says it). Entries with an error: the gateway's saved copy (sorted by, said so).
- (void)addedDates:(NSArray *)entries error:(NSError *)error {
	_addedLoading = NO;
	BOOL saved = entries && error;
	if (saved) error = nil;
	if (!error && entries == _added && (![self wantsAddedDates] || _shownSort == _sort)) {
		_addedSaved = saved;
		if (saved && [self sortDates]) [self showBanner:ENSavedCopyText];   // still (a pull to refresh took it away)
		[self updateAddedSpinner];                 // the catalog's copy, as the rows already have it
		[self syncAddedDates];
		return;
	}
	BOOL wasSaved = _addedSaved;
	_addedSaved = saved;
	if (error) {
		_added = nil;
		if ([self wantsAddedDates]) {
			_addedFailed = YES;
			NSInteger st = error.code;
			_addedFinal = st >= 400 && st < 500 && st != 408 && st != 429;
			_addedErrorText = [ENCatalog messageForError:error];
			[self showBanner:_addedErrorText];
			_shownSort = ENSortCustom;
		}
	} else {
		_added = entries;
		_addedFailed = NO;
		_addedFinal = NO;
		if (_addedErrorText) [self hideBannerIfShowing:_addedErrorText];
		if ([self wantsAddedDates]) _shownSort = _sort;
		if (saved && [self wantsAddedDates]) [self showBanner:ENSavedCopyText];
		else if (wasSaved && !saved && !_listRaw.stale) [self hideBannerIfShowing:ENSavedCopyText];
	}
	[self updateAddedSpinner];
	[self rebuildRowsAnimatingFrom:nil];
	[self updateState];
	[self syncAddedDates];                         // the list moved on while it ran (a new revision, a change): again
}

#pragma mark - header

- (NSString *)contextURI {
	if (_list.ctx) return _list.ctx;
	if (_kind == ENListLiked) return _library.likedCtx ?: [ENCatalog shared].library.likedCtx;
	return _listURI;
}

- (void)updateHeader {
	if (!_header) return;
	ENTrackList *l = _list;
	NSString *title = nil, *link = nil, *desc = nil, *token = nil;
	NSInteger count = l ? l.length : -1;
	NSInteger year = 0;
	if (_kind == ENListLiked) {
		ENLibrary *lib = _library ?: [ENCatalog shared].library;
		title = ENL(@"Liked Songs");
		link = [self likedOwnerLine:lib];          // (3c) "by <me>": the user's own profile
		if (count < 0) count = lib.likedLength;
	} else if (_kind == ENListPlaylist) {
		ENPlaylist *h = l.playlist.name ? l.playlist : nil;     // the answer's h replaces the opened-from row when it has a name
		ENPlaylist *p = h ?: _pl;
		title = p.name ?: l.title;
		link = p.linkLine ?: _pl.linkLine;
		desc = l.playlist.desc ?: _pl.desc;
		token = h.image ?: _pl.image;
		if (count < 0) count = p.length;
	} else {
		ENAlbumRow *h = l.album.name ? l.album : nil;
		ENAlbumRow *a = h ?: _al;
		title = a.name ?: (l.title ?: _initTitle);
		link = a.artist;
		token = h.image ?: (_al.image ?: _initToken);
		year = a.year;
		if (count < 0) count = a.length;           // -1 when the row didn't carry it
	}
	if (title.length && ![title isEqualToString:self.title]) self.title = title;
	NSMutableArray *meta = [NSMutableArray array];
	if (year > 0) [meta addObject:[NSString stringWithFormat:@"%ld", (long)year]];
	if (count >= 0) [meta addObject:ENCountText(count, ENL(@"song"), ENL(@"songs"))];
	if (l.done && l.totalMs > 0) [meta addObject:ENDurationText(l.totalMs)];

	_header.title = title ?: @"";
	_header.link = link;
	_header.meta = [meta componentsJoinedByString:@" · "];
	// the link opens the album's artist, or (0.11 profiles) the playlist owner's profile ("by <owner>"; not Made For You), or
	// (3c) on Liked, "by <me>": the user's own profile
	_header.linkButton.hidden = !((_kind == ENListAlbum && [self albumArtistURI]) || (_kind == ENListPlaylist && link.length && [self ownerURI]) ||
	                              (_kind == ENListLiked && link.length));

	// height: the description strip comes and goes with the answer; (0.11) and the cover block grows when the title / link
	// just set need the room (a title arriving late, a 2-line name from the answer): the table header is re-set either way
	CGFloat w = _headerBox.bounds.size.width;
	CGFloat hh = [_header heightForDesc:desc];
	if (_header.bounds.size.height != hh || !ENSame(_header.desc, desc) || self.tableView.tableHeaderView != _headerBox) {
		_header.desc = desc;
		_header.frame = CGRectMake(0, 0, w, hh);
		_headerBox.frame = CGRectMake(0, 0, w, hh + 44);
		_filterY = hh;
		[self layoutFilterRow];
		self.tableView.tableHeaderView = _headerBox;          // re-set so the table takes the new height
	}

	// cover: 216 tier (Liked: the drawn tile)
	if (_kind == ENListLiked) _header.image = [ENTheme current].likedTileLarge;
	else [self setHeaderToken:token];
	[self updateFollowItem];                   // (0.11)
}

- (void)anonChanged {
	[self updateHeader];
}

- (void)setHeaderToken:(NSString *)token {
	if (ENSame(token, _headerToken) && (_header.image || !token)) return;
	_headerToken = [token copy];
	if (!token) { _header.image = nil; return; }
	ENImageCache *cache = [ENImageCache shared];
	UIImage *mem = [cache memoryImage:token size:ENImg216 round:NO];
	_header.image = mem;
	if (mem) return;
	__weak ENTrackListViewController *w = self;
	[cache load:token size:ENImg216 round:NO done:^(UIImage *image, NSString *key) {
		ENTrackListViewController *s = w;
		if (!s || !image || ![token isEqualToString:s->_headerToken]) return;
		ENFadeIn(s->_header);                      // (3c, C11) from disk or the network: the cover fades in (a memory hit above
		s->_header.image = image;                  // shows at once); nothing else in the header changes, so only it fades
	}];
}

- (NSString *)albumArtistURI {
	return (_list.album.artistURI ?: _al.artistURI);
}

// (3c, DESIGN-5 §2.3 C2) Liked's owner line: "by <me>" (the library's me.n, as an own playlist's "by <me>"); nil while the
// library doesn't know the name (no line, no link)
- (NSString *)likedOwnerLine:(ENLibrary *)lib {
	if ([ENAnon on]) return ENL(@"by you");         // (R2a) your name is hidden; the line still opens your profile
	NSString *me = lib.meName;
	return me.length ? [NSString stringWithFormat:ENL(@"by %@"), me] : nil;
}

// (3c) an album's footer line (ENCopyrightLine): the answer's copyright, the year from the answer or the opened-from row
- (NSString *)copyrightLine {
	ENAlbumRow *h = _list.album;
	return ENCopyrightLine(h.copyright, h.year > 0 ? h.year : _al.year);
}

- (void)tapLink {
	if (self.navigationController.topViewController != self) return;     // (3c) a second tap during the push: once
	if (_kind == ENListPlaylist) {             // (0.11 profiles) "by <owner>": the owner's profile
		[self openOwner];
		return;
	}
	if (_kind == ENListLiked) {                // (3c) "by <me>": the user's own profile (/v1/me, as the profile button)
		ENProfileViewController *vc = [[ENProfileViewController alloc] init];
		vc.ignoresMiniPlayer = self.ignoresMiniPlayer;
		[self.navigationController pushViewController:vc animated:YES];
		return;
	}
	NSString *uri = [self albumArtistURI];
	if (!uri) return;
	NSString *name = _list.album.artist ?: _al.artist;
	[self.navigationController pushViewController:[[ENArtistViewController alloc] initWithArtistURI:uri name:name] animated:YES];
}

#pragma mark - 0.11 profiles: the owner line and Follow (DESIGN-PROFILES §4.4)

// The owner's spotify:user: uri when the owner line may open their profile: the answer's header, else the opened-from row,
// else the library's row has an `ou` ENUserIDFromURI accepts; never for Made For You; only while profiles are available.
- (NSString *)ownerURI {
	if (_kind != ENListPlaylist || ![ENCatalog shared].profilesAvailable) return nil;
	ENPlaylist *h = _list.playlist;
	if (h.madeForMe || _pl.madeForMe) return nil;
	NSString *ou = h.ownerURI ?: _pl.ownerURI ?: [[ENCatalog shared].library playlistForURI:_listURI].ownerURI;
	return ENUserIDFromURI(ou) ? ou : nil;
}

// "by <owner>" -> ENProfileViewController (the user's own playlist: their own profile); it inherits ignoresMiniPlayer
- (void)openOwner {
	NSString *ou = [self ownerURI];
	if (!ou) return;
	ENPlaylist *p = _list.playlist.name ? _list.playlist : _pl;
	ENProfileViewController *vc = [[ENProfileViewController alloc] initWithUserURI:ou name:(p.owner ?: _pl.owner) image:nil];
	vc.ignoresMiniPlayer = self.ignoresMiniPlayer;
	[self.navigationController pushViewController:vc animated:YES];
}

// (P3) The playlist's state in Your Library when the Follow item shows: someone else's playlist (not own, not Made For You)
// while the gateway can save playlists and the library is known; nil otherwise.
- (NSNumber *)followItemState {
	if (_kind != ENListPlaylist || _followGone) return nil;
	ENCatalog *cat = [ENCatalog shared];
	if (!cat.canSavePlaylists) return nil;
	ENPlaylist *lib = [cat.library playlistForURI:_listURI], *h = _list.playlist;
	if (lib.own || h.own || _pl.own || lib.madeForMe || h.madeForMe || _pl.madeForMe) return nil;
	return [cat playlistSavedStateForURI:_listURI];
}

// The right bar item, as the mockup's followed-playlist page: "Follow" (Done style, the bright green) while not saved,
// "Following" (Bordered) while saved. It follows kind library (the catalog's optimistic flip, its confirmation or revert).
- (void)updateFollowItem {
	if (!self.isViewLoaded) return;
	NSNumber *saved = [self followItemState];
	if (!saved) {
		if (_followItem) {
			if (self.navigationItem.rightBarButtonItem == _followItem) self.navigationItem.rightBarButtonItem = nil;
			_followItem = nil;
		}
		return;
	}
	BOOL on = [saved boolValue];
	if (!_followItem) {
		_followItem = [[UIBarButtonItem alloc] initWithTitle:ENL(@"Follow") style:UIBarButtonItemStyleDone target:self action:@selector(tapFollowItem)];
		self.navigationItem.rightBarButtonItem = _followItem;
	}
	NSString *title = on ? ENL(@"Following") : ENL(@"Follow");
	UIBarButtonItemStyle style = on ? UIBarButtonItemStyleBordered : UIBarButtonItemStyleDone;
	if (![_followItem.title isEqualToString:title]) _followItem.title = title;
	if (_followItem.style != style) _followItem.style = style;
	[ENTheme skinBarItem:_followItem];       // (1.1) iOS 5: its style's look on the item itself, after every change
}

// Follow / Following: optimistic [ENCatalog setPlaylist:saved:done:] with Spotify's HUD; a failure takes the HUD back and
// alerts (the catalog has put the state back); a 501 takes the item away for the screen's life.
- (void)tapFollowItem {
	NSNumber *state = [self followItemState];
	ENPlaylist *p = _list.playlist ?: _pl;
	if (!state || !p.uri) return;
	BOOL saved = ![state boolValue];
	NSString *text = saved ? ENL(@"Added to Your Library") : ENL(@"Removed from Your Library");
	[ENHUD showDone:text glyph:(saved ? @"heart" : @"x")];
	__weak ENTrackListViewController *w = self;
	[[ENCatalog shared] setPlaylist:p saved:saved done:^(NSError *error) {
		ENTrackListViewController *s = w;
		if (!error || !s) return;
		[ENHUD hideText:text];
		if (error.code == 501) {
			s->_followGone = YES;
			[s updateFollowItem];
		}
		[[[ENAlertView alloc] initWithTitle:nil message:[ENCatalog messageForError:error] delegate:nil cancelButtonTitle:ENL(@"OK")
		                  otherButtonTitles:nil] show];
	}];
}

- (void)tapPlay {
	NSString *ctx = [self contextURI];
	if (ctx) [[ENPlayback shared] playContext:ctx offsetURI:nil];
}

- (void)tapShuffle {
	NSString *ctx = [self contextURI];
	if (ctx) [[ENPlayback shared] shufflePlayContext:ctx];
}

// (0.9) the album's ♥ from the catalog's state. keepUnknown: a state the catalog forgot (an `albums` event for a change
// made elsewhere) leaves the glyph as it is until the re-check answers.
- (void)updateHeart:(BOOL)keepUnknown {
	if (!_heart) return;
	NSNumber *s = [[ENCatalog shared] albumSavedStateForURI:_listURI];
	if (s || !keepUnknown) _heartSaved = [s boolValue];
	_heart.selected = _heartSaved;                 // (3c) the Save pill: the filled green heart while saved
	_heart.accessibilityLabel = _heartSaved ? ENL(@"Saved") : ENL(@"Save");
}

// (0.9) ♥ (3c: the Save pill): add the album to / remove it from Your Library. Optimistic: the catalog flips the state and
// posts kind albums at once (the glyph follows), the HUD says so in Spotify's words (3c: with C6's glyph, heart / x, as
// Follow's); a failure takes its HUD back and shows the banner (the catalog has already put the heart back).
- (void)tapHeart {
	BOOL saved = !_heartSaved;
	NSString *text = saved ? ENL(@"Added to Your Library") : ENL(@"Removed from Your Library");
	[ENHUD showDone:text glyph:(saved ? @"heart" : @"x")];
	__weak ENTrackListViewController *w = self;
	[[ENCatalog shared] setAlbum:_listURI saved:saved done:^(NSError *error) {
		if (!error) return;
		[ENHUD hideText:text];
		[w showBanner:[NSString stringWithFormat:(saved ? ENL(@"Couldn't add this album to Your Library. %@")
			: ENL(@"Couldn't remove this album from Your Library. %@")), [ENCatalog messageForError:error]]];
	}];
	// the song hearts' little bounce
	UIImageView *iv = _heart.imageView;
	[UIView animateWithDuration:0.1 delay:0 options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction
		animations:^{
			iv.transform = CGAffineTransformMakeScale(1.3f, 1.3f);
		} completion:^(BOOL finished) {
			[UIView animateWithDuration:0.12 delay:0 options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction
				animations:^{
					iv.transform = CGAffineTransformIdentity;
				} completion:nil];
		}];
}

#pragma mark - notifications

- (void)catalogChanged:(NSNotification *)note {
	[super catalogChanged:note];
	NSString *kind = note.userInfo[ENCatalogKindKey];
	if ([kind isEqualToString:ENCatalogKindList]) {
		NSString *uri = note.userInfo[ENCatalogURIKey];
		if ([uri isEqualToString:_listURI]) {
			_addedDropped = YES;                   // (0.9.4) the catalog dropped its dates added: asked again (now if visible)
			if (self.visible) {
				[self reload:NO];
				[self syncAddedDates];
			} else _stale = YES;
		}
	} else if ([kind isEqualToString:ENCatalogKindLiked] && _kind == ENListLiked) {
		ENTrackList *l = [ENCatalog shared].likedList;          // the optimistic patch (or its revert)
		if (l && l != _listRaw && l != _update && self.isViewLoaded) [self applyList:l patch:YES];
	} else if ([kind isEqualToString:ENCatalogKindLibrary]) {
		ENLibrary *lib = [ENCatalog shared].library;
		if (_kind == ENListLiked && lib) _library = lib;
		if (_kind == ENListPlaylist) {
			ENPlaylist *p = [lib playlistForURI:_listURI];
			if (p) _pl = p;
		}
		[self updateHeader];
	} else if ([kind isEqualToString:ENCatalogKindUser] && !note.userInfo[ENCatalogURIKey]) {
		[self updateHeader];                   // (0.11) profiles available or not / the save capability: the link and Follow
	} else if ([kind isEqualToString:ENCatalogKindAlbums] && _heart) {
		NSArray *uris = note.userInfo[ENCatalogURIsKey];
		if (uris && ![uris containsObject:_listURI]) return;
		[self updateHeart:!uris];
		// (no uris: the list changed; after a change made elsewhere the states are forgotten and a page on screen asks again)
		if (!uris && self.visible && ![[ENCatalog shared] albumSavedStateForURI:_listURI])
			[[ENCatalog shared] checkAlbumSaved:_listURI done:nil];
	}
}

- (void)dropModels {
	_list = nil;
	_listRaw = nil;
	_update = nil;
	_sortedTracks = nil;
	_sortedFrom = nil;
	_sortedDates = nil;
	_rowsPending = NO;
	_rows = @[];
	_pollSince = nil;
	[self cancelPoll];
	// (0.9.4) the dates added go too (asked for again with the list); a request out is forgotten
	_added = nil;
	_addedRev = nil;
	_addedSeq++;
	_addedLoading = _addedDropped = _addedFailed = _addedFinal = _addedSaved = NO;
	if (_kind == ENListPlaylist && ENSortByDate(_shownSort)) _shownSort = ENSortCustom;
	[self updateAddedSpinner];
	if (self.isViewLoaded) [self.tableView reloadData];
}

#pragma mark - table

- (ENTrack *)trackAtIndexPath:(NSIndexPath *)ip {
	return ip.section == 0 && (NSUInteger)ip.row < _rows.count ? _rows[(NSUInteger)ip.row] : nil;
}

// (0.9.2) an editable playlist's page adds "Remove from This Playlist" (ENTrackActions shows it for songs only)
- (NSUInteger)menuOptionsForTrack:(ENTrack *)track {
	if (_kind == ENListAlbum) return ENTrackMenuNoAlbum;
	return [self editablePlaylist] ? ENTrackMenuRemoveFromPlaylist : ENTrackMenuDefault;
}

// Section 0: the songs. Section 1 (0.9.2): no rows, only a header, the Sort note: with nothing under it, it just follows the
// last row and never sticks.
- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return 2; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return section == 0 ? (NSInteger)_rows.count : 0;
}

- (CGFloat)tableView:(UITableView *)tableView heightForHeaderInSection:(NSInteger)section {
	return section == 1 && [self showsSortNote] ? 28 : 0;
}

- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	if (section != 1 || ![self showsSortNote]) return nil;
	if (!_sortNote) {
		ENTheme *th = [ENTheme current];
		_sortNote = [[UILabel alloc] initWithFrame:CGRectMake(0, 0, tableView.bounds.size.width, 28)];
		_sortNote.font = [ENTheme fontOfSize:12 bold:NO];
		_sortNote.textColor = th.footerText;
		_sortNote.backgroundColor = th.listBackground;
		_sortNote.shadowColor = th.footerTextShadow;   // (3c: the token; white in Light)
		_sortNote.shadowOffset = CGSizeMake(0, 1);
		_sortNote.textAlignment = NSTextAlignmentCenter;
		_sortNote.autoresizingMask = UIViewAutoresizingFlexibleWidth;
	}
	_sortNote.text = _kind == ENListLiked ? ENL(@"Plays in Liked Songs' own order") : ENL(@"Plays in the playlist's own order");
	return _sortNote;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	ENTrack *t = [self trackAtIndexPath:ip];
	if (t) [cell showTrack:t art:_cellArt playing:[[ENPlayback shared] isPlayingRow:t]];
	return cell;
}

- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	return [self trackAtIndexPath:ip].playable;
}

- (NSIndexPath *)tableView:(UITableView *)tableView willSelectRowAtIndexPath:(NSIndexPath *)ip {
	return [self trackAtIndexPath:ip].playable ? ip : nil;
}

// a row plays its own entry of this context (filtered rows keep their own uri)
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	ENTrack *t = [self trackAtIndexPath:ip];
	NSString *ctx = [self contextURI];
	if (!t.playable || !ctx) return;
	if (_filterBar.isFirstResponder) [_filterBar resignFirstResponder];
	[[ENPlayback shared] playContext:ctx offsetURI:t.uri];
}

// Swipe left: Liked "Remove" (unlike); (3c, DESIGN-5 §2.3 C2, §2.4 #10) an editable playlist's (own or collaborative: the
// pages whose ••• has "Remove from This Playlist") "Delete", the very same optimistic remove as that ••• item. Playable rows
// only, as the ••• (Loading… / Unavailable rows have none). Albums and other people's playlists: no swipe.
- (BOOL)swipeDeletes {
	return _kind == ENListLiked || (_kind == ENListPlaylist && [self editablePlaylist]);
}

- (BOOL)tableView:(UITableView *)tableView canEditRowAtIndexPath:(NSIndexPath *)ip {
	return [self trackAtIndexPath:ip].playable && [self swipeDeletes];
}

- (UITableViewCellEditingStyle)tableView:(UITableView *)tableView editingStyleForRowAtIndexPath:(NSIndexPath *)ip {
	return [self swipeDeletes] ? UITableViewCellEditingStyleDelete : UITableViewCellEditingStyleNone;
}

- (NSString *)tableView:(UITableView *)tableView titleForDeleteConfirmationButtonForRowAtIndexPath:(NSIndexPath *)ip {
	return _kind == ENListLiked ? ENL(@"Remove") : ENL(@"Delete");
}

- (void)tableView:(UITableView *)tableView commitEditingStyle:(UITableViewCellEditingStyle)style forRowAtIndexPath:(NSIndexPath *)ip {
	if (style != UITableViewCellEditingStyleDelete) return;
	if (_kind == ENListPlaylist) {                 // (3c) Delete = ••• → Remove from This Playlist: every row of the song fades
		ENTrack *t = [self trackAtIndexPath:ip];   // out at once (its own -deleteRowsAtIndexPaths:), the HUD / the revert as there
		if (!t.playable) return;
		[self trackMenuRemoveFromPlaylist:t];
		// nothing went (not editable after all, already being removed from another page): the row just closes its Delete
		if ([self trackAtIndexPath:ip] == t) [tableView setEditing:NO animated:YES];
		return;
	}
	if (_kind != ENListLiked) return;
	ENTrack *t = [self trackAtIndexPath:ip];
	if (!t) return;
	_removingURI = t.uri;
	[ENTrackActions setTrack:t saved:NO];        // optimistic: the catalog patches likedList and posts kind liked at once
	if (_list && [_list indexOfURI:t.uri] != NSNotFound) {
		[self applyList:[_list listByRemovingURIs:[NSSet setWithObject:t.uri]] patch:YES];     // no Liked list in the catalog to patch
	}
	_removingURI = nil;
}

#pragma mark - remove from this playlist (0.9.2, DESIGN-0.9.2 §1)

// The playlist on screen when it can be edited (own or collaborative): the library's row (the Add-to picker's too), else
// the answer's header or the opened-from row. nil on Liked and albums.
- (ENPlaylist *)editablePlaylist {
	if (_kind != ENListPlaylist) return nil;
	ENPlaylist *p = [[ENCatalog shared].library playlistForURI:_listURI];
	if (!p) p = _list.playlist.editable ? _list.playlist : _pl;
	return p.editable ? p : nil;
}

// ••• "Remove from This Playlist": optimistic. Every row of the song fades out at once (the Web API removes every copy) and
// the header / footer counts follow; the rows come back if the gateway says no (ENTrackActions says why). Filtered or sorted
// rows go the same way; the song may be the one playing (playback goes on).
- (void)trackMenuRemoveFromPlaylist:(ENTrack *)track {
	ENPlaylist *pl = [self editablePlaylist];
	NSString *uri = track.uri, *listURI = _listURI;
	if (!pl || !uri.length || !_listRaw) return;
	__weak ENTrackListViewController *w = self;
	BOOL started = [ENTrackActions removeTrack:track fromPlaylist:pl done:^(NSError *error) {
		ENTrackListViewController *s = w;
		ENRemovalAnswered(listURI, uri, !error, s);
		if (error) [s restripDropping:nil];
	}];
	if (!started) return;                          // already being removed (another page of this playlist)
	ENRemovalBegan(listURI, uri, self);
	[self restripDropping:uri];
}

// The catalog's copy again, less the songs being removed (one more, or one fewer after a failure): rows, header, footer.
// uri: the song just added to them, whose rows fade out (the sorted rows lose it without a new sort); nil: a reload.
- (void)restripDropping:(NSString *)uri {
	ENTrackList *raw = _listRaw;
	if (!raw) return;
	NSArray *old = _rows, *was = _list.tracks;
	_list = ENWithoutRemoved(raw, _listURI);
	[self keepSortedFrom:was dropping:uri];
	_removingURI = uri;
	[self rebuildRowsAnimatingFrom:old];
	[self updateHeader];
	[self updateState];
}

// another page of this playlist started a remove, or one failed (ENRemovalsChangedNotification)
- (void)removalsChanged:(NSNotification *)note {
	if (note.object == self || !_listRaw || !self.isViewLoaded) return;
	if (![note.userInfo[ENRemovalListKey] isEqualToString:_listURI]) return;
	[self restripDropping:nil];
}

#pragma mark - filter (debounced 150 ms, main thread)

- (void)searchBar:(UISearchBar *)searchBar textDidChange:(NSString *)text {
	[NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(applyFilter) object:nil];
	[self performSelector:@selector(applyFilter) withObject:nil afterDelay:0.15];
}

- (void)applyFilter {
	NSString *q = [[_filterBar.text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] lowercaseString];
	if (ENSame(q.length ? q : nil, _filter)) return;
	_filter = q.length ? q : nil;
	_rows = [self filtered:[self sortedTracks]];
	[self.tableView reloadData];
	[self updateState];
}

- (void)searchBarTextDidBeginEditing:(UISearchBar *)searchBar {
	[searchBar setShowsCancelButton:YES animated:YES];
	[self setFilterEditing:YES];
}

- (void)searchBarTextDidEndEditing:(UISearchBar *)searchBar {
	[searchBar setShowsCancelButton:NO animated:YES];
	[self setFilterEditing:NO];
}
- (void)searchBarSearchButtonClicked:(UISearchBar *)searchBar { [searchBar resignFirstResponder]; }

- (void)searchBarCancelButtonClicked:(UISearchBar *)searchBar {
	searchBar.text = @"";
	[searchBar resignFirstResponder];
	[self applyFilter];
}

- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView {
	[super scrollViewWillBeginDragging:scrollView];
	if (_filterBar.isFirstResponder) [_filterBar resignFirstResponder];
}

@end

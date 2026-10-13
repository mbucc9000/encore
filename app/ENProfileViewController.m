#import "ENProfileViewController.h"
#import "ENTrackListViewController.h"
#import "ENArtistViewController.h"
#import "ENPeopleViewController.h"
#import "ENUserPlaylistsViewController.h"
#import "ENUserRows.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENModel.h"
#import "ENTheme.h"
#import "ENImageCache.h"
#import "ENAvatarView.h"
#import "ENUtil.h"
#import "ENHUD.h"
#import "ENSheets.h"
#import "ENAppDelegate.h"
#import "ENAnon.h"
#import "ENL.h"

typedef enum { ENProfSecArtists = 0, ENProfSecTop, ENProfSecPlaylists, ENProfSecPeople } ENProfSec;

// (0.11) the rows that aren't models, compared by identity
static NSString *const ENProfSeeAllRow = @"<see all playlists>";
static NSString *const ENProfFollowersRow = @"<followers>";
static NSString *const ENProfFollowingRow = @"<following>";
#define ENProfSavedCopyText ENL(@"Showing a saved copy")     // (a macro: a static initializer can't look it up)

static const CGFloat ENProfileHeaderHeight = 196;         // 0.7's header
static const CGFloat ENProfileHeaderFollowHeight = 232;   // (0.11) with the Follow / Following button
static const CGFloat ENProfileLineY = 160;                // the counts line
static const CGFloat ENProfileLineH = 18;
static const CGFloat ENProfileFollowY = 190;              // the 104 x 28 button, centred, 12 pt under the line
static const CGFloat ENProfileFollowW = 104;
static const CGFloat ENProfileFollowH = 28;

static UIFont *ENProfileNameFont(void) { return [ENTheme fontOfSize:22 bold:YES]; }
static UIFont *ENProfileLineFont(void) { return [ENTheme fontOfSize:13.5f bold:NO]; }

#pragma mark - header

// 320 x 196 (232 with the Follow button), drawn in one go: the green gradient, a 104 pt round picture (ENAvatarView's
// drawing: the picture or the initials, with the white ring), the name and the counts line. (0.11) Every colour and font is an
// ENTheme token (the same in both themes, as the Artist header). Its only subviews: the two clear buttons over the halves of
// the counts line and the Follow / Following button.
@interface ENProfileHeaderView : UIView
@property (nonatomic, copy) NSString *name;
@property (nonatomic, copy) NSString *followersText;     // (0.11) the counts line's halves: "N followers", "N following" (nil:
@property (nonatomic, copy) NSString *followingText;     // left out, as 0.7 did for a count it didn't know)
@property (nonatomic, copy) NSString *memberID;          // the initials' colour
@property (nonatomic, strong) UIImage *image;
@property (nonatomic, readonly) UIButton *followersButton, *followingButton, *followButton;
@property (nonatomic) BOOL showsFollow;                  // the Follow / Following button (the screen sets the 232 pt height)
- (void)setFollowing:(BOOL)following;                    // its look: green "Follow" / silver "Following"
@end

@implementation ENProfileHeaderView

- (id)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		self.opaque = YES;
		self.contentMode = UIViewContentModeRedraw;
		_followersButton = [self clearButton];
		_followingButton = [self clearButton];
		_followButton = [UIButton buttonWithType:UIButtonTypeCustom];
		_followButton.frame = CGRectMake(0, 0, ENProfileFollowW, ENProfileFollowH);     // (3c) its height picks the 28 pt kit
		_followButton.exclusiveTouch = YES;
		_followButton.hidden = YES;
		[self addSubview:_followButton];
		[self setFollowing:NO];
	}
	return self;
}

// a counts-line half: no look of its own (the stock glow while pressed), enabled by the screen
- (UIButton *)clearButton {
	UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
	b.showsTouchWhenHighlighted = YES;
	b.exclusiveTouch = YES;
	b.enabled = NO;
	[self addSubview:b];
	return b;
}

- (void)setName:(NSString *)name { _name = [name copy]; [self setNeedsDisplay]; }
- (void)setImage:(UIImage *)image { _image = image; [self setNeedsDisplay]; }
- (void)setMemberID:(NSString *)memberID { _memberID = [memberID copy]; [self setNeedsDisplay]; }

- (void)setFollowersText:(NSString *)t {
	if (t == _followersText || [t isEqualToString:_followersText]) return;
	_followersText = [t copy];
	[self setNeedsDisplay];
	[self setNeedsLayout];
}

- (void)setFollowingText:(NSString *)t {
	if (t == _followingText || [t isEqualToString:_followingText]) return;
	_followingText = [t copy];
	[self setNeedsDisplay];
	[self setNeedsLayout];
}

- (void)setShowsFollow:(BOOL)showsFollow {
	_showsFollow = showsFollow;
	_followButton.hidden = !showsFollow;
}

// (3c) the C7 kit: the 28 pt green "Follow" / silver "Following" pill with smallButtonFont and its text colour and shadow
- (void)setFollowing:(BOOL)following {
	[ENTheme configureButton:_followButton style:(following ? ENButtonStyleSilver : ENButtonStyleGreen)
	                   title:(following ? ENL(@"Following") : ENL(@"Follow")) glyph:nil];
}

- (NSString *)line {
	if (_followersText.length && _followingText.length) return [NSString stringWithFormat:@"%@ · %@", _followersText, _followingText];
	return _followersText.length ? _followersText : (_followingText ?: @"");
}

// The halves of the centred counts line, measured as it is drawn (sizeWithFont:), 8 pt taller above and below; the button
// centred 12 pt under the line.
- (void)layoutSubviews {
	[super layoutSubviews];
	CGFloat w = self.bounds.size.width, maxW = w - 24;
	UIFont *f = ENProfileLineFont();
	NSString *a = _followersText, *b = _followingText;
	CGFloat wa = a.length ? ceilf([a sizeWithFont:f].width) : 0, wb = b.length ? ceilf([b sizeWithFont:f].width) : 0;
	CGFloat ws = a.length && b.length ? ceilf([@" · " sizeWithFont:f].width) : 0;
	CGFloat x = 12 + MAX(0, floorf((maxW - (wa + ws + wb)) / 2));
	CGFloat y = ENProfileLineY - 8, h = ENProfileLineH + 16;
	_followersButton.frame = CGRectMake(x, y, MIN(wa, maxW), h);
	CGFloat bx = MIN(x + wa + ws, w - 12);
	_followingButton.frame = CGRectMake(bx, y, MAX(0, MIN(wb, w - 12 - bx)), h);
	_followButton.frame = CGRectMake(floorf((w - ENProfileFollowW) / 2), ENProfileFollowY, ENProfileFollowW, ENProfileFollowH);
}

- (void)drawRect:(CGRect)rect {
	ENTheme *th = [ENTheme current];
	CGContextRef c = UIGraphicsGetCurrentContext();
	CGRect b = self.bounds;
	CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
	NSArray *cols = @[ (__bridge id)th.profileHeaderTop.CGColor, (__bridge id)th.profileHeaderMid.CGColor, (__bridge id)th.profileHeaderBottom.CGColor ];
	CGFloat locs[] = { 0, 0.6f, 1 };
	CGGradientRef g = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)cols, locs);
	CGContextDrawLinearGradient(c, g, CGPointZero, CGPointMake(0, b.size.height), 0);
	CGGradientRelease(g);
	CGColorSpaceRelease(cs);

	// the picture's soft shadow: a disc just inside it casts it (the picture covers the disc)
	CGRect av = CGRectMake(floorf((b.size.width - 104) / 2), 16, 104, 104);
	CGContextSaveGState(c);
	CGContextSetShadowWithColor(c, CGSizeMake(0, 3), 8, th.profileAvatarShadow.CGColor);
	[th.profileHeaderBottom setFill];
	CGContextFillEllipseInRect(c, CGRectInset(av, 2, 2));
	CGContextRestoreGState(c);
	[ENAvatarView drawAvatarInRect:av image:_image name:_name memberID:(_memberID ?: _name)];

	// the name (white: the chrome title token) and the counts line, both with the name's shadow, as 0.7 drew them
	[th.navTitle setFill];
	CGContextSetShadowWithColor(c, CGSizeMake(0, -1), 0, th.profileNameShadow.CGColor);
	[(_name ?: @"") drawInRect:CGRectMake(12, 130, b.size.width - 24, 28) withFont:ENProfileNameFont()
	             lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentCenter];
	NSString *line = [self line];
	if (line.length) {
		[th.miniSub setFill];
		[line drawInRect:CGRectMake(12, ENProfileLineY, b.size.width - 24, ENProfileLineH) withFont:ENProfileLineFont()
		   lineBreakMode:NSLineBreakByTruncatingTail alignment:NSTextAlignmentCenter];
	}
}

@end

#pragma mark - screen

@implementation ENProfileViewController {
	BOOL _own;                      // the user's own profile
	NSString *_userID;              // the person's id (own: the library's me.id once known); never logged
	NSString *_initName, *_initToken;   // what the opener passed: the header until the first answer
	ENProfile *_me;                 // own: GET /v1/me (top artists, top tracks, public playlists)
	ENUserProfile *_profile;        // (0.11) GET /v1/users/<id> (own: the counts and People)
	NSArray *_secs;                 // @[ @(kind), title, rows ]
	ENProfileHeaderView *_header;
	NSString *_token;
	BOOL _followGone;               // a 501: the Follow button is gone for the screen's life
	BOOL _notFound;                 // 404 user_not_found: the empty state
}

- (id)init {
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		_own = YES;
		self.title = ENL(@"Profile");
		self.meterName = @"profile";
		_secs = @[];
		[self takeMeID];
	}
	return self;
}

- (instancetype)initWithUserURI:(NSString *)uri name:(NSString *)name image:(NSString *)token {
	NSString *uid = ENUserIDFromURI(uri);
	NSString *meID = [ENCatalog shared].library.meID;
	if (uid && meID && [uid isEqualToString:meID]) return [self init];     // the user's own: exactly the own screen
	if ((self = [super initWithStyle:UITableViewStylePlain])) {
		_userURI = [(ENUserURIFromID(uid) ?: uri) copy];
		_userID = [uid copy];
		_initName = [ENJStr(name) copy];
		_initToken = [ENJStr(token) copy];
		// (R2a) never the username, and while Anonymous Mode is on the person's made-up name (as every row shows them)
		self.title = [ENAnon on] ? ([ENAnon nameForUser:_userID] ?: ENL(@"Profile")) : (_initName ?: ENL(@"Profile"));
		self.meterName = @"profile other";
		_secs = @[];
	}
	return self;
}

- (id)initWithStyle:(UITableViewStyle)style { return [self init]; }

// own: the uri from the library's me.id (nil while it is unknown; asked again on kind library)
- (void)takeMeID {
	if (!_own || _userURI) return;
	NSString *meID = [ENCatalog shared].library.meID;
	_userURI = [ENUserURIFromID(meID) copy];
	if (_userURI) _userID = [meID copy];
}

- (void)viewDidLoad {
	[super viewDidLoad];
	_header = [[ENProfileHeaderView alloc] initWithFrame:CGRectMake(0, 0, self.tableView.bounds.size.width, ENProfileHeaderHeight)];
	[_header.followersButton addTarget:self action:@selector(openFollowers) forControlEvents:UIControlEventTouchUpInside];
	[_header.followingButton addTarget:self action:@selector(openFollowing) forControlEvents:UIControlEventTouchUpInside];
	[_header.followButton addTarget:self action:@selector(tapFollow) forControlEvents:UIControlEventTouchUpInside];
	[self applyIdentity];
	self.tableView.tableHeaderView = _header;
	[self updateHeader];
	[self reload:NO];
	// (R2a) Anonymous Mode switched: the name, picture, counts and rows follow it
	[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(anonChanged) name:ENAnonChangedNotification object:nil];
}

// The header's name, picture and initials colour (and someone else's title) from what is here: own = /v1/me, else the
// library; someone else = their profile, else what the opener passed. (R2a) While Anonymous Mode is on: "You" or the
// person's made-up name, no picture, and a keyed colour; never the username.
- (void)applyIdentity {
	if (!_header) return;
	BOOL anon = [ENAnon on];
	ENCatalog *cat = [ENCatalog shared];
	if (_own) {
		_header.name = _me ? _me.name : (anon ? ENL(@"You") : cat.library.meName);
		NSString *mid = ENIDFromURI(_me.uri) ?: cat.library.meID;
		_header.memberID = anon ? [ENAnon avatarKeyForUser:mid] : mid;
		[self showImage:(_me ? _me.image : cat.meImageToken)];
		return;
	}
	ENUserRow *u = _profile.user;
	NSString *name = u ? u.name : anon ? [ENAnon nameForUser:_userID] : (_initName ?: _userID);
	_header.name = name;
	_header.memberID = anon ? [ENAnon avatarKeyForUser:(u.userID ?: _userID)] : (u.userID ?: _userID);
	[self showImage:(u ? u.image : anon ? nil : _initToken)];
	NSString *title = u.name.length ? u.name : anon ? name : _initName;
	if (title.length && ![title isEqualToString:self.title]) self.title = title;
}

- (void)anonChanged {
	[self applyIdentity];
	[self updateHeader];
	if (self.isViewLoaded) [self rebuild];
}

#pragma mark - loading

- (void)reload:(BOOL)fresh {
	if (_own) {
		[self loadMe:fresh];
		[self loadPeople:fresh];
	} else {
		[self loadOther:fresh];
	}
}

// own: GET /v1/me, as 0.7
- (void)loadMe:(BOOL)fresh {
	if (!_me) [self setBusy:YES];
	__weak ENProfileViewController *w = self;
	[[ENCatalog shared] loadProfile:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENProfileViewController *s = w;
		if (!s) return;
		if (error) {
			[s finishRefreshing];
			[s setBusy:NO];
			[s showError:error];
			return;
		}
		if (!fromCache) [s finishRefreshing];
		if ([result isKindOfClass:[ENProfile class]] && result != s->_me) [s applyMe:result];
	}];
}

// (0.11) own: GET /v1/users/<me> for the counts and People; a failure is silent (the 0.7 header stays)
- (void)loadPeople:(BOOL)fresh {
	[self takeMeID];
	if (!_userURI || ![ENCatalog shared].profilesAvailable) return;
	__weak ENProfileViewController *w = self;
	[[ENCatalog shared] loadUser:_userURI fresh:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENProfileViewController *s = w;
		if (!s || error || ![result isKindOfClass:[ENUserProfile class]] || result == s->_profile) return;
		s->_profile = result;
		[s updateHeader];
		[s rebuild];
	}];
}

// (0.11) someone else: GET /v1/users/<id>
- (void)loadOther:(BOOL)fresh {
	if (!_profile && !_notFound) [self setBusy:YES];
	__weak ENProfileViewController *w = self;
	[[ENCatalog shared] loadUser:_userURI fresh:fresh done:^(id result, BOOL fromCache, NSError *error) {
		ENProfileViewController *s = w;
		if (!s) return;
		if (error) {
			[s finishRefreshing];
			[s setBusy:NO];
			[s userFailed:error];
			return;
		}
		if (!fromCache) [s finishRefreshing];
		if ([result isKindOfClass:[ENUserProfile class]] && result != s->_profile) [s applyUser:result];
	}];
}

- (void)applyMe:(ENProfile *)p {
	_me = p;
	[self setBusy:NO];
	[self applyIdentity];
	[self updateHeader];
	[self rebuild];
	if (p.stale) [self showBanner:ENProfSavedCopyText];
	else [self hideBannerIfShowing:ENProfSavedCopyText];
}

- (void)applyUser:(ENUserProfile *)p {
	_profile = p;
	if (_notFound) {
		_notFound = NO;
		[self setEmptyTitle:nil message:nil];
	}
	[self setBusy:NO];
	[self applyIdentity];
	[self updateHeader];
	[self rebuild];
	if (p.stale) [self showBanner:ENProfSavedCopyText];
	else [self hideBannerIfShowing:ENProfSavedCopyText];
}

// 404 user_not_found: the empty state (the header keeps the name passed in); anything else: the banner, rows stay (an old
// gateway: ENUpdateBridgeText)
- (void)userFailed:(NSError *)error {
	if ([[ENCatalog codeOfError:error] isEqualToString:@"user_not_found"]) {
		_notFound = YES;
		_profile = nil;
		[self hideBanner];
		[self updateHeader];
		[self rebuild];
		[self setEmptyTitle:ENL(@"Profile not available") message:ENL(@"Spotify doesn't show this profile.")];
		return;
	}
	[self showError:error];
}

// the sections for what is here: own = 0.7's three (+ People once the user's /v1/users answered); others = Public Playlists, Recently
// played artists, People
- (void)rebuild {
	NSMutableArray *secs = [NSMutableArray array];
	if (_own) {
		ENProfile *p = _me;
		if (p.artists.count) [secs addObject:@[ @(ENProfSecArtists), ENL(@"Top artists this month"), p.artists ]];
		if (p.top.count) [secs addObject:@[ @(ENProfSecTop), ENL(@"Top tracks this month"), p.top ]];
		if (p.playlists.count) [secs addObject:@[ @(ENProfSecPlaylists), ENL(@"Playlists"), p.playlists ]];
	} else if (_profile) {
		ENUserProfile *p = _profile;
		if (p.playlists.count) {
			NSMutableArray *rows = [NSMutableArray arrayWithArray:p.playlists];
			if (p.playlistsTotal > (NSInteger)p.playlists.count) [rows addObject:ENProfSeeAllRow];
			[secs addObject:@[ @(ENProfSecPlaylists), ENL(@"Public Playlists"), rows ]];
		}
		if (p.artists.count)
			[secs addObject:@[ @(ENProfSecArtists), ENL(@"Recently played artists"), p.artists.count > 5 ? [p.artists subarrayWithRange:NSMakeRange(0, 5)] : p.artists ]];
	}
	NSArray *people = [self peopleRows];
	if (people.count) [secs addObject:@[ @(ENProfSecPeople), ENL(@"People"), people ]];
	_secs = secs;
	self.footerText = !_own && _profile && !_profile.playlists.count ? ENL(@"No public playlists") : nil;
	if (self.isViewLoaded) [self.tableView reloadData];
}

- (NSArray *)peopleRows {
	if (!_profile || !_userURI || ![ENCatalog shared].profilesAvailable) return @[];
	NSMutableArray *rows = [NSMutableArray arrayWithCapacity:2];
	if ([self shownFollowers] > 0) [rows addObject:ENProfFollowersRow];
	if (_profile.following > 0) [rows addObject:ENProfFollowingRow];
	return rows;
}

#pragma mark - header and Follow

// what the button shows: the catalog's state while a write is pending or since one confirmed, else the profile's own `f`
- (BOOL)followState {
	NSNumber *s = [[ENCatalog shared] followStateForUser:_userURI];
	return s ? [s boolValue] : _profile.isFollowing;
}

// the followers count with our own follow / unfollow the profile doesn't have yet
- (NSInteger)shownFollowers {
	NSInteger n = _profile.followers;
	BOOL f = [self followState];
	if (_profile && f != _profile.isFollowing) n = MAX(0, n + (f ? 1 : -1));
	return n;
}

// The counts line and its two buttons, and the Follow button (the header 232 pt with it, else 196).
- (void)updateHeader {
	if (!_header) return;
	NSInteger fol = -1, fing = -1;
	if (_profile) {
		fol = [self shownFollowers];
		fing = _profile.following;
	} else if (_own && _me) {
		fol = _me.followers;
		fing = _me.following;
	}
	if ([ENAnon on]) fol = fing = -1;      // (R2a) follower and following counts are hidden
	_header.followersText = fol >= 0 ? ENCountText(fol, ENL(@"follower"), ENL(@"followers")) : nil;
	_header.followingText = fing >= 0 ? ENCountText(fing, ENL(@"following"), ENL(@"following")) : nil;     // ("following" is no plural)
	BOOL lists = _profile && _userURI && [ENCatalog shared].profilesAvailable;
	_header.followersButton.enabled = lists && fol > 0;
	_header.followingButton.enabled = lists && fing > 0;
	BOOL follow = !_own && _profile.canFollow && !_profile.isMe && !_followGone && _userURI && [ENCatalog shared].profilesAvailable;
	if (follow) [_header setFollowing:[self followState]];
	_header.showsFollow = follow;
	CGFloat h = follow ? ENProfileHeaderFollowHeight : ENProfileHeaderHeight;
	if (_header.bounds.size.height != h) {
		_header.frame = CGRectMake(0, 0, self.tableView.bounds.size.width, h);
		self.tableView.tableHeaderView = _header;          // re-set so the table takes the new height
	}
}

// Follow / Following: optimistic (the catalog flips the state and posts kind user at once: the button and the count follow);
// a failure takes its HUD back and alerts (the catalog has put the state back); a 501 hides the button for the screen's life
- (void)tapFollow {
	if (!_profile || !_userURI) return;
	BOOL want = ![self followState];
	NSString *text = want ? ENL(@"Following") : ENL(@"Unfollowed");
	[ENHUD showDone:text glyph:(want ? @"check" : @"x")];
	__weak ENProfileViewController *w = self;
	[[ENCatalog shared] setUser:_userURI following:want done:^(NSError *error) {
		ENProfileViewController *s = w;
		if (!error || !s) return;
		[ENHUD hideText:text];
		if (error.code == 501) {
			s->_followGone = YES;
			[s updateHeader];
		}
		[[[ENAlertView alloc] initWithTitle:nil message:[ENCatalog messageForError:error] delegate:nil cancelButtonTitle:ENL(@"OK")
		                  otherButtonTitles:nil] show];
	}];
}

- (void)showImage:(NSString *)token {
	if (!token && [ENAnon on]) {           // (R2a) no picture while Anonymous Mode is on: the initials disc
		_token = nil;
		_header.image = nil;
		return;
	}
	if (!token || ([token isEqualToString:_token] && _header.image)) return;
	_token = [token copy];
	ENImageCache *cache = [ENImageCache shared];
	UIImage *mem = [cache memoryImage:token size:ENImg216 round:YES];
	if (mem) { _header.image = mem; return; }
	__weak ENProfileViewController *w = self;
	[cache load:token size:ENImg216 round:YES done:^(UIImage *image, NSString *key) {
		ENProfileViewController *s = w;
		if (!s || !image || ![token isEqualToString:s->_token]) return;
		ENFadeIn(s->_header);        // (3c, C11) from disk or the network: the picture cross-fades in (only while on screen)
		s->_header.image = image;
	}];
}

#pragma mark - notifications

// kind user for this person (our follow / unfollow, optimistic, confirmed or reverted): the button, the count and People;
// without a uri (profiles became available or not): the same, and the user's own profile asks for its People once it may. Kind
// library: own, me.id may be known now; the rows redraw (playlist names and lines). Kind reset reloads (the base).
- (void)catalogChanged:(NSNotification *)note {
	[super catalogChanged:note];
	NSString *kind = note.userInfo[ENCatalogKindKey];
	if ([kind isEqualToString:ENCatalogKindUser]) {
		NSString *uri = note.userInfo[ENCatalogURIKey];
		if (uri && !ENSameUser(uri, _userURI)) return;
		[self updateHeader];
		if (self.isViewLoaded) [self rebuild];
		if (!uri && _own && !_profile && self.visible) [self loadPeople:NO];
	} else if ([kind isEqualToString:ENCatalogKindLibrary]) {
		if (_own && !_userURI) {
			[self takeMeID];
			if (_userURI && self.visible) [self loadPeople:NO];
		}
		[self reloadVisibleRows];
	}
}

- (void)dropModels {
	_me = nil;
	_profile = nil;
	_secs = @[];
	if (self.isViewLoaded) [self.tableView reloadData];
}

#pragma mark - pushes

// everything pushed from here inherits ignoresMiniPlayer (a profile opened in the Jam sheet)
- (void)push:(UIViewController *)vc {
	if (!vc) return;
	if ([vc isKindOfClass:[ENListViewController class]]) ((ENListViewController *)vc).ignoresMiniPlayer = self.ignoresMiniPlayer;
	[self.navigationController pushViewController:vc animated:YES];
}

- (void)openFollowers {
	if (!_userURI || ![ENCatalog shared].profilesAvailable) return;
	[self push:[[ENPeopleViewController alloc] initFollowersOf:_userURI]];
}

- (void)openFollowing {
	if (!_userURI || ![ENCatalog shared].profilesAvailable) return;
	[self push:[[ENPeopleViewController alloc] initFollowingOf:_userURI]];
}

#pragma mark - table

- (ENProfSec)kindOf:(NSInteger)section { return (ENProfSec)[_secs[(NSUInteger)section][0] intValue]; }

- (id)itemAt:(NSIndexPath *)ip {
	if ((NSUInteger)ip.section >= _secs.count) return nil;
	NSArray *rows = _secs[(NSUInteger)ip.section][2];
	return (NSUInteger)ip.row < rows.count ? rows[(NSUInteger)ip.row] : nil;
}

- (ENTrack *)trackAtIndexPath:(NSIndexPath *)ip {
	id x = [self itemAt:ip];
	return [x isKindOfClass:[ENTrack class]] ? x : nil;
}

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return (NSInteger)_secs.count; }

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return (NSInteger)[_secs[(NSUInteger)section][2] count];
}

- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	return [self sectionHeaderWithTitle:_secs[(NSUInteger)section][1]];
}

- (CGFloat)tableView:(UITableView *)tableView heightForHeaderInSection:(NSInteger)section { return 22; }

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENListCell *cell = ENDequeueCell(tableView, [ENListCell reuseIdentifier], ip);
	cell.delegate = self;
	id x = [self itemAt:ip];
	if ([x isKindOfClass:[ENTrack class]]) [cell showTrack:x art:ENCellArtCover playing:[[ENPlayback shared] isPlayingRow:x]];
	else if ([x isKindOfClass:[ENArtistRow class]]) [cell showArtist:x subtitle:nil];
	else if ([x isKindOfClass:[ENPlaylist class]]) {
		[cell showPlaylist:x];
		if (!_own) cell.subtitle = ENProfilePlaylistSub(x, _profile.user.name);     // (0.11) others' public playlists
	} else if (x == ENProfSeeAllRow) {
		[cell showTitle:[NSString stringWithFormat:ENL(@"See all %@ playlists"), ENGroupedNumber(_profile.playlistsTotal)] subtitle:nil
		          image:nil chevron:YES];
	} else if (x == ENProfFollowersRow) {
		// (R2a) the rows stay while Anonymous Mode is on, without their counts
		[cell showTitle:ENL(@"Followers") subtitle:([ENAnon on] ? nil : ENCountText([self shownFollowers], ENL(@"person"), ENL(@"people"))) image:nil chevron:YES];
	} else if (x == ENProfFollowingRow) {
		[cell showTitle:ENL(@"Following") subtitle:([ENAnon on] ? nil : ENGroupedNumber(_profile.following)) image:nil chevron:YES];
	}
	return cell;
}

- (BOOL)tableView:(UITableView *)tableView shouldHighlightRowAtIndexPath:(NSIndexPath *)ip {
	id x = [self itemAt:ip];
	return [x isKindOfClass:[ENTrack class]] ? ((ENTrack *)x).playable : x != nil;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	id x = [self itemAt:ip];
	if ([x isKindOfClass:[ENTrack class]]) { if (((ENTrack *)x).playable) [[ENPlayback shared] playURI:((ENTrack *)x).uri]; }
	else if ([x isKindOfClass:[ENArtistRow class]]) [self push:[[ENArtistViewController alloc] initWithArtist:x]];
	else if ([x isKindOfClass:[ENPlaylist class]]) [self push:[[ENTrackListViewController alloc] initWithPlaylist:x]];
	else if (x == ENProfSeeAllRow) [self push:[[ENUserPlaylistsViewController alloc] initWithUserURI:_userURI name:_profile.user.name]];
	else if (x == ENProfFollowersRow) [self openFollowers];
	else if (x == ENProfFollowingRow) [self openFollowing];
}

@end

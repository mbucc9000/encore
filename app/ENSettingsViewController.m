#import "ENSettingsViewController.h"
#import "ENL.h"
#import "ENAppDelegate.h"
#import "ENTheme.h"
#import "ENSheets.h"
#import "ENGateway.h"
#import "ENPlayback.h"
#import "ENCatalog.h"
#import "ENModel.h"
#import "ENJam.h"
#import "ENJamActions.h"
#import "ENTabBarController.h"
#import "ENChoiceViewController.h"
#import "ENPlayerViewController.h"
#import "ENDiag.h"
#import "ENAnon.h"

// See ENSettingsViewController.h. The rows are a small model (ENSetItem) rebuilt from the app's state; the table shows it
// through ENGroupedCell (ENSettingsCell adds the Status dot).

typedef NS_ENUM(NSInteger, ENSetRow) {
	ENSetHome = 1, ENSetAway, ENSetStatus, ENSetEngine,
	ENSetJam, ENSetQuality, ENSetAutoReduce, ENSetPauseOnUnplug, ENSetExplicit, ENSetPlayLink,
	ENSetOpenLinks,
	ENSetAppearance, ENSetLanguage,
	ENSetAnon, ENSetAnonPlaylists,             // (R2a) Privacy
	ENSetSpotify, ENSetDevice,
	ENSetUnpair,
	ENSetVersion, ENSetGateway, ENSetDiagnostics,
};

typedef NS_ENUM(NSInteger, ENSetAlert) {      // the alerts' tags
	ENSetAlertHome = 1, ENSetAlertAway, ENSetAlertBadAddress, ENSetAlertEngine, ENSetAlertPlayLink, ENSetAlertNotALink,
	ENSetAlertSpotify, ENSetAlertUnpair,
	ENSetAlertAddressHidden,                   // (R2a)
};

typedef NS_ENUM(NSInteger, ENSetStatusState) { ENSetStatusUnknown = 0, ENSetStatusOnline, ENSetStatusOffline };

// EncoreLinks (the tweak that opens tapped Spotify links in Encore) isn't released yet, so its Settings row is left out of
// the build until it ships: 1 = the Links section (make package EN_ENCORE_LINKS=1, see the Makefile); 0 = no Links section.
#ifndef EN_ENCORE_LINKS
#define EN_ENCORE_LINKS 0
#endif

#if EN_ENCORE_LINKS
static NSString *const ENOpenLinksKey = @"openLinks";          // the EncoreLinks tweak's key (in the app's defaults domain)
#endif
static NSString *const ENSettingsCellID = @"ENSettingsCell";
static const CGFloat ENSetTile = 29;                            // the Settings icon tiles (§1.3)
static const CGFloat ENSetDotGap = 5;                           // between the Status dot and its text

static BOOL ENSame(id a, id b) { return a == b || [a isEqual:b]; }

// "http://192.168.1.20:8095/" -> "192.168.1.20:8095" (the row's value); anything NSURL can't split shows as typed, scheme off
static NSString *ENHostPort(NSString *url) {
	if (!url.length) return nil;
	NSURL *u = [NSURL URLWithString:url];
	if (u.host.length) return u.port ? [NSString stringWithFormat:@"%@:%@", u.host, u.port] : u.host;
	NSRange r = [url rangeOfString:@"://"];
	return r.location != NSNotFound ? [url substringFromIndex:r.location + r.length] : url;
}

#pragma mark - model

// one row: what the cell shows and how it behaves
@interface ENSetItem : NSObject
@property (nonatomic) ENSetRow kind;
@property (nonatomic, copy) NSString *title, *detail, *value;
@property (nonatomic, strong) UIImage *icon;      // a 29 pt tile, nil = none
@property (nonatomic, strong) UIImage *dot;       // the Status dot, nil = none
@property (nonatomic) ENGroupedAccessory accessory;
@property (nonatomic) BOOL on;                    // a switch row's state
@property (nonatomic) BOOL tappable, centered, destructive;
@end

@implementation ENSetItem

+ (ENSetItem *)kind:(ENSetRow)kind title:(NSString *)title {
	ENSetItem *it = [[ENSetItem alloc] init];
	it.kind = kind;
	it.title = title;
	return it;
}

// a row that pushes or opens something
- (ENSetItem *)tap {
	_tappable = YES;
	_accessory = ENGroupedAccessoryChevron;
	return self;
}

// a switch row (never selectable: only the switch reacts)
- (ENSetItem *)toggle:(BOOL)on {
	_accessory = ENGroupedAccessorySwitch;
	_on = on;
	return self;
}

- (BOOL)isSameAs:(ENSetItem *)o {
	return o && _kind == o.kind && ENSame(_title, o.title) && ENSame(_detail, o.detail) && ENSame(_value, o.value)
	    && _icon == o.icon && _dot == o.dot && _accessory == o.accessory && _on == o.on && _tappable == o.tappable
	    && _centered == o.centered && _destructive == o.destructive;
}

@end

// one section: a header (nil = the base's 18 pt gap), the rows, a footer
@interface ENSetSection : NSObject
@property (nonatomic, copy) NSString *header, *footer;
@property (nonatomic, copy) NSArray *items;      // ENSetItem
@end

@implementation ENSetSection

+ (ENSetSection *)header:(NSString *)header items:(NSArray *)items {
	ENSetSection *s = [[ENSetSection alloc] init];
	s.header = header;
	s.items = items;
	return s;
}

@end

#pragma mark - row

// ENGroupedCell plus the Status row's dot, placed just before the value's text (the value label is right-aligned, so its
// text starts at its right edge less the text width). Found by its text; without it the dot hides.
@interface ENSettingsCell : ENGroupedCell
@property (nonatomic, strong) UIImage *dot;
@end

@implementation ENSettingsCell {
	UIImageView *_dotView;
}

- (void)setDot:(UIImage *)dot {
	_dot = dot;
	if (dot && !_dotView) {
		_dotView = [[UIImageView alloc] initWithFrame:CGRectZero];
		[self.contentView addSubview:_dotView];
	}
	_dotView.image = dot;
	_dotView.hidden = dot == nil;
	[self setNeedsLayout];
}

- (void)prepareForReuse {
	[super prepareForReuse];
	self.dot = nil;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	if (!_dot) return;
	UILabel *valueLabel = nil;
	for (UIView *v in self.contentView.subviews) {
		if (![v isKindOfClass:[UILabel class]]) continue;
		UILabel *l = (UILabel *)v;
		if (l.textAlignment == NSTextAlignmentRight && l.text.length && [l.text isEqualToString:self.value]) valueLabel = l;
	}
	if (!valueLabel || CGRectIsEmpty(valueLabel.frame)) { _dotView.hidden = YES; return; }
	CGRect f = valueLabel.frame;
	CGFloat textW = MIN(ceilf([valueLabel.text sizeWithFont:valueLabel.font].width), f.size.width);
	CGSize d = _dot.size;
	_dotView.hidden = NO;
	_dotView.frame = CGRectMake(CGRectGetMaxX(f) - textW - ENSetDotGap - d.width, floorf(CGRectGetMidY(f) - d.height / 2), d.width, d.height);
}

@end

#pragma mark - controller

@implementation ENSettingsViewController {
	NSArray *_sections;              // ENSetSection: what the table shows
	ENTheme *_skinned;               // the palette the rows were built with (tiles and dots are per palette)
	BOOL _appearing;                 // inside viewWillAppear: (a pending re-skin from the base reloads in full)
	BOOL _observing;
	BOOL _refreshQueued;
	// Status
	BOOL _checking, _recheck;
	ENSetStatusState _status;
	BOOL _statusAway;
	NSInteger _latencyMs;            // -1 = unknown
	// Account
	NSString *_spotifyName;          // never logged
	BOOL _nameAsked;
	// alerts
	UIAlertView *_alert;             // the one that is up (its delegate is this screen)
}

- (id)initWithStyle:(UITableViewStyle)style {
	if ((self = [super initWithStyle:style])) {
		self.title = ENL(@"Settings");
		_latencyMs = -1;
	}
	return self;
}

- (void)dealloc {
	_alert.delegate = nil;           // UIAlertView.delegate is assign on iOS 6
	[self stopObserving];
}

- (void)viewDidLoad {
	[super viewDidLoad];
	_skinned = [ENTheme current];
	_sections = [self buildSections];
}

- (void)viewWillAppear:(BOOL)animated {
	_sections = [self buildSections];          // what changed while hidden (Quality, Text size, the Jam, a pushed screen)
	_appearing = YES;
	[super viewWillAppear:animated];           // (the base re-skins here when a theme note came while hidden)
	_appearing = NO;
	[self.tableView reloadData];
	[self startObserving];
	[self loadName];
	[self checkStatus];
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	[self stopObserving];
}

#pragma mark - observing (only while shown, SET8)

- (void)startObserving {
	if (_observing) return;
	_observing = YES;
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(valuesChanged) name:ENPlaybackChangedNotification object:nil];
	[nc addObserver:self selector:@selector(valuesChanged) name:ENJamChangedNotification object:nil];
	[nc addObserver:self selector:@selector(valuesChanged) name:ENCatalogVersionNotification object:nil];
	[nc addObserver:self selector:@selector(routeChanged) name:ENGatewayRouteChangedNotification object:nil];
	[nc addObserver:self selector:@selector(appActive) name:UIApplicationDidBecomeActiveNotification object:nil];
}

// only this screen's own names: the base keeps its theme and mini-player observers until dealloc
- (void)stopObserving {
	if (!_observing) return;
	_observing = NO;
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc removeObserver:self name:ENPlaybackChangedNotification object:nil];
	[nc removeObserver:self name:ENJamChangedNotification object:nil];
	[nc removeObserver:self name:ENCatalogVersionNotification object:nil];
	[nc removeObserver:self name:ENGatewayRouteChangedNotification object:nil];
	[nc removeObserver:self name:UIApplicationDidBecomeActiveNotification object:nil];
}

static BOOL ENAppActive(void) {
	return [UIApplication sharedApplication].applicationState == UIApplicationStateActive;
}

// A route change our own check caused is already in its answer (its timed GET follows the probe): only a change from
// elsewhere starts a new check (and not in the background: becoming active checks anyway).
- (void)routeChanged {
	if (!_checking && ENAppActive()) [self checkStatus];
	[self valuesChanged];
}

- (void)appActive {
	[self checkStatus];
	[self valuesChanged];
}

// ENPlaybackChangedNotification comes often: one rebuild per run-loop turn, only while shown and active (becoming active
// rebuilds)
- (void)valuesChanged {
	if (_refreshQueued || !self.isViewLoaded) return;
	_refreshQueued = YES;
	__weak ENSettingsViewController *weakSelf = self;
	dispatch_async(dispatch_get_main_queue(), ^{
		ENSettingsViewController *s = weakSelf;
		if (!s) return;
		s->_refreshQueued = NO;
		if (s.visible && ENAppActive()) [s refreshValues];
	});
}

#pragma mark - theme

// A palette flip (or a re-skin pending since the screen was hidden): rebuild for the new palette, then the base re-skins and
// reloads. The same palette (a text-size or Explicit Badges change: neither changes how this screen looks): the values only,
// in place, so the Explicit Badges switch that caused it keeps its animation.
- (void)themeDidChange {
	if (!_appearing && _skinned == [ENTheme current] && self.isViewLoaded && _sections) {
		[self refreshValues];
		return;
	}
	_skinned = [ENTheme current];
	_sections = [self buildSections];
	[super themeDidChange];
}

#pragma mark - the rows

- (NSArray *)buildSections {
	ENTheme *th = [ENTheme current];
	ENGateway *gw = [ENGateway shared];
	ENPlayback *pb = [ENPlayback shared];
	ENJam *jam = [ENJam shared];
	ENCatalog *cat = [ENCatalog shared];
	BOOL anon = [ENAnon on];
	NSMutableArray *secs = [NSMutableArray array];

	// ---- Encore Bridge (the gateway). (R2a) While Anonymous Mode is on the addresses show as "Hidden" (a tap explains)
	ENSetItem *home = [[ENSetItem kind:ENSetHome title:ENL(@"Home Address")] tap];
	home.icon = [th iconTileNamed:@"computer" size:ENSetTile];
	home.value = anon ? ENL(@"Hidden") : ENHostPort(gw.homeURL);
	ENSetItem *away = [[ENSetItem kind:ENSetAway title:ENL(@"Away Address")] tap];
	away.icon = [th iconTileNamed:@"wifi" size:ENSetTile];
	away.value = !gw.awayURL.length ? ENL(@"None") : anon ? ENL(@"Hidden") : ENHostPort(gw.awayURL);
	ENSetItem *status = [ENSetItem kind:ENSetStatus title:ENL(@"Status")];
	status.icon = [th iconTileNamed:(_status == ENSetStatusOffline ? @"statusBad" : @"statusOK") size:ENSetTile];
	if (_status == ENSetStatusUnknown) {
		status.value = ENL(@"Checking…");
	} else if (_status == ENSetStatusOffline) {
		status.value = ENL(@"Offline");
		status.dot = [th statusDotImage:NO];
	} else {
		NSString *route = _statusAway ? ENL(@"Away") : ENL(@"Home");
		status.value = _latencyMs >= 0 ? [NSString stringWithFormat:ENL(@"%@ · %ld ms"), route, (long)_latencyMs] : route;
		status.dot = [th statusDotImage:YES];
	}
	ENSetItem *engine = [[ENSetItem kind:ENSetEngine title:ENL(@"Engine")] tap];
	engine.icon = [th iconTileNamed:@"engine" size:ENSetTile];
	NSNumber *connected = [self engineConnected];
	engine.value = !connected || _status == ENSetStatusOffline ? ENL(@"Unknown") : connected.boolValue ? ENL(@"Connected") : ENL(@"Not connected");
	[secs addObject:[ENSetSection header:@"Encore Bridge" items:@[ home, away, status, engine ]]];

	// ---- Playback
	ENSetItem *jamRow = [ENSetItem kind:ENSetJam title:ENL(@"Jam")];
	jamRow.icon = [th iconTileNamed:@"jam" size:ENSetTile];
	if (jam.available) {
		[jamRow tap];
		jamRow.value = [jam label];
	} else {
		jamRow.detail = ENUpdateBridgeShortText;
	}
	ENSetItem *quality = [[ENSetItem kind:ENSetQuality title:ENL(@"Streaming Quality")] tap];
	quality.value = [ENChoiceViewController qualityTitleForTier:pb.tier];
	quality.detail = [self qualityDetail];
	ENSetItem *autoReduce = [[ENSetItem kind:ENSetAutoReduce title:ENL(@"Auto-Reduce Quality")] toggle:pb.autoQuality];
	autoReduce.detail = ENL(@"Steps down when the network is slow");
	ENSetItem *unplug = [[ENSetItem kind:ENSetPauseOnUnplug title:ENL(@"Pause on Unplug")] toggle:pb.pauseOnUnplug];
	unplug.detail = ENL(@"Headphones or AirPods disconnect");
	ENSetItem *badges = [[ENSetItem kind:ENSetExplicit title:ENL(@"Explicit Badges")] toggle:[ENTheme showsExplicitBadges]];
	ENSetItem *playLink = [[ENSetItem kind:ENSetPlayLink title:ENL(@"Play a Link…")] tap];
	playLink.detail = ENL(@"A song, album, playlist, artist or Jam link");
	[secs addObject:[ENSetSection header:ENL(@"Playback") items:@[ jamRow, quality, autoReduce, unplug, badges, playLink ]]];

#if EN_ENCORE_LINKS
	// ---- Links (only in a build with EN_ENCORE_LINKS 1: EncoreLinks isn't released yet)
	NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
	BOOL openLinks = [ud objectForKey:ENOpenLinksKey] ? [ud boolForKey:ENOpenLinksKey] : YES;
	ENSetItem *links = [[ENSetItem kind:ENSetOpenLinks title:ENL(@"Open Spotify Links")] toggle:openLinks];
	links.detail = ENL(@"Song, album, playlist and Jam links tapped in Messages, Mail or Safari open here (EncoreLinks tweak)");
	[secs addObject:[ENSetSection header:ENL(@"Links") items:@[ links ]]];
#endif

	// ---- Appearance: Text Size while dark mode is deferred (EN_DARK_MODE 0), the mockup's Theme row with it
#if EN_DARK_MODE
	ENSetItem *look = [[ENSetItem kind:ENSetAppearance title:ENL(@"Theme")] tap];
	look.icon = [th iconTileNamed:@"theme" size:ENSetTile];
	ENAppearance a = [ENTheme appearance];
	look.value = a == ENAppearanceDark ? ENL(@"Dark") : a == ENAppearanceAutomatic ? ENL(@"Automatic") : ENL(@"Light");
	if (a == ENAppearanceAutomatic) look.detail = ENL(@"Dark from 7 PM to 7 AM");
#else
	ENSetItem *look = [[ENSetItem kind:ENSetAppearance title:ENL(@"Text Size")] tap];
	// (no named tile for it: the list glyph on the olive green of the chrome)
	look.icon = [th iconTileWithGlyph:@"list" top:th.artistHeaderTop bottom:th.artistHeaderBottom size:ENSetTile radius:6];
	ENTextSize ts = [ENTheme textSize];
	look.value = ts == ENTextSizeSmall ? ENL(@"Small") : ts == ENTextSizeLarge ? ENL(@"Large") : ENL(@"Default");
#endif
	ENSetItem *lang = [[ENSetItem kind:ENSetLanguage title:ENL(@"Language")] tap];
	// (the list glyph, blue like the Away row, so it isn't mistaken for Text Size)
	lang.icon = [th iconTileWithGlyph:@"list" top:[UIColor colorWithRed:0x6a/255.0 green:0xa8/255.0 blue:0xff/255.0 alpha:1]
	                           bottom:[UIColor colorWithRed:0x2f/255.0 green:0x62/255.0 blue:0xc9/255.0 alpha:1] size:ENSetTile radius:6];
	lang.value = [ENLang chosen] ? [ENLang nativeNameForCode:[ENLang chosen]] : ENL(@"Automatic");
	[secs addObject:[ENSetSection header:ENL(@"Appearance") items:@[ look, lang ]]];

	// ---- Privacy (R2a, D5): Anonymous Mode, and while it is on Hide My Playlist Names. Both stay through Unpair.
	ENSetItem *anonRow = [[ENSetItem kind:ENSetAnon title:ENL(@"Anonymous Mode")] toggle:anon];
	anonRow.detail = ENL(@"Hides names, pictures, addresses and devices. Music stays.");
	NSMutableArray *privacy = [NSMutableArray arrayWithObject:anonRow];
	if (anon) {
		ENSetItem *hide = [[ENSetItem kind:ENSetAnonPlaylists title:ENL(@"Hide My Playlist Names")] toggle:[ENAnon hidePlaylistsSetting]];
		hide.detail = ENL(@"Your playlists show as My Playlist #1, #2…");
		[privacy addObject:hide];
	}
	ENSetSection *privacySec = [ENSetSection header:ENL(@"Privacy") items:privacy];
	privacySec.footer = ENL(@"For screenshots and demos. Nothing is deleted; turn it off to see everything again.");
	[secs addObject:privacySec];

	// ---- Account (R2a: while Anonymous Mode is on, no name and the model for this iPhone)
	ENSetItem *spotify = [[ENSetItem kind:ENSetSpotify title:@"Spotify"] tap];
	spotify.value = anon ? ENL(@"Signed in") : _spotifyName.length ? _spotifyName : cat.library.meName;
	ENSetItem *device = [ENSetItem kind:ENSetDevice title:ENL(@"This Device")];
	device.value = [ENAnon thisDeviceName];
	[secs addObject:[ENSetSection header:ENL(@"Account") items:@[ spotify, device ]]];

	// ---- Unpair (no header: the base's 18 pt gap, as the mockup's margin)
	ENSetItem *unpair = [ENSetItem kind:ENSetUnpair title:ENL(@"Unpair This iPhone")];
	unpair.tappable = unpair.centered = unpair.destructive = YES;
	[secs addObject:[ENSetSection header:nil items:@[ unpair ]]];

	// ---- About
	ENSetItem *version = [ENSetItem kind:ENSetVersion title:ENL(@"Version")];
	id v = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
	version.value = [v isKindOfClass:[NSString class]] ? v : nil;
	ENSetItem *gateway = [ENSetItem kind:ENSetGateway title:@"Encore Bridge"];
	gateway.value = cat.gatewayVersion.length ? cat.gatewayVersion : ENL(@"Unknown");
	ENSetItem *diag = [[ENSetItem kind:ENSetDiagnostics title:ENL(@"Diagnostics")] tap];
	ENSetSection *about = [ENSetSection header:ENL(@"About") items:@[ version, gateway, diag ]];
	// D11: what Encore is, then the unofficial-client notice
	about.footer = ENL(@"Encore plays Spotify on your Encore Bridge and streams it to this iPhone as AAC. Your Spotify password never touches this device.\n\nEncore is an unofficial Spotify client. It isn’t made by, affiliated with or endorsed by Spotify.");
	[secs addObject:about];
	return secs;
}

// the player snapshot's engine.connected: @YES / @NO, nil before any snapshot
- (NSNumber *)engineConnected {
	NSDictionary *snap = [ENPlayback shared].engine;
	NSDictionary *e = [snap isKindOfClass:[NSDictionary class]] && [snap[@"engine"] isKindOfClass:[NSDictionary class]] ? snap[@"engine"] : nil;
	id c = e[@"connected"];
	return [c respondsToSelector:@selector(boolValue)] ? @([c boolValue]) : nil;
}

// "320 kbps AAC · home and away" (one tier for both, §2.5), or while automatic quality (or a switch) streams below the
// pick: "320 kbps AAC · now Normal (auto)" (the 0.5 screen's "Very High > Normal (auto)")
- (NSString *)qualityDetail {
	ENPlayback *pb = [ENPlayback shared];
	NSInteger kbps = [ENChoiceViewController qualityKbpsForTier:pb.tier];
	NSString *base = kbps > 0 ? [NSString stringWithFormat:ENL(@"%ld kbps AAC"), (long)kbps] : @"AAC";
	NSString *active = pb.stream ? [ENChoiceViewController qualityTitleForTier:pb.activeTier] : nil;
	if (active && ![pb.activeTier isEqualToString:pb.tier])
		return [NSString stringWithFormat:(pb.autoQuality ? ENL(@"%@ · now %@ (auto)") : ENL(@"%@ · now %@")), base, active];
	return [NSString stringWithFormat:ENL(@"%@ · home and away"), base];
}

// typed lookups (nil when out of range)
static ENSetSection *ENSectionIn(NSArray *sections, NSInteger i) {
	return i >= 0 && i < (NSInteger)sections.count ? (ENSetSection *)sections[i] : nil;
}

static ENSetItem *ENItemIn(NSArray *sections, NSIndexPath *ip) {
	ENSetSection *s = ENSectionIn(sections, ip.section);
	return ip.row >= 0 && ip.row < (NSInteger)s.items.count ? (ENSetItem *)s.items[ip.row] : nil;
}

- (ENSetItem *)itemAt:(NSIndexPath *)ip {
	return ENItemIn(_sections, ip);
}

- (CGFloat)heightOf:(ENSetItem *)it {
	return [ENGroupedCell heightWithTitle:it.title detail:it.detail value:it.value icon:it.icon != nil accessory:it.accessory
	                                width:[self cardWidth]];
}

- (void)configure:(ENSettingsCell *)c item:(ENSetItem *)it {
	c.icon = it.icon;
	c.title = it.title;
	c.detail = it.detail;
	c.value = it.value;
	c.accessory = it.accessory;
	c.centered = it.centered;
	c.destructive = it.destructive;
	c.dot = it.dot;
	c.selectionStyle = it.tappable ? UITableViewCellSelectionStyleBlue : UITableViewCellSelectionStyleNone;
	if (it.accessory == ENGroupedAccessorySwitch) {
		UISwitch *sw = c.toggle;
		[sw removeTarget:self action:@selector(switchChanged:) forControlEvents:UIControlEventValueChanged];
		if (sw.on != it.on) [sw setOn:it.on animated:(c.window != nil)];
		sw.tag = it.kind;
		[sw addTarget:self action:@selector(switchChanged:) forControlEvents:UIControlEventValueChanged];
	}
}

// The values again, applied to the visible rows in place (no reload: a switch mid-animation keeps it). A changed height
// anywhere -> beginUpdates / endUpdates (the table asks every height again); a changed shape -> reloadData.
- (void)refreshValues {
	if (!self.isViewLoaded) return;
	NSArray *old = _sections, *now = [self buildSections];
	BOOL shape = old.count == now.count, heights = NO;
	for (NSUInteger s = 0; shape && s < now.count; s++) {
		NSArray *a = ENSectionIn(old, (NSInteger)s).items, *b = ENSectionIn(now, (NSInteger)s).items;
		if (a.count != b.count) { shape = NO; break; }
		for (NSUInteger r = 0; r < b.count; r++) {
			ENSetItem *x = a[r], *y = b[r];
			if (x.kind != y.kind) { shape = NO; break; }
			if (!heights && ![x isSameAs:y] && [self heightOf:x] != [self heightOf:y]) heights = YES;
		}
	}
	_sections = now;
	UITableView *tv = self.tableView;
	if (!shape) {
		[tv reloadData];
		return;
	}
	for (NSIndexPath *ip in [tv indexPathsForVisibleRows]) {
		ENSetItem *x = ENItemIn(old, ip), *y = [self itemAt:ip];
		if (!y || [x isSameAs:y]) continue;
		UITableViewCell *c = [tv cellForRowAtIndexPath:ip];
		if ([c isKindOfClass:[ENSettingsCell class]]) [self configure:(ENSettingsCell *)c item:y];
	}
	if (heights) {
		[tv beginUpdates];
		[tv endUpdates];
	}
}

#pragma mark - table

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
	return (NSInteger)_sections.count;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	return (NSInteger)ENSectionIn(_sections, section).items.count;
}

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
	return ENSectionIn(_sections, section).header;
}

- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
	return ENSectionIn(_sections, section).footer;
}

- (CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)ip {
	ENSetItem *it = [self itemAt:ip];
	return it ? [self heightOf:it] : 44;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENSettingsCell *c = [tableView dequeueReusableCellWithIdentifier:ENSettingsCellID]
	                    ?: [[ENSettingsCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:ENSettingsCellID];
	ENSetItem *it = [self itemAt:ip];
	if (it) [self configure:c item:it];
	return c;
}

- (NSIndexPath *)tableView:(UITableView *)tableView willSelectRowAtIndexPath:(NSIndexPath *)ip {
	return [self itemAt:ip].tappable ? ip : nil;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	ENSetItem *it = [self itemAt:ip];
	if (it.tappable) [self tapRow:it.kind];
}

- (void)tapRow:(ENSetRow)kind {
	UINavigationController *nav = self.navigationController;
	switch (kind) {
		case ENSetHome:
		case ENSetAway:
			if ([ENAnon on]) {                 // (R2a) the addresses can't be seen or changed while Anonymous Mode is on
				[self show:[[ENAlertView alloc] initWithTitle:ENL(@"Addresses Hidden")
				                                      message:ENL(@"Turn off Anonymous Mode to see or change your Encore Bridge’s addresses.")
				                                     delegate:self cancelButtonTitle:ENL(@"OK") otherButtonTitles:nil] tag:ENSetAlertAddressHidden];
				break;
			}
			[self promptAddress:(kind == ENSetAway)];
			break;
		case ENSetEngine: [self showEngine]; break;
		case ENSetJam: if ([ENJam shared].available) [[ENTabBarController shared] presentJam]; break;
		case ENSetQuality: [nav pushViewController:[ENChoiceViewController qualityViewController] animated:YES]; break;
		case ENSetPlayLink: [self promptPlayLink]; break;
		case ENSetAppearance: [nav pushViewController:[ENChoiceViewController appearanceViewController] animated:YES]; break;
		case ENSetLanguage: [nav pushViewController:[ENChoiceViewController languageViewController] animated:YES]; break;
		case ENSetSpotify:
			[self show:[[ENAlertView alloc] initWithTitle:ENL(@"Signed In on Your Encore Bridge")
			                                      message:ENL(@"Your Spotify login lives on your Encore Bridge, not on this iPhone. To switch accounts, open its admin page on your computer.")
			                                     delegate:self cancelButtonTitle:ENL(@"OK") otherButtonTitles:nil] tag:ENSetAlertSpotify];
			break;
		case ENSetUnpair:
			[self show:[[ENAlertView alloc] initWithTitle:ENL(@"Unpair this iPhone?")
			                                      message:ENL(@"You’ll need a new pairing code from your Encore Bridge’s admin page to connect again.")
			                                     delegate:self cancelButtonTitle:ENL(@"Cancel") otherButtonTitles:ENL(@"Unpair"), nil] tag:ENSetAlertUnpair];
			break;
		case ENSetDiagnostics: [nav pushViewController:[[ENPlayerViewController alloc] init] animated:YES]; break;
		default: break;
	}
}

- (void)switchChanged:(UISwitch *)sw {
	BOOL on = sw.on;
	switch ((ENSetRow)sw.tag) {
		case ENSetAutoReduce: [ENPlayback shared].autoQuality = on; break;
		case ENSetPauseOnUnplug: [ENPlayback shared].pauseOnUnplug = on; break;
		case ENSetExplicit: [ENTheme setShowsExplicitBadges:on]; break;        // lists redraw (ENThemeDidChangeNotification)
		// (R2a) every screen follows at once (ENAnonChangedNotification, then the lists' theme note); the rows here too
		case ENSetAnon: [ENAnon setOn:on]; break;
		case ENSetAnonPlaylists: [ENAnon setHidePlaylistsSetting:on]; break;
#if EN_ENCORE_LINKS
		case ENSetOpenLinks: {
			// the EncoreLinks tweak reads this domain from SpringBoard: write it through at once
			NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
			[ud setBool:on forKey:ENOpenLinksKey];
			[ud synchronize];
			ENLog(@"settings: open spotify links %@", on ? @"on" : @"off");
			break;
		}
#endif
		default: break;
	}
	[self valuesChanged];
}

#pragma mark - Status

// ENGateway's probe picks the route (home first, 1.5 s, then away); one timed GET / on that route gives the latency (the
// probe's own time would include a failed home attempt when away). One check at a time; a check asked for meanwhile (a
// saved address) runs right after.
- (void)checkStatus {
	ENGateway *gw = [ENGateway shared];
	if (!gw.paired) return;
	if (_checking) { _recheck = YES; return; }
	_checking = YES;
	_recheck = NO;
	__weak ENSettingsViewController *weakSelf = self;
	[gw probe:^(BOOL reachable) {
		ENSettingsViewController *s = weakSelf;
		if (!s) return;
		if (!reachable) [s statusDone:ENSetStatusOffline away:gw.away ms:-1];
		else [s timeRoute:gw.baseURL away:gw.away];
	}];
}

- (void)timeRoute:(NSString *)base away:(BOOL)away {
	NSURL *url = base.length ? [NSURL URLWithString:[base stringByAppendingString:@"/"]] : nil;
	if (!url) { [self statusDone:ENSetStatusOnline away:away ms:-1]; return; }
	NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:6];
	CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
	__weak ENSettingsViewController *weakSelf = self;
	[NSURLConnection sendAsynchronousRequest:r queue:[NSOperationQueue mainQueue] completionHandler:^(NSURLResponse *resp, NSData *data, NSError *err) {
		ENSettingsViewController *s = weakSelf;
		if (!s) return;
		BOOL ok = !err && [resp isKindOfClass:[NSHTTPURLResponse class]] && [(NSHTTPURLResponse *)resp statusCode] == 200;
		NSInteger ms = ok ? (NSInteger)lround((CFAbsoluteTimeGetCurrent() - t0) * 1000) : -1;
		[s statusDone:ENSetStatusOnline away:away ms:ms];      // the probe answered: a failed timing only loses the ms
	}];
}

- (void)statusDone:(ENSetStatusState)state away:(BOOL)away ms:(NSInteger)ms {
	_checking = NO;
	_status = state;
	_statusAway = away;
	_latencyMs = ms;
	ENLog(@"settings: gateway %@%@", state == ENSetStatusOffline ? @"offline" : away ? @"away" : @"home",
	      ms >= 0 ? [NSString stringWithFormat:@" %ld ms", (long)ms] : @"");
	[self valuesChanged];
	if (_recheck && self.visible) [self checkStatus];
	else _recheck = NO;
}

#pragma mark - Account

// your name: the library's me.n until GET /v1/me answers (cached copy first, then the network); asked once, and again on the
// next appear after a failure
- (void)loadName {
	if (_nameAsked) return;
	_nameAsked = YES;
	__weak ENSettingsViewController *weakSelf = self;
	[[ENCatalog shared] loadProfile:NO done:^(id result, BOOL fromCache, NSError *error) {
		ENSettingsViewController *s = weakSelf;
		if (!s) return;
		// (R2a) the real name (the getter says "You" while Anonymous Mode is on; the row shows "Signed in" then)
		NSString *name = [result isKindOfClass:[ENProfile class]] ? [(ENProfile *)result rawName] : nil;
		if (name.length) {
			s->_spotifyName = [name copy];
			[s valuesChanged];
		} else if (error && !s->_spotifyName) {
			s->_nameAsked = NO;
		}
	}];
}

#pragma mark - alerts

// one at a time; every alert has this screen as its delegate and a tag (ENSetAlert)
- (void)show:(UIAlertView *)a tag:(ENSetAlert)tag {
	if (_alert) return;
	a.tag = tag;
	_alert = a;
	[a show];
}

- (void)styleURLField:(UITextField *)f {
	f.keyboardType = UIKeyboardTypeURL;
	f.autocorrectionType = UITextAutocorrectionTypeNo;
	f.autocapitalizationType = UITextAutocapitalizationTypeNone;
	f.clearButtonMode = UITextFieldViewModeWhileEditing;
}

- (void)promptAddress:(BOOL)away {
	if (_alert) return;
	ENGateway *gw = [ENGateway shared];
	ENAlertView *a = [[ENAlertView alloc] initWithTitle:(away ? ENL(@"Away Address") : ENL(@"Home Address"))
	                                            message:(away ? ENL(@"Used when the home address doesn’t answer. Your router forwards TCP 8095 to the computer running your Encore Bridge.")
	                                                          : ENL(@"LAN address of your Encore Bridge. Tried first, with a 1.5 s timeout."))
	                                           delegate:self cancelButtonTitle:ENL(@"Cancel") otherButtonTitles:ENL(@"Save"), nil];
	a.alertViewStyle = UIAlertViewStylePlainTextInput;
	UITextField *f = [a textFieldAtIndex:0];
	[self styleURLField:f];
	f.placeholder = away ? @"http://your-public-ip:8095" : @"http://192.168.1.20:8095";
	f.text = away ? gw.awayURL : gw.homeURL;
	[self show:a tag:(away ? ENSetAlertAway : ENSetAlertHome)];
}

// Trimmed; http:// in front when no scheme was typed; then it must be http(s) with a host and nothing after host[:port]
// (an admin page's /admin, or "http:/host" turned into host "http", would make every request miss). Empty: the Away
// address goes (None); Home's Save button is off while its field is empty.
- (void)saveAddress:(NSString *)text away:(BOOL)away {
	NSString *s = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	if (!s.length) {
		if (!away) return;
		[ENGateway shared].awayURL = @"";
		ENLog(@"settings: away address cleared");
		[self valuesChanged];
		[self checkStatus];
		return;
	}
	if ([s rangeOfString:@"://"].location == NSNotFound) s = [@"http://" stringByAppendingString:s];
	NSURL *u = [NSURL URLWithString:s];
	NSString *scheme = u.scheme.lowercaseString;
	BOOL extra = (u.path.length && ![u.path isEqualToString:@"/"]) || u.query.length || u.fragment.length || u.user.length
	             || u.password.length || u.parameterString.length;
	if (!u.host.length || extra || !([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"])) {
		[self show:[[ENAlertView alloc] initWithTitle:ENL(@"Not an Address")
		                                      message:ENL(@"Type your Encore Bridge’s address and port, like 192.168.1.20:8095.")
		                                     delegate:self cancelButtonTitle:ENL(@"OK") otherButtonTitles:nil] tag:ENSetAlertBadAddress];
		return;
	}
	ENGateway *gw = [ENGateway shared];
	if (away) gw.awayURL = s;
	else gw.homeURL = s;
	ENLog(@"settings: %@ address changed", away ? @"away" : @"home");
	[self valuesChanged];
	[self checkStatus];               // the route again, with the new address
}

- (void)showEngine {
	NSNumber *connected = [self engineConnected];
	NSString *state = !connected ? ENL(@"Encore hasn’t heard from it yet.")
	                  : connected.boolValue ? ENL(@"It’s connected to your Encore Bridge and ready to play.")
	                  : ENL(@"Your Encore Bridge can’t reach it right now; it tries again every few seconds.");
	NSString *gv = [ENCatalog shared].gatewayVersion;
	NSString *msg = [NSString stringWithFormat:ENL(@"go-librespot with Encore’s patches plays Spotify on your Encore Bridge. %@\n\nEncore Bridge %@"),
	                 state, gv.length ? gv : ENL(@"(version unknown)")];
	[self show:[[ENAlertView alloc] initWithTitle:ENL(@"Engine") message:msg delegate:self cancelButtonTitle:ENL(@"OK") otherButtonTitles:nil]
	       tag:ENSetAlertEngine];
}

// SET3: prefilled when the clipboard holds a Spotify or Jam link (as the 0.5 link field did on focus)
- (void)promptPlayLink {
	if (_alert) return;
	ENAlertView *a = [[ENAlertView alloc] initWithTitle:ENL(@"Play a Link")
	                                            message:ENL(@"A song, album, playlist or artist link plays; a Jam link offers to join.")
	                                           delegate:self cancelButtonTitle:ENL(@"Cancel") otherButtonTitles:ENL(@"Play"), nil];
	a.alertViewStyle = UIAlertViewStylePlainTextInput;
	UITextField *f = [a textFieldAtIndex:0];
	[self styleURLField:f];
	f.placeholder = ENL(@"open.spotify.com/… or spotify:…");
	// (not in Anonymous Mode: a copied Jam invite is a live join link, and a pasted link can name a person)
	NSString *clip = [ENAnon on] ? nil : [UIPasteboard generalPasteboard].string;
	if (clip.length && ([ENPlayback uriFromLink:clip] || [ENJam isJamLink:clip])) f.text = clip;
	[self show:a tag:ENSetAlertPlayLink];
}

- (void)playLink:(NSString *)text {
	NSString *s = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	if (!s.length) return;
	if ([ENJam isJamLink:s]) {                   // a Jam is joined (after its prompt), never played (DESIGN-4b §6.6)
		[ENJamActions offerJoinLink:s];
		return;
	}
	if (![[ENPlayback shared] playLink:s]) {
		[self show:[[ENAlertView alloc] initWithTitle:ENL(@"Not a Spotify link")
		                                      message:ENL(@"Paste a song, album, playlist or artist link (open.spotify.com/... or spotify:...). Podcasts aren't supported.")
		                                     delegate:self cancelButtonTitle:ENL(@"OK") otherButtonTitles:nil] tag:ENSetAlertNotALink];
	}
}

// Save / Play stay off while the field is empty (not the Away address's: empty there means None)
- (BOOL)alertViewShouldEnableFirstOtherButton:(UIAlertView *)a {
	if (a.alertViewStyle != UIAlertViewStylePlainTextInput || a.tag == ENSetAlertAway) return YES;
	NSString *t = [[a textFieldAtIndex:0].text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	return t.length > 0;
}

// didDismiss, not clickedButton: the alert's last delegate call. Its text is read before anything else runs; a follow-up
// alert (Not an Address, Not a Spotify link) can show because _alert is cleared first. Unpair: showSetup swaps the window's
// root, which frees the tab controller and this screen, so it comes last and nothing touches self after it.
- (void)alertView:(UIAlertView *)a didDismissWithButtonIndex:(NSInteger)i {
	a.delegate = nil;
	if (a == _alert) _alert = nil;
	BOOL confirmed = i != a.cancelButtonIndex && i == a.firstOtherButtonIndex;
	NSString *text = a.alertViewStyle == UIAlertViewStylePlainTextInput ? [a textFieldAtIndex:0].text : nil;
	switch ((ENSetAlert)a.tag) {
		case ENSetAlertHome:
		case ENSetAlertAway:
			if (confirmed) [self saveAddress:text away:(a.tag == ENSetAlertAway)];
			break;
		case ENSetAlertPlayLink:
			if (confirmed) [self playLink:text];
			break;
		case ENSetAlertUnpair:
			if (!confirmed) break;
			[self stopObserving];
			if ([ENPlayback shared].playing) [[ENPlayback shared] pause];
			[[ENGateway shared] unpair];
			[(ENAppDelegate *)[UIApplication sharedApplication].delegate showSetup];
			return;
		default:
			break;
	}
}

@end

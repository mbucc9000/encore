#import "ENChoiceViewController.h"
#import "ENTheme.h"
#import "ENListCell.h"
#import "ENPlayback.h"

// See ENChoiceViewController.h. Rows are ENGroupedCells (ENGroupedViewController.m); the check is the cell's
// ENGroupedAccessoryCheck, and every option's height is measured as if it had the check, so moving it never changes a row.

static NSString *const ENChoicePreviewID = @"ENChoicePreview";
static const CGFloat ENPreviewPad = 10;      // around the Appearance sample row, inside its card (clear of the rounded corners)
static const NSInteger ENPreviewTag = 0x454e50;     // "ENP": a preview view in its row

// one section of options
@interface ENChoiceSection : NSObject
@property (nonatomic, copy) NSString *header, *footer;
@property (nonatomic, copy) NSArray *titles, *details;
@property (nonatomic) NSInteger chosen;                      // -1 = none
@property (nonatomic, copy) void (^onChoose)(NSInteger index);
@property (nonatomic, copy) UIView *(^makePreview)(CGFloat width);
@property (nonatomic, strong) UIView *preview;               // made by makePreview, kept until the next theme reload
@property (nonatomic, strong) UIColor *previewFill;          // its backgroundColor (the card's fill behind it)
@end

@implementation ENChoiceSection
@end

@implementation ENChoiceViewController {
	NSMutableArray *_sections;      // ENChoiceSection
}

- (id)initWithTitle:(NSString *)title {
	if ((self = [super init])) {
		_sections = [NSMutableArray array];
		[[ENTheme current] applyTitle:title toItem:self.navigationItem small:YES];      // the mockup's small title
	}
	return self;
}

- (id)initWithTitle:(NSString *)title header:(NSString *)header titles:(NSArray *)titles details:(NSArray *)details
             chosen:(NSInteger)chosen footer:(NSString *)footer onChoose:(void (^)(NSInteger index))onChoose {
	if ((self = [self initWithTitle:title]))
		[self addSectionWithHeader:header titles:titles details:details chosen:chosen footer:footer onChoose:onChoose];
	return self;
}

- (NSInteger)addSectionWithHeader:(NSString *)header titles:(NSArray *)titles details:(NSArray *)details chosen:(NSInteger)chosen
                           footer:(NSString *)footer onChoose:(void (^)(NSInteger index))onChoose {
	ENChoiceSection *s = [[ENChoiceSection alloc] init];
	s.header = header;
	s.footer = footer;
	s.titles = titles ?: @[];
	s.details = details;
	s.chosen = chosen >= 0 && chosen < (NSInteger)s.titles.count ? chosen : -1;
	s.onChoose = onChoose;
	if (!_sections) _sections = [NSMutableArray array];      // (a plain -init)
	[_sections addObject:s];
	if (self.isViewLoaded) [self.tableView reloadData];
	return (NSInteger)_sections.count - 1;
}

- (ENChoiceSection *)sectionAt:(NSInteger)i {
	return i >= 0 && i < (NSInteger)_sections.count ? _sections[i] : nil;
}

- (NSInteger)chosenInSection:(NSInteger)section {
	ENChoiceSection *s = [self sectionAt:section];
	return s ? s.chosen : -1;
}

- (void)setChosen:(NSInteger)index inSection:(NSInteger)section {
	ENChoiceSection *s = [self sectionAt:section];
	if (!s) return;
	s.chosen = index >= 0 && index < (NSInteger)s.titles.count ? index : -1;
	[self showChecksInSection:section];
}

- (void)setPreviewInSection:(NSInteger)section view:(UIView *(^)(CGFloat width))make {
	ENChoiceSection *s = [self sectionAt:section];
	if (!s) return;
	s.makePreview = make;
	s.preview = nil;
	if (self.isViewLoaded) [self.tableView reloadData];
}

// the check on the visible option rows of a section, without a reload (the row's selection fades out undisturbed)
- (void)showChecksInSection:(NSInteger)section {
	if (!self.isViewLoaded) return;
	ENChoiceSection *s = [self sectionAt:section];
	UITableView *tv = self.tableView;
	for (NSIndexPath *ip in [tv indexPathsForVisibleRows]) {
		if (ip.section != section || ip.row >= (NSInteger)s.titles.count) continue;
		UITableViewCell *c = [tv cellForRowAtIndexPath:ip];
		if ([c isKindOfClass:[ENGroupedCell class]])
			((ENGroupedCell *)c).accessory = ip.row == s.chosen ? ENGroupedAccessoryCheck : ENGroupedAccessoryNone;
	}
}

#pragma mark - theme, preview

// a theme or text-size change: the previews are made again for the new palette and size, then the base reloads
- (void)themeDidChange {
	for (ENChoiceSection *s in _sections) s.preview = nil;
	[super themeDidChange];
}

- (UIView *)previewIn:(ENChoiceSection *)s {
	if (!s.makePreview) return nil;
	if (!s.preview) {
		UIView *v = s.makePreview([self cardWidth]);
		s.previewFill = v.backgroundColor;
		v.backgroundColor = [UIColor clearColor];
		v.opaque = NO;
		v.autoresizingMask = UIViewAutoresizingFlexibleWidth;      // the card's width; its height is the row's (set here)
		s.preview = v;
	}
	return s.preview;
}

- (BOOL)isPreview:(NSIndexPath *)ip {
	ENChoiceSection *s = [self sectionAt:ip.section];
	return s.makePreview && ip.row == (NSInteger)s.titles.count;
}

- (NSString *)detailIn:(ENChoiceSection *)s row:(NSInteger)row {
	id d = row >= 0 && row < (NSInteger)s.details.count ? s.details[row] : nil;
	return [d isKindOfClass:[NSString class]] && [(NSString *)d length] ? d : nil;
}

#pragma mark - table

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
	return (NSInteger)_sections.count;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
	ENChoiceSection *s = [self sectionAt:section];
	return (NSInteger)s.titles.count + (s.makePreview ? 1 : 0);
}

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
	return [self sectionAt:section].header;
}

- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
	return [self sectionAt:section].footer;
}

- (CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)ip {
	ENChoiceSection *s = [self sectionAt:ip.section];
	if ([self isPreview:ip]) return MAX(ceilf([self previewIn:s].frame.size.height), 1);
	NSString *title = ip.row < (NSInteger)s.titles.count ? s.titles[ip.row] : nil;
	return [ENGroupedCell heightWithTitle:title detail:[self detailIn:s row:ip.row] value:nil icon:NO
	                            accessory:ENGroupedAccessoryCheck width:[self cardWidth]];
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)ip {
	ENChoiceSection *s = [self sectionAt:ip.section];
	if ([self isPreview:ip]) {
		ENGroupedCell *c = [tableView dequeueReusableCellWithIdentifier:ENChoicePreviewID]
		                   ?: [[ENGroupedCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:ENChoicePreviewID];
		c.selectionStyle = UITableViewCellSelectionStyleNone;
		UIView *p = [self previewIn:s];
		c.fill = s.previewFill;
		for (UIView *v in [c.contentView.subviews copy]) {
			if (v != p && v.tag == ENPreviewTag) [v removeFromSuperview];      // an older preview (before a theme reload)
		}
		if (p && p.superview != c.contentView) {
			[p removeFromSuperview];
			p.tag = ENPreviewTag;
			p.frame = CGRectMake(0, 0, c.contentView.bounds.size.width, p.frame.size.height);
			[c.contentView addSubview:p];
		}
		return c;
	}
	ENGroupedCell *c = [tableView dequeueReusableCellWithIdentifier:[ENGroupedCell reuseIdentifier]]
	                   ?: [[ENGroupedCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:[ENGroupedCell reuseIdentifier]];
	c.title = ip.row < (NSInteger)s.titles.count ? s.titles[ip.row] : nil;
	c.detail = [self detailIn:s row:ip.row];
	c.accessory = ip.row == s.chosen ? ENGroupedAccessoryCheck : ENGroupedAccessoryNone;
	return c;
}

- (NSIndexPath *)tableView:(UITableView *)tableView willSelectRowAtIndexPath:(NSIndexPath *)ip {
	return [self isPreview:ip] ? nil : ip;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)ip {
	[tableView deselectRowAtIndexPath:ip animated:YES];
	ENChoiceSection *s = [self sectionAt:ip.section];
	if (!s || ip.row >= (NSInteger)s.titles.count || ip.row == s.chosen) return;
	s.chosen = ip.row;
	[self showChecksInSection:ip.section];         // the check moves at once ...
	void (^choose)(NSInteger) = s.onChoose;
	if (choose) choose(ip.row);                    // ... then the setting (a palette flip re-skins this screen in place)
}

#pragma mark - Appearance (A5)

// the sample row: the song that is playing (its name, artists and cover), else a placeholder song
static void ENFillPreviewRow(ENListCell *row) {
	ENPlayback *pb = [ENPlayback shared];
	NSDictionary *t = pb.track;
	NSString *name = [t[@"name"] isKindOfClass:[NSString class]] && [(NSString *)t[@"name"] length] ? t[@"name"] : nil;
	NSMutableArray *artists = [NSMutableArray array];
	if (name && [t[@"artists"] isKindOfClass:[NSArray class]]) {
		for (id a in t[@"artists"]) if ([a isKindOfClass:[NSString class]]) [artists addObject:a];
	}
	row.art = ENCellArtCover;
	row.title = name ?: @"Song Title";
	row.subtitle = name ? [artists componentsJoinedByString:@", "] : @"Artist";
	row.image = name ? pb.artwork : nil;        // nil = the palette's cover placeholder
	row.showsMore = YES;
}

+ (ENChoiceViewController *)appearanceViewController {
	static const ENTextSize sizes[] = { ENTextSizeSmall, ENTextSizeDefault, ENTextSizeLarge };
	NSInteger size = 1;
	for (NSInteger i = 0; i < 3; i++) {
		if (sizes[i] == [ENTheme textSize]) size = i;
	}

	ENChoiceViewController *vc = [[ENChoiceViewController alloc] initWithTitle:@"Appearance"];
#if EN_DARK_MODE
	// (A6, 0.10: compiled out while ENTheme.h's EN_DARK_MODE is 0, so Text size is the only section; sections are numbered
	// as they are added, so its index, header, footer and selection follow either way)
	static const ENAppearance looks[] = { ENAppearanceLight, ENAppearanceDark, ENAppearanceAutomatic };
	NSInteger look = 0;
	for (NSInteger i = 0; i < 3; i++) {
		if (looks[i] == [ENTheme appearance]) look = i;
	}
	[vc addSectionWithHeader:@"Theme"
	                  titles:@[ @"Light", @"Dark", @"Automatic" ]
	                 details:@[ @"Light lists, green bars: the classic 2012 look", @"Dark lists and pages, easier at night",
	                            @"Dark from 7 PM to 7 AM, light during the day" ]
	                  chosen:look
	                  footer:@"Bars, the mini player and Now Playing stay dark green either way. iOS 6 has no system dark mode, so Encore keeps its own setting."
	                onChoose:^(NSInteger i) { if (i >= 0 && i < 3) [ENTheme setAppearance:looks[i]]; }];
#endif

	NSInteger text = [vc addSectionWithHeader:@"Text size"
	                                   titles:@[ @"Small", @"Default", @"Large" ]
	                                  details:nil
	                                   chosen:size
	                                   footer:@"Applies to the rows in every list; covers keep their size."
	                                 onChoose:^(NSInteger i) { if (i >= 0 && i < 3) [ENTheme setTextSize:sizes[i]]; }];
	// a real list row at the chosen size (+[ENTheme rowHeight] and the row fonts), on the list background, re-made on every
	// theme or text-size change (ENThemeDidChangeNotification)
	[vc setPreviewInSection:text view:^UIView *(CGFloat width) {
		ENTheme *th = [ENTheme current];
		CGFloat rh = th.rowHeight;
		UIView *box = [[UIView alloc] initWithFrame:CGRectMake(0, 0, width, rh + 2 * ENPreviewPad)];
		box.backgroundColor = th.listBackground;          // the card's fill behind the row
		ENListCell *row = [[ENListCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
		row.frame = CGRectMake(1, ENPreviewPad, MAX(width - 2, 1), rh);
		row.autoresizingMask = UIViewAutoresizingFlexibleWidth;
		row.userInteractionEnabled = NO;                  // a picture of a row: no •••, no swipe
		ENFillPreviewRow(row);
		[box addSubview:row];
		return box;
	}];
	return vc;
}

#pragma mark - Streaming Quality (B4)

static NSString *const ENQualityTitles[4] = { @"Very High", @"High", @"Normal", @"Low" };      // ENTierNames order
static const NSInteger ENQualityKbps[4] = { 320, 256, 160, 96 };                              // the gateway's tiers

static NSInteger ENQualityIndex(NSString *tier) {
	for (NSInteger i = 0; i < 4; i++) if ([ENTierNames[i] isEqualToString:tier]) return i;
	return -1;
}

+ (NSString *)qualityTitleForTier:(NSString *)tier {
	NSInteger i = ENQualityIndex(tier);
	return i >= 0 ? ENQualityTitles[i] : nil;
}

+ (NSInteger)qualityKbpsForTier:(NSString *)tier {
	NSInteger i = ENQualityIndex(tier);
	return i >= 0 ? ENQualityKbps[i] : 0;
}

+ (ENChoiceViewController *)qualityViewController {
	NSInteger chosen = ENQualityIndex([ENPlayback shared].tier);
	// the mockup's lines; MB per hour = kbps x 3600 / 8 / 1000
	NSArray *details = @[ @"320 kbps AAC · about 144 MB per hour. The best Encore streams.",
	                      @"256 kbps AAC · about 115 MB per hour",
	                      @"160 kbps AAC · about 72 MB per hour",
	                      @"96 kbps AAC · about 43 MB per hour" ];
	return [[ENChoiceViewController alloc] initWithTitle:@"Streaming Quality"
	                                              header:@"Streaming Quality"
	                                              titles:@[ ENQualityTitles[0], ENQualityTitles[1], ENQualityTitles[2], ENQualityTitles[3] ]
	                                             details:details
	                                              chosen:chosen
	                                              footer:@"Your Encore Bridge plays Spotify with go-librespot and encodes it to AAC at this bitrate. The iPhone decodes AAC in hardware, so Very High costs almost no battery. With Auto-Reduce Quality on, Encore steps down when the network is slow and back up when it recovers."
	                                            onChoose:^(NSInteger i) { if (i >= 0 && i < 4) [ENPlayback shared].tier = ENTierNames[i]; }];
}

@end

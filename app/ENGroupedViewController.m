#import "ENGroupedViewController.h"
#import "ENTheme.h"
#import "ENTabBarController.h"

// See ENGroupedViewController.h. The metrics are the mockup's (.g-head, .g-foot, .g-sec, .g-cell, .g-ic); the colours and
// fonts are ENTheme's grouped tokens (§1.4, §1.5), read again on every theme change.

static const CGFloat ENGPad = 10;          // a row's side padding
static const CGFloat ENGGap = 9;           // between the icon, the text, the value and the accessory
static const CGFloat ENGIcon = 29;         // the icon tile
static const CGFloat ENGVPad = 7;          // above and below a two-line row's text
static const CGFloat ENGDetailTop = 2;     // between the title and the detail
static const CGFloat ENGMinHeight = 44;
static const CGFloat ENGMinTitle = 60;     // a value never squeezes the title below this
static const CGFloat ENGSwitchWidth = 79;  // the iOS 6 UISwitch (measured before a switch exists)
static const CGFloat ENGTextInset = 19;    // headers and footers, from the screen edge
static const CGFloat ENGHeaderTop = 18;    // above a header (and the gap where a section has none)
static const CGFloat ENGHeaderBottom = 6;
static const CGFloat ENGFooterTop = 6;
static const CGFloat ENGFooterBottom = 6;
static const CGFloat ENGNoFooter = 2;      // a section without a footer (the next header's 18 pt makes the gap)
static const NSInteger ENGSelectionTag = 0x454e47;     // "ENG": a selectedBackgroundView the base made

// the text column of a row `width` wide: [x, right), and the value's width (0 = none) right of it
typedef struct { CGFloat x, right, valueWidth; } ENGColumns;

static CGFloat ENGAccessoryWidth(ENGroupedAccessory a, UIView *view) {
	switch (a) {
		case ENGroupedAccessoryChevron: return 13;
		case ENGroupedAccessoryCheck: return 16;
		case ENGroupedAccessorySwitch: return view ? view.bounds.size.width : ENGSwitchWidth;
		default: return 0;
	}
}

static ENGColumns ENGLayoutColumns(CGFloat width, BOOL icon, NSString *value, UIFont *valueFont, CGFloat accessoryWidth) {
	ENGColumns c;
	c.x = ENGPad + (icon ? ENGIcon + ENGGap : 0);
	c.right = width - ENGPad;
	if (accessoryWidth > 0) c.right -= accessoryWidth + ENGGap;
	c.valueWidth = 0;
	if (value.length) {
		CGFloat vw = ceilf([value sizeWithFont:valueFont].width);
		c.valueWidth = MIN(vw, MAX(c.right - c.x - ENGGap - ENGMinTitle, 0));
		if (c.valueWidth > 0) c.right -= c.valueWidth + ENGGap;
	}
	return c;
}

static CGFloat ENGDetailHeight(NSString *detail, UIFont *font, CGFloat width) {
	if (!detail.length) return 0;
	return ceilf([detail sizeWithFont:font constrainedToSize:CGSizeMake(MAX(width, 1), 10000) lineBreakMode:NSLineBreakByWordWrapping].height);
}

#pragma mark - row

@implementation ENGroupedCell {
	UIImageView *_iconView;
	UILabel *_titleLabel, *_detailLabel, *_valueLabel;
	UIImageView *_accessoryImage;      // the chevron or the check (highlighted: the white glyph)
	UISwitch *_toggle;
}

+ (NSString *)reuseIdentifier { return @"ENGroupedCell"; }

+ (CGFloat)heightWithTitle:(NSString *)title detail:(NSString *)detail value:(NSString *)value icon:(BOOL)icon
                 accessory:(ENGroupedAccessory)accessory width:(CGFloat)width {
	if (!detail.length) return ENGMinHeight;
	ENTheme *th = [ENTheme current];
	ENGColumns c = ENGLayoutColumns(width, icon, value, th.groupedValueFont, ENGAccessoryWidth(accessory, nil));
	CGFloat h = ENGVPad + ceilf(th.groupedLabelFont.lineHeight) + ENGDetailTop + ENGDetailHeight(detail, th.groupedSmallFont, c.right - c.x) + ENGVPad;
	return MAX(ENGMinHeight, h);
}

- (id)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)rid {
	if ((self = [super initWithStyle:UITableViewCellStyleDefault reuseIdentifier:rid])) {
		ENTheme *th = [ENTheme current];
		UIView *cv = self.contentView;
		_iconView = [[UIImageView alloc] initWithFrame:CGRectZero];
		_iconView.contentMode = UIViewContentModeCenter;
		_iconView.hidden = YES;
		[cv addSubview:_iconView];
		_titleLabel = [self label:th.groupedLabelFont];
		_detailLabel = [self label:th.groupedSmallFont];
		_detailLabel.numberOfLines = 0;
		_detailLabel.lineBreakMode = NSLineBreakByWordWrapping;
		_valueLabel = [self label:th.groupedValueFont];
		_valueLabel.textAlignment = NSTextAlignmentRight;
		_accessoryImage = [[UIImageView alloc] initWithFrame:CGRectZero];
		_accessoryImage.contentMode = UIViewContentModeCenter;
		_accessoryImage.hidden = YES;
		[cv addSubview:_accessoryImage];
		[self applyTheme];
	}
	return self;
}

- (UILabel *)label:(UIFont *)font {
	UILabel *l = [[UILabel alloc] initWithFrame:CGRectZero];
	l.font = font;
	l.backgroundColor = [UIColor clearColor];
	l.lineBreakMode = NSLineBreakByTruncatingTail;
	[self.contentView addSubview:l];
	return l;
}

- (void)prepareForReuse {
	[super prepareForReuse];
	[_toggle removeTarget:nil action:NULL forControlEvents:UIControlEventAllEvents];
	_icon = nil;
	_title = _detail = _value = nil;
	_accessory = ENGroupedAccessoryNone;
	_centered = _destructive = NO;
	_fill = nil;
	_iconView.image = nil;
	_titleLabel.text = _detailLabel.text = _valueLabel.text = nil;
	self.selectionStyle = UITableViewCellSelectionStyleBlue;      // (the green selectedBackgroundView shows; None = not tappable)
	[self applyTheme];
	[self setNeedsLayout];
}

- (void)setIcon:(UIImage *)icon { _icon = icon; _iconView.image = icon; [self setNeedsLayout]; }
- (void)setTitle:(NSString *)title { _title = [title copy]; _titleLabel.text = title; [self setNeedsLayout]; }
- (void)setDetail:(NSString *)detail { _detail = [detail copy]; _detailLabel.text = detail; [self setNeedsLayout]; }
- (void)setValue:(NSString *)value { _value = [value copy]; _valueLabel.text = value; [self setNeedsLayout]; }
- (void)setCentered:(BOOL)centered { _centered = centered; [self setNeedsLayout]; }
- (void)setDestructive:(BOOL)destructive { _destructive = destructive; [self applyTheme]; }

- (void)setAccessory:(ENGroupedAccessory)accessory {
	if (_accessory == accessory) return;
	_accessory = accessory;
	[self applyTheme];
	[self setNeedsLayout];
}

- (UISwitch *)toggle {
	if (!_toggle) {
		_toggle = [[UISwitch alloc] initWithFrame:CGRectZero];
		_toggle.hidden = _accessory != ENGroupedAccessorySwitch;
		[self.contentView addSubview:_toggle];
		[self setNeedsLayout];
	}
	return _toggle;
}

- (void)applyTheme {
	ENTheme *th = [ENTheme current];
	_titleLabel.textColor = _destructive ? th.jamRed : th.groupedLabel;
	_titleLabel.highlightedTextColor = th.cellSelectedTitle;
	_detailLabel.textColor = th.groupedSmall;
	_detailLabel.highlightedTextColor = th.cellSelectedSub;
	_valueLabel.textColor = th.groupedValue;
	_valueLabel.highlightedTextColor = th.cellSelectedTitle;
	if (_accessory == ENGroupedAccessoryChevron) {
		_accessoryImage.image = th.groupedChevronImage;
		_accessoryImage.highlightedImage = [th glyphNamed:@"chevRight" size:13 color:th.cellSelectedTitle];
	} else if (_accessory == ENGroupedAccessoryCheck) {
		_accessoryImage.image = th.groupedCheckImage;
		_accessoryImage.highlightedImage = [th glyphNamed:@"check" size:16 color:th.cellSelectedTitle];
	} else {
		_accessoryImage.image = _accessoryImage.highlightedImage = nil;
	}
	_accessoryImage.hidden = _accessoryImage.image == nil;
	if (_accessory == ENGroupedAccessorySwitch) (void)self.toggle;
	_toggle.hidden = _accessory != ENGroupedAccessorySwitch;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGRect b = self.contentView.bounds;
	CGFloat w = b.size.width, h = b.size.height;
	CGFloat titleH = ceilf(_titleLabel.font.lineHeight);
	if (_centered) {
		_titleLabel.textAlignment = NSTextAlignmentCenter;
		_titleLabel.frame = CGRectMake(ENGPad, floorf((h - titleH) / 2), MAX(w - 2 * ENGPad, 1), titleH);
		_detailLabel.frame = _valueLabel.frame = _accessoryImage.frame = CGRectZero;
		_iconView.hidden = YES;
		return;
	}
	_titleLabel.textAlignment = NSTextAlignmentLeft;

	_iconView.hidden = _icon == nil;
	if (_icon) _iconView.frame = CGRectMake(ENGPad, floorf((h - ENGIcon) / 2), ENGIcon, ENGIcon);

	UIView *acc = _accessory == ENGroupedAccessorySwitch ? _toggle : _accessory != ENGroupedAccessoryNone ? _accessoryImage : nil;
	CGFloat aw = ENGAccessoryWidth(_accessory, _accessory == ENGroupedAccessorySwitch ? _toggle : nil);
	if (acc) {
		CGFloat ah = acc == _toggle ? _toggle.bounds.size.height : _accessoryImage.image.size.height;
		acc.frame = CGRectMake(w - ENGPad - aw, floorf((h - ah) / 2), aw, ah);
	}

	ENGColumns c = ENGLayoutColumns(w, _icon != nil, _value, _valueLabel.font, aw);
	CGFloat valueH = ceilf(_valueLabel.font.lineHeight);
	_valueLabel.frame = c.valueWidth > 0 ? CGRectMake(c.right + ENGGap, floorf((h - valueH) / 2), c.valueWidth, valueH) : CGRectZero;

	CGFloat tw = MAX(c.right - c.x, 1);
	CGFloat dh = ENGDetailHeight(_detail, _detailLabel.font, tw);
	CGFloat block = titleH + (dh > 0 ? ENGDetailTop + dh : 0);
	CGFloat top = floorf((h - block) / 2);
	_titleLabel.frame = CGRectMake(c.x, top, tw, titleH);
	_detailLabel.frame = dh > 0 ? CGRectMake(c.x, top + titleH + ENGDetailTop, tw, dh) : CGRectZero;
}

@end

#pragma mark - controller

@implementation ENGroupedViewController {
	BOOL _themeDirty;      // a switch arrived while hidden: re-skin in the next viewWillAppear
}

- (id)init {
	return [self initWithStyle:UITableViewStyleGrouped];
}

- (id)initWithStyle:(UITableViewStyle)style {
	return [super initWithStyle:UITableViewStyleGrouped];
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)viewDidLoad {
	[super viewDidLoad];
	[self applyTableTheme];
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(themeNote:) name:ENThemeDidChangeNotification object:nil];
	[nc addObserver:self selector:@selector(miniLayout:) name:ENMiniPlayerLayoutNotification object:nil];
}

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	_visible = YES;
	[self applyMiniInset:[ENTabBarController shared].miniPlayerHeight];
	if (_themeDirty) [self themeDidChange];
}

- (void)viewDidAppear:(BOOL)animated {
	[super viewDidAppear:animated];
	if (self.tabBarController) [[ENTabBarController shared] reclaimFirstResponder];     // P6 (a modal subclass does its own)
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	_visible = NO;
}

- (NSUInteger)supportedInterfaceOrientations { return UIInterfaceOrientationMaskPortrait; }

#pragma mark - theme

- (void)applyTableTheme {
	ENTheme *th = [ENTheme current];
	UITableView *tv = self.tableView;
	tv.backgroundView = nil;
	tv.backgroundColor = th.groupedPattern;
	tv.separatorColor = th.groupedBorder;
	tv.separatorStyle = th.isDark ? UITableViewCellSeparatorStyleSingleLine : UITableViewCellSeparatorStyleSingleLineEtched;
	tv.indicatorStyle = th.indicatorStyle;
}

- (void)themeNote:(NSNotification *)n {
	if (!self.isViewLoaded) return;          // viewDidLoad reads the palette then
	if (_visible) [self themeDidChange];
	else _themeDirty = YES;
}

- (void)themeDidChange {
	_themeDirty = NO;
	if (!self.isViewLoaded) return;
	[self applyTableTheme];
	[self.tableView reloadData];
}

#pragma mark - mini player, scrolling

- (void)miniLayout:(NSNotification *)n {
	[self applyMiniInset:[n.userInfo[ENMiniPlayerHeightKey] floatValue]];
}

// only .bottom (as the list base)
- (void)applyMiniInset:(CGFloat)h {
	if (!self.isViewLoaded) return;
	if (_ignoresMiniPlayer) h = 0;
	UITableView *tv = self.tableView;
	UIEdgeInsets in = tv.contentInset;
	if (in.bottom != h) { in.bottom = h; tv.contentInset = in; }
	UIEdgeInsets si = tv.scrollIndicatorInsets;
	if (si.bottom != h) { si.bottom = h; tv.scrollIndicatorInsets = si; }
}

- (void)scrollToTop {
	if (!self.isViewLoaded) return;
	UITableView *tv = self.tableView;
	[tv setContentOffset:CGPointMake(0, -tv.contentInset.top) animated:YES];
}

- (CGFloat)cardWidth {
	CGFloat w = self.isViewLoaded ? self.tableView.bounds.size.width : 0;
	if (w < 1) w = [UIScreen mainScreen].bounds.size.width;
	return w - 2 * 10 - 2;
}

#pragma mark - headers, footers, rows

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section { return nil; }
- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section { return nil; }

- (UILabel *)sectionLabelWithFont:(UIFont *)font color:(UIColor *)color shadow:(UIColor *)shadow offset:(CGSize)offset frame:(CGRect)f {
	UILabel *l = [[UILabel alloc] initWithFrame:f];
	l.autoresizingMask = UIViewAutoresizingFlexibleWidth;
	l.font = font;
	l.textColor = color;
	l.shadowColor = shadow;
	l.shadowOffset = offset;
	l.backgroundColor = [UIColor clearColor];
	return l;
}

- (CGFloat)footerTextHeight:(NSString *)text width:(CGFloat)w {
	UIFont *f = [ENTheme current].groupedFooterFont;
	return ceilf([text sizeWithFont:f constrainedToSize:CGSizeMake(MAX(w - 2 * ENGTextInset, 1), 10000) lineBreakMode:NSLineBreakByWordWrapping].height);
}

- (UIView *)tableView:(UITableView *)tableView viewForHeaderInSection:(NSInteger)section {
	NSString *t = [self tableView:tableView titleForHeaderInSection:section];
	if (!t.length) return nil;
	ENTheme *th = [ENTheme current];
	CGFloat w = tableView.bounds.size.width, lh = ceilf(th.groupedHeaderFont.lineHeight);
	UIView *v = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, ENGHeaderTop + lh + ENGHeaderBottom)];
	v.backgroundColor = [UIColor clearColor];
	UILabel *l = [self sectionLabelWithFont:th.groupedHeaderFont color:th.groupedHeader shadow:th.groupedHeaderShadow
	                                 offset:th.groupedHeaderShadowOffset frame:CGRectMake(ENGTextInset, ENGHeaderTop, MAX(w - 2 * ENGTextInset, 1), lh)];
	l.lineBreakMode = NSLineBreakByTruncatingTail;
	l.text = t;
	[v addSubview:l];
	return v;
}

- (CGFloat)tableView:(UITableView *)tableView heightForHeaderInSection:(NSInteger)section {
	NSString *t = [self tableView:tableView titleForHeaderInSection:section];
	if (!t.length) return ENGHeaderTop;
	return ENGHeaderTop + ceilf([ENTheme current].groupedHeaderFont.lineHeight) + ENGHeaderBottom;
}

- (UIView *)tableView:(UITableView *)tableView viewForFooterInSection:(NSInteger)section {
	NSString *t = [self tableView:tableView titleForFooterInSection:section];
	if (!t.length) return nil;
	ENTheme *th = [ENTheme current];
	CGFloat w = tableView.bounds.size.width, textH = [self footerTextHeight:t width:w];
	UIView *v = [[UIView alloc] initWithFrame:CGRectMake(0, 0, w, ENGFooterTop + textH + ENGFooterBottom)];
	v.backgroundColor = [UIColor clearColor];
	UILabel *l = [self sectionLabelWithFont:th.groupedFooterFont color:th.groupedFooter shadow:th.groupedFooterShadow
	                                 offset:CGSizeMake(0, 1) frame:CGRectMake(ENGTextInset, ENGFooterTop, MAX(w - 2 * ENGTextInset, 1), textH)];
	l.textAlignment = NSTextAlignmentCenter;
	l.numberOfLines = 0;
	l.lineBreakMode = NSLineBreakByWordWrapping;
	l.text = t;
	[v addSubview:l];
	return v;
}

- (CGFloat)tableView:(UITableView *)tableView heightForFooterInSection:(NSInteger)section {
	NSString *t = [self tableView:tableView titleForFooterInSection:section];
	if (!t.length) return ENGNoFooter;
	return ENGFooterTop + [self footerTextHeight:t width:tableView.bounds.size.width] + ENGFooterBottom;
}

// The card's fill (iOS 6 takes a grouped cell's colour here), the row's colours, and the green selection with this row's
// corners.
- (void)tableView:(UITableView *)tableView willDisplayCell:(UITableViewCell *)cell forRowAtIndexPath:(NSIndexPath *)ip {
	ENTheme *th = [ENTheme current];
	NSInteger n = [tableView numberOfRowsInSection:ip.section];
	ENGroupedPosition pos = n <= 1 ? ENGroupedSingle : ip.row == 0 ? ENGroupedTop : ip.row == n - 1 ? ENGroupedBottom : ENGroupedMiddle;
	UIImage *sel = [th groupedSelectionImage:pos];
	UIImageView *sv = (UIImageView *)cell.selectedBackgroundView;
	if (sv.tag == ENGSelectionTag && [sv isKindOfClass:[UIImageView class]]) {
		sv.image = sel;
	} else {
		sv = [[UIImageView alloc] initWithImage:sel];
		sv.tag = ENGSelectionTag;
		cell.selectedBackgroundView = sv;
	}
	if ([cell isKindOfClass:[ENGroupedCell class]]) {
		ENGroupedCell *g = (ENGroupedCell *)cell;
		[g applyTheme];
		cell.backgroundColor = g.fill ?: th.groupedCard;
	} else {
		cell.backgroundColor = th.groupedCard;
	}
}

@end

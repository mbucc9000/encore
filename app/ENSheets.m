#import "ENSheets.h"
#import "ENTheme.h"
#import "ENCompat.h"

// See ENSheets.h. Nothing here changes what a sheet or alert does: only images, colours and fonts, and only after the stock
// layout ran; every lookup is a class check with a stock fallback.

// the stock background: a UIImageView (not ours) covering at least 90 % of the view both ways
static UIImageView *ENStockBackground(UIView *v, UIView *ours) {
	CGSize s = v.bounds.size;
	if (s.width < 1 || s.height < 1) return nil;
	for (UIView *sub in v.subviews) {
		if (sub == ours || ![sub isKindOfClass:[UIImageView class]]) continue;
		CGRect f = sub.frame;
		if (f.size.width >= s.width * 0.9f && f.size.height >= s.height * 0.9f) return (UIImageView *)sub;
	}
	return nil;
}

@implementation ENActionSheet {
	UIImageView *_panel;          // ours, at index 0 (nil until the buttons could be skinned)
	UIImageView *_stock;          // the stock background, hidden (nil when the stock panel is drawn some other way)
	BOOL _titleDone;              // the title label was found laid out and styled
}

- (void)didMoveToWindow {
	[super didMoveToWindow];
	if (self.window) [self setNeedsLayout];       // one more pass after the stock layout placed the buttons
}

- (void)layoutSubviews {
	[super layoutSubviews];
	if (!_panel) {
		if (self.bounds.size.height < 1 || ![self skinButtons]) return;      // not laid out yet, or unexpected: the stock look
		_panel = [[UIImageView alloc] initWithImage:[ENTheme current].sheetBackgroundImage];
		_panel.userInteractionEnabled = NO;
		[self insertSubview:_panel atIndex:0];
	}
	if (!_titleDone) _titleDone = [self skinTitle];
	if (!_stock) _stock = ENStockBackground(self, _panel);
	_panel.frame = self.bounds;
	_stock.hidden = YES;
}

// Every UIButton subview gets its role's images. Returns NO, having changed nothing, unless each one maps to its own button
// index by title (so a role is never guessed).
- (BOOL)skinButtons {
	NSMutableArray *buttons = [NSMutableArray array];
	for (UIView *v in self.subviews) {
		if ([v isKindOfClass:[UIButton class]]) [buttons addObject:v];
	}
	NSInteger n = self.numberOfButtons;
	if (n <= 0 || (NSInteger)buttons.count != n) return NO;
	NSMutableArray *roles = [NSMutableArray arrayWithCapacity:buttons.count];
	NSMutableSet *used = [NSMutableSet set];
	for (UIButton *b in buttons) {
		NSString *t = [b titleForState:UIControlStateNormal];
		NSInteger idx = -1;
		for (NSInteger i = 0; i < n && idx < 0; i++) {
			if (![used containsObject:@(i)] && [[self buttonTitleAtIndex:i] isEqualToString:t]) idx = i;
		}
		if (idx < 0) return NO;
		[used addObject:@(idx)];
		ENSheetButtonRole role = idx == self.destructiveButtonIndex ? ENSheetButtonDestructive
		                       : idx == self.cancelButtonIndex ? ENSheetButtonCancel : ENSheetButtonOther;
		[roles addObject:@(role)];
	}
	ENTheme *th = [ENTheme current];
	for (NSUInteger i = 0; i < buttons.count; i++) {
		UIButton *b = buttons[i];
		ENSheetButtonRole role = (ENSheetButtonRole)[roles[i] integerValue];
		[b setBackgroundImage:[th sheetButtonImage:role pressed:NO] forState:UIControlStateNormal];
		[b setBackgroundImage:[th sheetButtonImage:role pressed:YES] forState:UIControlStateHighlighted];
		b.titleLabel.font = th.sheetButtonFont;
		[b setTitleColor:th.sheetButtonText forState:UIControlStateNormal];
		[b setTitleColor:th.sheetButtonText forState:UIControlStateHighlighted];
		[b setTitleShadowColor:th.sheetButtonTextShadow forState:UIControlStateNormal];
		[b setTitleShadowColor:th.sheetButtonTextShadow forState:UIControlStateHighlighted];
		b.titleLabel.shadowOffset = CGSizeMake(0, -1);
	}
	return YES;
}

// The title label (the UILabel showing self.title): #d2d2d2 with a black shadow; with boldLine, that first line bold white
// (attributedText, iOS 6), first in the theme's 13.5 pt fonts, else at the label's own size, else plain. NO while there is
// a title but no laid-out label for it yet (the next pass tries again).
- (BOOL)skinTitle {
	NSString *title = self.title;
	if (!title.length) return YES;
	UILabel *label = nil;
	for (UIView *v in self.subviews) {
		if ([v isKindOfClass:[UILabel class]] && [((UILabel *)v).text isEqualToString:title]) {
			label = (UILabel *)v;
			break;
		}
	}
	if (!label || label.bounds.size.width < 1 || label.bounds.size.height < 1) return NO;
	ENTheme *th = [ENTheme current];
	label.textColor = th.sheetTitleText;
	label.shadowColor = th.sheetTitleShadow;
	label.shadowOffset = CGSizeMake(0, -1);
	NSString *bold = self.boldLine;
	if (!bold.length || title.length <= bold.length || ![title hasPrefix:bold]) return YES;
	if (!ENHasAttributedText()) return YES;      // (1.1) iOS 5 has no attributedText: the plain title, recoloured
	UIFont *stockFont = label.font;
	CGFloat pt = stockFont.pointSize > 0 ? stockFont.pointSize : 13.5f;
	CGSize box = label.bounds.size;
	NSArray *tries = @[ @[ th.sheetTitleBoldFont, th.sheetTitleFont ], @[ [ENTheme fontOfSize:pt bold:YES], [ENTheme fontOfSize:pt bold:NO] ] ];
	for (NSArray *fonts in tries) {
		NSMutableAttributedString *s = [[NSMutableAttributedString alloc] initWithString:title
		                                    attributes:@{ NSFontAttributeName: fonts[1], NSForegroundColorAttributeName: th.sheetTitleText }];
		[s setAttributes:@{ NSFontAttributeName: fonts[0], NSForegroundColorAttributeName: th.sheetTitleBoldText } range:NSMakeRange(0, bold.length)];
		label.attributedText = s;
		CGSize need = [label sizeThatFits:CGSizeMake(box.width, 10000)];
		if (need.height <= box.height + 0.5f && need.width <= box.width + 0.5f) return YES;
	}
	label.text = title;            // neither fits the stock frame: the plain title, recoloured
	label.font = stockFont;
	label.textColor = th.sheetTitleText;
	return YES;
}

@end

@implementation ENAlertView {
	UIImageView *_panel;          // ours, at index 0, at the stock background's frame
	UIImageView *_stock;          // the stock background, hidden while ours shows
}

- (void)didMoveToWindow {
	[super didMoveToWindow];
	if (self.window) [self setNeedsLayout];
}

- (void)layoutSubviews {
	[super layoutSubviews];
	if (!_stock) {
		_stock = ENStockBackground(self, nil);
		if (!_stock) return;          // an unexpected hierarchy: the stock look
		_panel = [[UIImageView alloc] initWithFrame:_stock.frame];
		_panel.userInteractionEnabled = NO;
		[self insertSubview:_panel atIndex:0];
	}
	CGRect f = _stock.frame;
	if (!_panel.image || _panel.image.size.width != f.size.width || _panel.image.size.height != f.size.height) {
		_panel.image = [[ENTheme current] alertBackgroundImageOfSize:f.size];
	}
	_panel.frame = f;
	_stock.hidden = _panel.image != nil;     // no panel image (a degenerate size): keep the stock one
}

@end

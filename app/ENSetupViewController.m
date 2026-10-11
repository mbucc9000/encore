#import "ENSetupViewController.h"
#import "ENCompat.h"
#import "ENAppDelegate.h"
#import "ENGateway.h"
#import "ENTheme.h"
#import "ENAnon.h"

// See ENSetupViewController.h. 1.0 (Drop 3c, C5): the metrics are the mockup's .setup (styles.css "setup", shell.js Setup);
// every colour, font and image is an ENTheme Setup token (§1.3 "Setup", chrome: the same in every palette). The pairing
// itself is unchanged (SETUP1-4): the same fields, checks, order, saves and pairWithCode:, then showMain.

static const CGFloat ENSetupSide = 18;          // .setup padding: 34 18 0
static const CGFloat ENSetupTop = 34;
static const CGFloat ENSetupIcon = 76;          // .appicon (the image has 10 / 7 pt of baked shadow round it: 96 x 96)
static const CGFloat ENSetupRow = 44;           // .df
static const CGFloat ENSetupRowPad = 11;        // .df padding 0 11px
static const CGFloat ENSetupLabelWidth = 108;   // .df label
static const CGFloat ENSetupLabelGap = 8;       // .df gap
static const CGFloat ENSetupStatusGap = 9;      // .status gap (spinner or check, then the text)
static const CGFloat ENSetupStatusMin = 22;     // .status min-height
static const NSTimeInterval ENSetupConnectedHold = 0.5;     // ✓ Connected stays up this long, then showMain (mockup: 500 ms)

// SETUP2 (1.0, DESIGN-5 §2.3 "http:// auto-prefix"): an address typed without a scheme gets "http://". Whatever the 0.5
// check accepted (anything starting with "http") is kept as typed, apart from surrounding spaces; empty stays empty.
static NSString *ENSetupURL(NSString *typed) {
	NSString *s = [typed ?: @"" stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	if (!s.length || [[s lowercaseString] hasPrefix:@"http"]) return s;
	return [@"http://" stringByAppendingString:s];
}

@implementation ENSetupViewController {
	UIImageView *_background;           // the §1.3 background at the view's size (not cached: built here, dropped with the view)
	UIScrollView *_scroll;
	UIImageView *_icon;
	UILabel *_titleLabel, *_tagline, *_hint;
	UIView *_box;                       // the one grouped field box (Home, Away, Code) ...
	UIImageView *_boxImage;
	NSMutableArray *_rowViews;          // ... its rows: per row @[ separator or NSNull (the first), label, field ]
	UITextField *_home, *_away, *_code;
	UIButton *_connect;
	UIActivityIndicatorView *_spin;     // the status row: a white spinner or the check, then the text, centred
	UIImageView *_check;
	UILabel *_status;
	CGRect _statusRow;                  // (R2c) where -layoutContent put the status row (the scroll's coordinates)
	BOOL _connected;                    // ✓ Connected is up and showMain follows: Connect does nothing more
}

#pragma mark - views

- (UILabel *)labelWithFont:(UIFont *)font color:(UIColor *)color {
	UILabel *l = [[UILabel alloc] initWithFrame:CGRectZero];
	l.font = font;
	l.textColor = color;
	l.backgroundColor = [UIColor clearColor];
	l.textAlignment = NSTextAlignmentCenter;
	return l;
}

// One 44 pt row of the field box: the label in its 108 pt column, then the field (clear, no border) to the row's end. Rows
// after the first start with the 2 pt separator. The frames are set in -layoutContent.
- (UITextField *)fieldInRow:(NSUInteger)row label:(NSString *)label text:(NSString *)text placeholder:(NSString *)ph font:(UIFont *)font {
	ENTheme *th = [ENTheme current];
	UIImageView *sep = nil;
	if (row > 0) {
		sep = [[UIImageView alloc] initWithImage:th.setupFieldSeparatorImage];
		[_box addSubview:sep];
	}
	UILabel *l = [[UILabel alloc] initWithFrame:CGRectZero];
	l.text = label;
	l.font = th.setupLabelFont;
	l.textColor = th.setupLabel;
	l.backgroundColor = [UIColor clearColor];
	[_box addSubview:l];

	UITextField *f = [[UITextField alloc] initWithFrame:CGRectZero];
	f.text = text;
	f.font = font;
	f.textColor = th.setupInput;
	ENSetFieldPlaceholder(f, ph, font, th.setupPlaceholder);     // (1.1) attributedPlaceholder; iOS 5: plain, recoloured
	f.borderStyle = UITextBorderStyleNone;
	f.backgroundColor = [UIColor clearColor];
	f.contentVerticalAlignment = UIControlContentVerticalAlignmentCenter;
	f.autocorrectionType = UITextAutocorrectionTypeNo;
	f.autocapitalizationType = UITextAutocapitalizationTypeNone;
	f.keyboardAppearance = UIKeyboardAppearanceAlert;
	f.clearButtonMode = UITextFieldViewModeWhileEditing;
	f.delegate = self;
	[_box addSubview:f];
	[_rowViews addObject:@[ (sep ?: (id)[NSNull null]), l, f ]];
	return f;
}

- (void)loadView {
	UIView *v = [[UIView alloc] initWithFrame:[UIScreen mainScreen].applicationFrame];
	ENTheme *th = [ENTheme current];
	v.backgroundColor = th.windowBackground;          // under the background image (it is opaque)
	self.view = v;
	self.title = @"Encore";

	_background = [[UIImageView alloc] initWithFrame:v.bounds];
	_background.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
	[v addSubview:_background];

	_scroll = [[UIScrollView alloc] initWithFrame:v.bounds];
	_scroll.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
	_scroll.backgroundColor = [UIColor clearColor];
	_scroll.alwaysBounceVertical = YES;
	_scroll.indicatorStyle = UIScrollViewIndicatorStyleWhite;
	[v addSubview:_scroll];

	// the 76 pt icon (the 152 px resource from tools/make_art.py; a stand-in if it is missing), "Encore" and the tagline
	NSString *iconPath = [[NSBundle mainBundle] pathForResource:@"SetupIcon@2x" ofType:@"png"];
	_icon = [[UIImageView alloc] initWithImage:[th setupIconImage:(iconPath ? [UIImage imageWithContentsOfFile:iconPath] : nil)]];
	[_scroll addSubview:_icon];
	_titleLabel = [self labelWithFont:th.setupTitleFont color:th.setupTitle];
	_titleLabel.shadowColor = th.setupTitleShadow;
	_titleLabel.shadowOffset = CGSizeMake(0, -1);
	_titleLabel.text = @"Encore";
	[_scroll addSubview:_titleLabel];
	_tagline = [self labelWithFont:th.setupTaglineFont color:th.setupTagline];
	// (1.1) the system it is running on (iOS 6's line as before)
	_tagline.text = ENSystemIs6() ? @"An unofficial Spotify client for iOS 6" : @"An unofficial Spotify client for iOS 5";
	[_scroll addSubview:_tagline];

	// SETUP1: Home and Away (URL keyboard) and Code (number pad, Bold 22), prefilled from ENGateway, in one field box
	_box = [[UIView alloc] initWithFrame:CGRectZero];
	_box.backgroundColor = [UIColor clearColor];
	_boxImage = [[UIImageView alloc] initWithImage:th.setupFieldBoxImage];
	[_box addSubview:_boxImage];
	_rowViews = [NSMutableArray array];
	[_scroll addSubview:_box];
	ENGateway *gw = [ENGateway shared];
	_home = [self fieldInRow:0 label:@"Home" text:gw.homeURL placeholder:@"192.168.1.20:8095" font:th.setupInputFont];
	_home.keyboardType = UIKeyboardTypeURL;
	_home.returnKeyType = UIReturnKeyNext;
	_away = [self fieldInRow:1 label:@"Away" text:gw.awayURL placeholder:@"your-public-ip:8095" font:th.setupInputFont];
	_away.keyboardType = UIKeyboardTypeURL;
	_away.returnKeyType = UIReturnKeyNext;
	for (UITextField *f in @[ _home, _away ]) {         // a whole http://…:8095 address fits the 144 pt field
		f.adjustsFontSizeToFitWidth = YES;
		f.minimumFontSize = 12;
	}
	[_home addTarget:self action:@selector(homeChanged) forControlEvents:UIControlEventEditingChanged];
	_code = [self fieldInRow:2 label:@"Code" text:@"" placeholder:@"6 digits" font:th.setupCodeFont];
	_code.keyboardType = UIKeyboardTypeNumberPad;
	// (R2a) Anonymous Mode (kept through Unpair): the pairing code and the bridge's addresses are typed as hidden fields,
	// and the hint names no address
	if ([ENAnon on]) for (UITextField *f in @[ _home, _away, _code ]) f.secureTextEntry = YES;

	// the hint, built from the typed home address (-updateHint)
	_hint = [self labelWithFont:th.setupHintFont color:th.setupHint];
	_hint.numberOfLines = 0;
	_hint.lineBreakMode = NSLineBreakByWordWrapping;
	[_scroll addSubview:_hint];

	// the green wide Connect button (C7: 44 pt, radius 9, Bold 18)
	_connect = [UIButton buttonWithType:UIButtonTypeCustom];
	_connect.frame = CGRectMake(ENSetupSide, 0, v.bounds.size.width - 2 * ENSetupSide, 44);
	[ENTheme configureButton:_connect style:ENButtonStyleGreen title:@"Connect" glyph:nil];
	_connect.adjustsImageWhenDisabled = NO;              // busy keeps 0.5's look: the whole button at .6
	[_connect setTitleColor:th.greenButtonText forState:UIControlStateDisabled];
	[_connect addTarget:self action:@selector(connect) forControlEvents:UIControlEventTouchUpInside];
	[_scroll addSubview:_connect];

	// the centred status row: a white spinner (busy) or the done check, then Bold 14 text (errors in setupError)
	_spin = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleWhite];
	_spin.hidesWhenStopped = YES;
	[_scroll addSubview:_spin];
	_check = [[UIImageView alloc] initWithImage:[th glyphNamed:@"check" size:18 color:th.setupDone]];
	_check.hidden = YES;
	[_scroll addSubview:_check];
	_status = [self labelWithFont:th.setupStatusFont color:th.setupStatus];
	_status.numberOfLines = 0;
	_status.lineBreakMode = NSLineBreakByWordWrapping;
	[_scroll addSubview:_status];

	[self updateHint];
	[self layoutContent];
	[_scroll addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:self.view action:@selector(endEditing:)]];
}

- (void)viewWillLayoutSubviews {
	[super viewWillLayoutSubviews];
	CGSize size = self.view.bounds.size;
	if (!CGSizeEqualToSize(_background.image.size, size)) _background.image = [[ENTheme current] setupBackgroundImageOfSize:size];
	[self layoutContent];
}

// Top to bottom as the mockup: the icon at 34, "Encore" 14 below it, the tagline 2 below that, the box 22 below, the hint
// 12 below (4 pt narrower each side), Connect 18 below, the status row 18 below; the scroll covers it all.
- (void)layoutContent {
	CGFloat W = _scroll.bounds.size.width ?: 320, w = W - 2 * ENSetupSide;
	CGFloat y = ENSetupTop;
	CGSize is = _icon.image.size;
	_icon.frame = CGRectMake(floorf((W - is.width) / 2), y - 7, is.width, is.height);      // its icon at (10, 7) in the image
	y += ENSetupIcon + 14;
	CGFloat lh = ceilf(_titleLabel.font.lineHeight);
	_titleLabel.frame = CGRectMake(ENSetupSide, y, w, lh);
	y += lh + 2;
	lh = ceilf(_tagline.font.lineHeight);
	_tagline.frame = CGRectMake(ENSetupSide, y, w, lh);
	y += lh + 22;

	_box.frame = CGRectMake(ENSetupSide, y, w, _rowViews.count * ENSetupRow + 3);
	_boxImage.frame = _box.bounds;
	CGFloat fieldX = 1 + ENSetupRowPad + ENSetupLabelWidth + ENSetupLabelGap;
	for (NSUInteger row = 0; row < _rowViews.count; row++) {
		NSArray *views = _rowViews[row];
		CGFloat top = 1 + row * ENSetupRow;
		if ([views[0] isKindOfClass:[UIView class]]) ((UIView *)views[0]).frame = CGRectMake(1, top, w - 2, 2);
		((UIView *)views[1]).frame = CGRectMake(1 + ENSetupRowPad, top, ENSetupLabelWidth, ENSetupRow);
		((UIView *)views[2]).frame = CGRectMake(fieldX, top + 1, MAX(w - 1 - ENSetupRowPad - fieldX, 40), ENSetupRow - 2);
	}
	y += _box.frame.size.height + 12;

	// the hint: measured in its bold face (an upper bound for the mixed text, so it never cuts off)
	CGFloat hw = w - 8;
	NSString *hintText = ENHasAttributedText() ? _hint.attributedText.string : _hint.text;     // (1.1: iOS 5, plain text)
	CGFloat hh = ceilf([hintText sizeWithFont:[ENTheme current].setupHintBoldFont constrainedToSize:CGSizeMake(hw, 200)
	                            lineBreakMode:NSLineBreakByWordWrapping].height);
	_hint.frame = CGRectMake(ENSetupSide + 4, y, hw, hh);
	y += hh + 18;

	_connect.frame = CGRectMake(ENSetupSide, y, w, 44);
	y += 44 + 18;

	CGFloat sh = [self layoutStatusAt:y width:w];
	_statusRow = CGRectMake(ENSetupSide, y, w, sh);
	y += sh;
	_scroll.contentSize = CGSizeMake(W, y + 20);
}

// The status row's height (at least 22): the spinner or the check and the text, centred together; a long text (an error)
// wraps centred.
- (CGFloat)layoutStatusAt:(CGFloat)y width:(CGFloat)w {
	UIView *mark = _spin.isAnimating ? (UIView *)_spin : !_check.hidden ? (UIView *)_check : nil;
	CGSize ms = mark ? mark.bounds.size : CGSizeZero;
	CGFloat markW = mark ? ms.width + ENSetupStatusGap : 0;
	NSString *text = _status.text ?: @"";
	CGSize ts = text.length ? [text sizeWithFont:_status.font constrainedToSize:CGSizeMake(MAX(w - markW, 40), 200)
	                                lineBreakMode:NSLineBreakByWordWrapping] : CGSizeZero;
	CGFloat tw = ceilf(ts.width), tht = ceilf(ts.height);
	CGFloat h = MAX(ENSetupStatusMin, MAX(tht, ms.height));
	CGFloat x = ENSetupSide + floorf((w - (markW + tw)) / 2);
	if (mark) {
		mark.frame = CGRectMake(x, y + floorf((h - ms.height) / 2), ms.width, ms.height);
		x += markW;
	}
	_status.frame = CGRectMake(x, y + floorf((h - tht) / 2), tw, tht);
	return h;
}

// "Open <home>/admin on your computer to sign in to Spotify and get a pairing code.", the address as typed (with the
// auto-prefix), in the bold face
- (void)updateHint {
	ENTheme *th = [ENTheme current];
	NSString *home = ENSetupURL(_home.text);
	while ([home hasSuffix:@"/"]) home = [home substringToIndex:home.length - 1];
	NSString *bold = home.length && ![ENAnon on] ? [home stringByAppendingString:@"/admin"] : @"your Encore Bridge’s /admin page";
	NSString *text = [NSString stringWithFormat:@"Open %@ on your computer to sign in to Spotify and get a pairing code.", bold];
	if (!ENHasAttributedText()) {           // (1.1) iOS 5: no attributed text, so the whole hint in its plain face and colour
		_hint.text = text;
		_hint.font = th.setupHintFont;
		_hint.textColor = th.setupHint;
		_hint.textAlignment = NSTextAlignmentCenter;
		return;
	}
	NSMutableAttributedString *s = [[NSMutableAttributedString alloc] initWithString:text
		attributes:@{ NSFontAttributeName: th.setupHintFont, NSForegroundColorAttributeName: th.setupHint }];
	NSRange r = NSMakeRange(5, bold.length);              // after "Open "
	[s addAttribute:NSFontAttributeName value:th.setupHintBoldFont range:r];
	[s addAttribute:NSForegroundColorAttributeName value:th.setupHintBold range:r];
	_hint.attributedText = s;
	_hint.textAlignment = NSTextAlignmentCenter;          // (iOS 6: applied to the whole attributed text)
}

- (void)homeChanged {
	[self updateHint];
	[self layoutContent];
}

#pragma mark - keyboard (SETUP4)

- (void)viewWillAppear:(BOOL)animated {
	[super viewWillAppear:animated];
	self.navigationController.navigationBarHidden = YES;
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(keyboard:) name:UIKeyboardWillShowNotification object:nil];
	[nc addObserver:self selector:@selector(keyboard:) name:UIKeyboardWillHideNotification object:nil];
}

- (void)viewWillDisappear:(BOOL)animated {
	[super viewWillDisappear:animated];
	[[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];      // (replaced as the root without a viewWillDisappear)
	[NSObject cancelPreviousPerformRequestsWithTarget:self];
}

- (void)keyboard:(NSNotification *)n {
	BOOL show = [n.name isEqualToString:UIKeyboardWillShowNotification];
	CGRect kb = [self.view convertRect:[n.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue] fromView:nil];
	UIEdgeInsets in = UIEdgeInsetsMake(0, 0, show ? kb.size.height : 0, 0);
	_scroll.contentInset = in;
	_scroll.scrollIndicatorInsets = in;
	if (show) [self revealEditing];
}

// (R2c) With the keyboard up: Connect (12 pt round it) together with the row being edited (8 pt round it) when both fit
// over the keyboard, else that row with as much under it as fits. The content (~512 pt: the box at ~198-333, Connect at
// ~408-452) is laid out the same at both heights; the 216 pt keyboard leaves 332 pt on 4-inch (548 under the status bar):
// always both, the same scroll as before (Connect just over the keyboard). It leaves 244 pt on 3.5-inch (460): Away
// (228 pt with Connect) or Code fit; Home (272 pt) doesn't, so Home goes to the top with Away, Code, the hint and most of
// Connect under it, and Return (Next) brings Connect up with Away.
- (void)revealEditing {
	CGRect target = CGRectInset(_connect.frame, 0, -12);
	CGFloat room = _scroll.bounds.size.height - _scroll.contentInset.bottom;
	UITextField *f = _home.isFirstResponder ? _home : _away.isFirstResponder ? _away : _code.isFirstResponder ? _code : nil;
	if (f && room > 0) {
		CGRect row = CGRectInset([_scroll convertRect:f.frame fromView:_box], 0, -8);
		CGRect both = CGRectUnion(target, row);
		target = both.size.height <= room ? both : CGRectMake(row.origin.x, row.origin.y, row.size.width, MIN(room, both.size.height));
	}
	[_scroll scrollRectToVisible:target animated:YES];
}

// the next field while the keyboard stays up (Return / Next, or a tap on another field): WillShow may not come again
- (void)textFieldDidBeginEditing:(UITextField *)f {
	if (_scroll.contentInset.bottom > 0) [self revealEditing];
}

- (BOOL)textFieldShouldReturn:(UITextField *)f {
	if (f == _home) [_away becomeFirstResponder];
	else if (f == _away) [_code becomeFirstResponder];
	else [self connect];
	return YES;
}

#pragma mark - pairing (SETUP2, SETUP3: the 0.5 steps, named as the mockup's status row)

// The status row: `busy` = the white spinner (and Connect disabled at .6, as 0.5), `done` = the check; errors in red.
- (void)showStatus:(NSString *)text busy:(BOOL)busy done:(BOOL)done error:(BOOL)error {
	ENTheme *th = [ENTheme current];
	BOOL locked = busy || done;                           // (done: showMain follows)
	_connect.enabled = !locked;
	_connect.alpha = locked ? 0.6f : 1;
	if (busy) [_spin startAnimating]; else [_spin stopAnimating];
	_check.hidden = !done;
	_status.text = text;
	_status.textColor = error ? th.setupError : th.setupStatus;
	[self layoutContent];
	// (R2c) the row sits ~470 pt down: under a 3.5-inch screen's fold (460 pt), so it scrolls up into view (4-inch: in view)
	if (text.length) [_scroll scrollRectToVisible:CGRectInset(_statusRow, 0, -10) animated:YES];
}

- (void)connect {
	if (_connected) return;                               // ✓ Connected is up: the tabs are on their way
	[self.view endEditing:YES];
	NSString *code = [[_code.text componentsSeparatedByCharactersInSet:[[NSCharacterSet decimalDigitCharacterSet] invertedSet]] componentsJoinedByString:@""];
	if (code.length != 6) { [self showStatus:@"Enter the 6-digit code from the admin page." busy:NO done:NO error:YES]; return; }
	NSString *home = ENSetupURL(_home.text), *away = ENSetupURL(_away.text);
	if (![[home lowercaseString] hasPrefix:@"http"]) {     // (only an empty address now: anything else is prefixed)
		[self showStatus:@"The home address should look like http://192.168.1.20:8095" busy:NO done:NO error:YES];
		return;
	}
	_home.text = home;                                    // the addresses as saved (with the prefix)
	_away.text = away;
	[self updateHint];
	ENGateway *gw = [ENGateway shared];
	gw.homeURL = home;
	gw.awayURL = away;
	[self showStatus:@"Pairing…" busy:YES done:NO error:NO];
	[gw pairWithCode:code completion:^(NSError *error) {
		if (error) {
			[self showStatus:error.localizedDescription busy:NO done:NO error:YES];
			return;
		}
		self->_connected = YES;
		[self showStatus:@"Connected" busy:NO done:YES error:NO];
		[self performSelector:@selector(finishPairing) withObject:nil afterDelay:ENSetupConnectedHold];
	}];
}

// "Paired", then showMain (SETUP3); ENAppDelegate plays the launch animation because Setup was the root (C5)
- (void)finishPairing {
	[(ENAppDelegate *)[UIApplication sharedApplication].delegate showMain];
}

@end

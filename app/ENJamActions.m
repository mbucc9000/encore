#import "ENJamActions.h"
#import <MessageUI/MessageUI.h>
#import "ENJam.h"
#import "ENHUD.h"
#import "ENTrackActions.h"
#import "ENPlayback.h"
#import "ENCatalog.h"
#import "ENGateway.h"
#import "ENTabBarController.h"
#import "ENAppDelegate.h"
#import "ENUtil.h"
#import "ENDiag.h"
#import "ENSheets.h"
#import "ENAnon.h"

// The Jam's prompts and feedback (DESIGN-4b §6.5–§6.9). Writes go through [ENJam shared]; nothing here talks to the gateway
// itself, and no prompt makes a request before the user taps (§6.6).

static NSTimeInterval ENJANow(void) { return [NSDate timeIntervalSinceReferenceDate]; }

// ---------------------------------------------------------------------------------------------------------------- prompts
// A UIAlertView's delegate is assign: an ENJamPrompt is the delegate and stays in sLive while its alert is up. The handler
// runs from ...didDismissWithButtonIndex: (the alert is gone by then, so it may alert, present or show a HUD).
@interface ENJamPrompt : NSObject <UIAlertViewDelegate>
@property (nonatomic, strong) UIAlertView *alert;
@property (nonatomic, copy) void (^handler)(NSInteger index, NSString *text);
@end

static NSMutableSet *sLive;                 // every helper on screen (prompts, the composer's delegate)
static ENJamPrompt *sPrompt;                // the one Jam alert on screen: a second one is dropped (double taps)
static NSTimeInterval sClipboardPendingUntil;    // a clipboard check asked for before ENJam's first state (cold launch)
static NSString *sAwait;                    // a resume we started and wait on: @"start" (Move, then Start) or @"here"
static NSTimeInterval sAwaitUntil;
static NSTimer *sMoveTimer;

@implementation ENJamPrompt

- (void)alertView:(UIAlertView *)alert didDismissWithButtonIndex:(NSInteger)index {
	void (^h)(NSInteger, NSString *) = self.handler;
	self.handler = nil;
	alert.delegate = nil;
	NSString *text = alert.alertViewStyle == UIAlertViewStylePlainTextInput ? [alert textFieldAtIndex:0].text : nil;
	if (sPrompt == self) sPrompt = nil;
	ENJamPrompt *me = self;
	dispatch_async(dispatch_get_main_queue(), ^{ [sLive removeObject:me]; });     // still the alert's own callback
	if (h) h(index, text);
}

@end

static void ENJAKeep(id helper) {
	if (!sLive) sLive = [NSMutableSet set];
	[sLive addObject:helper];
}

@interface ENJamActions ()
+ (void)alertFailedMessage;
@end

// The composer's delegate (messageComposeDelegate is assign too).
@interface ENJamMessageHelper : NSObject <MFMessageComposeViewControllerDelegate>
@end

@implementation ENJamMessageHelper

- (void)messageComposeViewController:(MFMessageComposeViewController *)controller didFinishWithResult:(MessageComposeResult)result {
	controller.messageComposeDelegate = nil;
	ENJamMessageHelper *me = self;
	ENLog(@"jam: invite message %@", result == MessageComposeResultSent ? @"sent" : result == MessageComposeResultFailed ? @"failed" : @"cancelled");
	[controller dismissViewControllerAnimated:YES completion:^{
		[[ENTabBarController shared] reclaimFirstResponder];
		if (result == MessageComposeResultFailed) [ENJamActions alertFailedMessage];
		[sLive removeObject:me];
	}];
}

@end

@implementation ENJamActions

#pragma mark - alerts

// A prompt with up to two buttons (other nil = just the cancel one); field = the paste field. NO if another Jam alert is up.
+ (BOOL)alert:(NSString *)title message:(NSString *)msg cancel:(NSString *)cancel other:(NSString *)other field:(BOOL)field
      handler:(void (^)(BOOL ok, NSString *text))handler {
	if (sPrompt) return NO;
	ENJamPrompt *p = [ENJamPrompt new];
	UIAlertView *a = [[ENAlertView alloc] initWithTitle:title message:msg delegate:p cancelButtonTitle:cancel otherButtonTitles:other, nil];
	NSInteger okIndex = other ? a.firstOtherButtonIndex : -1;
	if (field) {
		a.alertViewStyle = UIAlertViewStylePlainTextInput;
		UITextField *f = [a textFieldAtIndex:0];
		f.placeholder = @"open.spotify.com/socialsession/…";
		f.keyboardType = UIKeyboardTypeURL;
		f.autocorrectionType = UITextAutocorrectionTypeNo;
		f.autocapitalizationType = UITextAutocapitalizationTypeNone;
		f.clearButtonMode = UITextFieldViewModeWhileEditing;
		NSString *clip = [self clipboardLinkForPrefill];
		if (clip) f.text = clip;
	}
	void (^h)(BOOL, NSString *) = [handler copy];
	p.alert = a;
	p.handler = ^(NSInteger i, NSString *text) {
		if (field) [[ENTabBarController shared] reclaimFirstResponder];     // the keyboard has gone
		if (h) h(i == okIndex, text);
	};
	ENJAKeep(p);
	sPrompt = p;
	[a show];
	return YES;
}

+ (void)alertTitle:(NSString *)title message:(NSString *)msg {
	[self alert:title message:msg cancel:@"OK" other:nil field:NO handler:nil];
}

+ (void)alertTitle:(NSString *)title error:(NSError *)e {
	[self alertTitle:title message:e ? [ENCatalog messageForError:e] : @"Something went wrong. Try again."];
}

+ (void)alertFailedMessage {
	[self alertTitle:@"Couldn’t Send" message:@"The message wasn’t sent. Copy the link instead."];
}

// no alert, action sheet or other Jam prompt is up (on iOS 6 an alert or a sheet is its own key window)
+ (BOOL)nothingUp {
	if (sPrompt) return NO;
	UIWindow *key = [UIApplication sharedApplication].keyWindow;
	id<UIApplicationDelegate> d = [UIApplication sharedApplication].delegate;
	UIWindow *main = [d isKindOfClass:[ENAppDelegate class]] ? ((ENAppDelegate *)d).window : nil;
	return !key || !main || key == main;
}

// the paste field's prefill: a Jam link on the clipboard (its string, else its URL item); not recorded as offered.
// None in Anonymous Mode: a Jam link is a live join credential (D1 keeps it behind Show Invite), not for a screen
// someone may be filming.
+ (NSString *)clipboardLinkForPrefill {
	if ([ENAnon on]) return nil;
	UIPasteboard *pb = [UIPasteboard generalPasteboard];
	NSString *s = pb.string;
	if ([ENJam isJamLink:s]) return [s stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	NSString *u = pb.URL.absoluteString;
	return [ENJam isJamLink:u] ? u : nil;
}

#pragma mark - observing

+ (void)startObserving {
	static BOOL started;
	if (started) return;
	started = YES;
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc addObserver:self selector:@selector(jamChanged:) name:ENJamChangedNotification object:nil];
	[nc addObserver:self selector:@selector(guestPlay:) name:ENJamGuestPlayNotification object:nil];
	[nc addObserver:self selector:@selector(commandFailed:) name:ENPlaybackCommandFailedNotification object:nil];
}

// The event HUDs (§4.5, §6.5), whatever screen is up; our own actions' echoes are skipped.
+ (void)jamChanged:(NSNotification *)n {
	ENJam *jam = [ENJam shared];
	if (sClipboardPendingUntil > 0 && jam.loaded) {
		BOOL due = ENJANow() < sClipboardPendingUntil;
		sClipboardPendingUntil = 0;
		if (due) [self offerClipboardJam];
	}
	NSDictionary *ev = ENJDict(n.userInfo[ENJamEventKey]);
	if (!ev || [n.userInfo[ENJamOwnEventKey] boolValue]) return;
	if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) return;
	// (R2a) the name as ENJam gives it: the bridge's while Anonymous Mode is off, the member's made-up one while on
	NSString *k = ENJStr(ev[@"k"]), *who = [jam nameForEvent:ev], *why = ENJStr(ev[@"why"]);
	if ([k isEqualToString:@"start"]) {
		[ENHUD showDone:@"Jam started on Encore" glyph:@"people"];
	} else if ([k isEqualToString:@"join"]) {
		[ENHUD showDone:(who ? [NSString stringWithFormat:@"You joined %@’s Jam", who] : @"You joined a Jam") glyph:@"people"];
	} else if ([k isEqualToString:@"in"]) {
		if (who) [ENHUD showDone:[NSString stringWithFormat:@"%@ joined your Jam", who] glyph:@"people"];
	} else if ([k isEqualToString:@"leave"]) {
		[ENHUD showDone:[why isEqualToString:@"idle"] ? @"Encore left the Jam: nobody was listening"
			: [why isEqualToString:@"refusing"] ? @"Encore left the Jam: Spotify is refusing to play right now" : @"You left the Jam"];
	} else if ([k isEqualToString:@"end"]) {
		[ENHUD showDone:(who ? [NSString stringWithFormat:@"%@ ended the Jam", who] : @"Jam ended")];
	} else if ([k isEqualToString:@"kicked"]) {
		[ENHUD showDone:(who ? [NSString stringWithFormat:@"You were removed from %@’s Jam", who] : @"You were removed from the Jam") glyph:@"x"];
	}
	// out: nothing (the screens update)
}

// §6.9: a guest's song tap is Add to Jam when this role may add; anything else asks to leave first. Leave is offered only
// with x.sc, as on the Jam screen (§6.5 C, 4b-c): a Jam known from pushes alone is left in Spotify on the computer.
+ (void)guestPlay:(NSNotification *)n {
	ENJam *jam = [ENJam shared];
	NSString *uri = ENJStr(n.userInfo[ENJamURIKey]);
	if ([jam can:@"add"] && [uri hasPrefix:@"spotify:track:"]) {
		[ENTrackActions addToQueueURI:uri];
		return;
	}
	NSString *hn = jam.hostName;
	if (![jam can:@"sc"]) {
		[self alertTitle:@"You’re Listening Along" message:hn ? [NSString stringWithFormat:@"Leave %@’s Jam in Spotify on your computer to play something else.", hn]
			: @"Leave the Jam in Spotify on your computer to play something else."];
		return;
	}
	NSString *msg = hn ? [NSString stringWithFormat:@"Leave %@’s Jam to play something else.", hn] : @"Leave the Jam to play something else.";
	[self alert:@"You’re Listening Along" message:msg cancel:@"OK" other:@"Leave Jam" field:NO handler:^(BOOL ok, NSString *text) {
		if (ok) [self leave];
	}];
}

#pragma mark - start

+ (void)startJamFrom:(UIViewController *)vc {
	ENJam *jam = [ENJam shared];
	if (jam.busy || sAwait || jam.active) return;
	ENPlayback *pb = [ENPlayback shared];
	if (pb.engineLoaded) {
		[self doStart];
		return;
	}
	NSString *device = pb.remoteDevice;
	if (!device.length) {
		[self alertTitle:@"Play Something First" message:@"Start a song on Encore, then start the Jam."];
		return;
	}
	NSString *msg = [NSString stringWithFormat:@"Spotify is playing on %@. Move it to Encore and start the Jam here?", device];
	[self alert:@"Play on Encore?" message:msg cancel:@"Cancel" other:@"Move" field:NO handler:^(BOOL ok, NSString *text) {
		if (!ok) return;
		[ENHUD showBusy:@"Starting…"];
		[self await:@"start" seconds:10];
		[[ENPlayback shared] resume];
	}];
}

+ (void)doStart {
	NSString *busy = @"Starting…";
	[ENHUD showBusy:busy];
	[[ENJam shared] start:^(NSError *e) {
		[ENHUD hideText:busy];                 // no HUD for our own Start (§4.5): the screen shows the Jam
		if (!e) return;
		if ([[ENCatalog codeOfError:e] isEqualToString:@"jam_elsewhere"]) [self alertTitle:@"Already in a Jam" error:e];
		else [self alertTitle:@"Couldn’t Start the Jam" error:e];
	}];
}

// After a resume we asked for: Move (then Start, once Encore has the song) or Play on Encore (done once the phone plays). A
// failed resume ends the wait with its message; other commands failing meanwhile aren't ours to report.
+ (void)await:(NSString *)what seconds:(NSTimeInterval)s {
	sAwait = what;
	sAwaitUntil = ENJANow() + s;
	[sMoveTimer invalidate];
	sMoveTimer = [NSTimer timerWithTimeInterval:0.5 target:self selector:@selector(awaitTick:) userInfo:nil repeats:YES];
	[[NSRunLoop mainRunLoop] addTimer:sMoveTimer forMode:NSRunLoopCommonModes];
}

+ (void)stopAwaiting {
	[sMoveTimer invalidate];
	sMoveTimer = nil;
	sAwait = nil;
}

+ (void)awaitTick:(NSTimer *)t {
	NSString *what = sAwait;
	ENPlayback *pb = [ENPlayback shared];
	if ([what isEqualToString:@"start"] && pb.engineLoaded) {
		[self stopAwaiting];
		[self doStart];
		return;
	}
	if ([what isEqualToString:@"here"] && pb.playing && !pb.loading) {     // the Jam plays here again: nothing left to wait for
		[self stopAwaiting];
		return;
	}
	if (ENJANow() < sAwaitUntil) return;
	[self stopAwaiting];
	if ([what isEqualToString:@"start"]) {
		[ENHUD hideText:@"Starting…"];
		[self alertTitle:@"Couldn’t Start the Jam" message:@"Encore didn’t start playing. Try again in a moment."];
	}
}

+ (void)commandFailed:(NSNotification *)n {
	NSString *what = sAwait;
	if (!what || ![n.userInfo[ENPlaybackCommandKey] isEqual:@"resume"]) return;
	[self stopAwaiting];
	NSError *e = n.userInfo[ENPlaybackErrorKey];
	if ([what isEqualToString:@"start"]) {
		[ENHUD hideText:@"Starting…"];
		[self alertTitle:@"Couldn’t Start the Jam" error:e];
	} else {
		[self alertTitle:@"Couldn’t Play Here" error:e];      // a 409 jam_moved: "Your Jam is playing on <device>. ..."
	}
}

+ (void)playOnEncore {
	if (sAwait) return;
	if ([ENJam shared].guest) {                // a guest's resume is never sent (§6.3): the Jam screen offers Leave instead
		[self alertTitle:@"Couldn’t Play Here" message:@"As a guest, Encore can’t bring the Jam back here. Leave it to play something else."];
		return;
	}
	[self await:@"here" seconds:30];
	[[ENPlayback shared] resume];
}

#pragma mark - join

+ (void)promptJoin {
	[self alert:@"Join a Jam" message:@"Paste the Jam link a friend sent you." cancel:@"Cancel" other:@"Join" field:YES
	    handler:^(BOOL ok, NSString *text) {
		NSString *s = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
		if (ok && s.length) [self joinLink:s];
	}];
}

// "Join This Jam?" while hosting: joining another Jam ends ours
+ (void)confirmReplaceThen:(void (^)(void))go {
	[self alert:@"Join This Jam?" message:@"Joining another Jam ends yours." cancel:@"Cancel" other:@"Join" field:NO
	    handler:^(BOOL ok, NSString *text) {
		if (ok) go();
	}];
}

// a gateway known to be older than 0.6.0 can't join (one with an unknown version gets the request: a cold launch from a link)
+ (BOOL)gatewayCanJam {
	if ([ENCatalog shared].gatewayVersion && ![ENJam shared].available) {
		[self alertTitle:@"Couldn’t Join" message:ENUpdateBridgeText];
		return NO;
	}
	return YES;
}

// 4b-c: the link of the Jam this phone is in (its token, or `l`, the session's own share URL) is never sent: joining it
// would first end our Jam (hosting, replace) or leave it, then find nothing to join. No request.
+ (BOOL)refuseOwnJamLink:(NSString *)link {
	if (![[ENJam shared] isCurrentJamLink:link]) return NO;
	[self alertTitle:@"Already in This Jam" message:@"You’re already in this Jam."];
	return YES;
}

+ (void)joinLink:(NSString *)link {
	ENJam *jam = [ENJam shared];
	if (!link.length || jam.busy || ![self gatewayCanJam] || [self refuseOwnJamLink:link]) return;
	if (jam.active && jam.hosting) {
		[self confirmReplaceThen:^{ [self doJoin:link replace:YES]; }];
		return;
	}
	[self doJoin:link replace:(jam.active && jam.guest)];      // a guest of another Jam: replace without asking (mockup)
}

+ (void)doJoin:(NSString *)link replace:(BOOL)replace {
	NSString *busy = @"Joining…";
	[ENHUD showBusy:busy];
	[[ENJam shared] joinLink:link replace:replace done:^(NSError *e) {
		if (!e) {
			NSString *hn = [ENJam shared].hostName;
			[ENHUD showDone:(hn ? [NSString stringWithFormat:@"You joined %@’s Jam", hn] : @"You joined the Jam") glyph:@"people"];
			return;
		}
		[ENHUD hideText:busy];
		NSString *code = [ENCatalog codeOfError:e];
		if ([code isEqualToString:@"jam_active"] && !replace) {    // the gateway knew of a Jam we didn't
			NSString *r = ENJStr(e.userInfo[ENJamErrorRoleKey]);
			if ([r isEqualToString:@"host"]) {     // confirm, then once more
				[self confirmReplaceThen:^{ [self doJoin:link replace:YES]; }];
				return;
			}
			if ([r isEqualToString:@"guest"]) {    // a guest of another Jam: once more at once, as -joinLink:
				[self doJoin:link replace:YES];
				return;
			}
			// lim (no r) or a role we don't know: replace can't help; "Couldn’t Join" with the gateway's message
		}
		if ([code isEqualToString:@"jam_not_found"]) [self alertTitle:@"Jam Not Found" error:e];
		else if ([code isEqualToString:@"bad_link"]) [self alertTitle:@"Not a Jam Link" error:e];
		else [self alertTitle:@"Couldn’t Join" error:e];
	}];
}

+ (void)offerJoinLink:(NSString *)link {
	ENJam *jam = [ENJam shared];
	if (!link.length || ![self gatewayCanJam] || [self refuseOwnJamLink:link]) return;
	if (jam.active && jam.hosting) {
		[self confirmReplaceThen:^{ [self doJoin:link replace:YES]; }];
		return;
	}
	[self alert:@"Join This Jam?" message:@"Open the Jam from this link? You’ll listen along on Encore." cancel:@"Not Now" other:@"Join"
	      field:NO handler:^(BOOL ok, NSString *text) {
		if (ok) [self joinLink:link];
	}];
}

+ (void)offerClipboardJam {
	if (![ENGateway shared].paired || ![ENTabBarController shared]) return;
	ENJam *jam = [ENJam shared];
	if (!jam.loaded) {                         // a cold launch: once ENJam's first state arrives (it needs the gateway version)
		sClipboardPendingUntil = ENJANow() + 30;
		return;
	}
	if (!jam.available || ![jam can:@"sc"] || ![self nothingUp]) return;
	NSString *link = [jam clipboardJamLink];  // no request: the link is only checked by Join
	if (!link) return;
	ENLog(@"jam: offering the Jam link on the clipboard");
	[self alert:@"Jam Link Copied" message:@"Join the Jam from the link on your clipboard? You’ll listen along on Encore and can add songs."
	     cancel:@"Not Now" other:@"Join" field:NO handler:^(BOOL ok, NSString *text) {
		if (ok) [self joinLink:link];
	}];
}

#pragma mark - end, leave, remove, settings

+ (void)confirmEnd {
	[self alert:@"End the Jam?" message:@"Everyone will be removed. Your queue stays." cancel:@"Cancel" other:@"End" field:NO
	    handler:^(BOOL ok, NSString *text) {
		if (!ok) return;
		NSString *busy = @"Ending…";
		[ENHUD showBusy:busy];
		[[ENJam shared] end:^(NSError *e) {
			if (!e) { [ENHUD showDone:@"Jam ended"]; return; }
			[ENHUD hideText:busy];
			[self alertTitle:@"Couldn’t End the Jam" error:e];
		}];
	}];
}

+ (void)confirmLeave {
	[self alert:@"Leave the Jam?" message:@"You’ll stop listening along." cancel:@"Cancel" other:@"Leave" field:NO
	    handler:^(BOOL ok, NSString *text) {
		if (ok) [self leave];
	}];
}

+ (void)leave {
	NSString *busy = @"Leaving…";
	[ENHUD showBusy:busy];
	[[ENJam shared] leave:^(NSError *e) {
		if (!e) { [ENHUD showDone:@"You left the Jam"]; return; }
		[ENHUD hideText:busy];
		[self alertTitle:@"Couldn’t Leave the Jam" error:e];
	}];
}

// §6.5 B (4b-c: the captured kick): asked first, then one request; never retried (a write)
+ (void)removeMember:(ENJamMember *)m {
	if (!m) return;
	NSString *name = m.name ?: @"them";
	NSString *title = m.name ? [NSString stringWithFormat:@"Remove %@?", m.name] : @"Remove This Member?";
	[self alert:title message:@"They’ll leave your Jam." cancel:@"Cancel" other:@"Remove" field:NO handler:^(BOOL ok, NSString *text) {
		if (!ok) return;
		NSString *busy = @"Removing…";
		[ENHUD showBusy:busy];
		[[ENJam shared] removeMember:m done:^(NSError *e) {
			if (!e) { [ENHUD showDone:[@"Removed " stringByAppendingString:name] glyph:@"x"]; return; }
			[ENHUD hideText:busy];
			[self alertTitle:[NSString stringWithFormat:@"Couldn’t Remove %@", name] error:e];
		}];
	}];
}

+ (void)setGuestsCanControl:(BOOL)on done:(void (^)(BOOL ok))done {
	void (^d)(BOOL) = [done copy];
	[[ENJam shared] setGuestsCanControl:on done:^(NSError *e) {
		if (e) [self alertTitle:@"Couldn’t Change This" error:e];
		if (d) d(e == nil);
	}];
}

#pragma mark - invite

+ (BOOL)canSendText {
	return [MFMessageComposeViewController canSendText];
}

+ (void)messageLinkFrom:(UIViewController *)vc {
	ENJam *jam = [ENJam shared];
	NSString *l = jam.link;
	if (!l.length || !vc.view.window || vc.presentedViewController) return;
	if (![self canSendText]) {
		[self alertTitle:@"Can’t Send Messages" message:@"This iPhone can’t send messages. Copy the link instead."];
		return;
	}
	MFMessageComposeViewController *mc = [[MFMessageComposeViewController alloc] init];
	ENJamMessageHelper *h = [ENJamMessageHelper new];
	ENJAKeep(h);
	mc.messageComposeDelegate = h;
	// sms: URLs can't carry a body on iOS 6: the composer is the only way (§6.8); no recipients. (R2a) While Anonymous Mode
	// is on it names nobody.
	if ([ENAnon on]) mc.body = [@"Join this Jam on Spotify: " stringByAppendingString:l];
	else mc.body = jam.hosting || !jam.hostName ? [@"Join my Jam on Spotify: " stringByAppendingString:l]
		: [NSString stringWithFormat:@"Join %@’s Jam on Spotify: %@", jam.hostName, l];
	[vc presentViewController:mc animated:YES completion:nil];
}

+ (void)copyLink {
	ENJam *jam = [ENJam shared];
	NSString *l = jam.link;
	if (!l.length) return;
	[UIPasteboard generalPasteboard].string = l;
	[jam noteCopiedLink];                      // never offered back by the clipboard watcher
	[ENHUD showDone:@"Link Copied" glyph:@"link"];
}

@end

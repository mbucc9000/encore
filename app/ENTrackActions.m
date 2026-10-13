#import "ENTrackActions.h"
#import "ENAddToPlaylistViewController.h"
#import "ENHUD.h"
#import "ENCatalog.h"
#import "ENPlayback.h"
#import "ENModel.h"
#import "ENTheme.h"
#import "ENTabBarController.h"
#import "ENTrackListViewController.h"
#import "ENArtistViewController.h"
#import "ENJam.h"
#import "ENDiag.h"
#import "ENSheets.h"
#import "ENL.h"

// What can be done with a song (DESIGN-3 §6). Likes are optimistic (ENCatalog flips every heart and the Liked list at
// once and reverts on failure); adds and creates are not (§6.5): the HUD says "Adding…" / "Creating…" until the reply.

// Only songs can be liked or added: the gateway answers 400 for anything but spotify:track: (§3.4).
static BOOL ENIsSongURI(NSString *uri) {
	return [uri hasPrefix:@"spotify:track:"];
}

static const NSUInteger ENPlaylistNameMax = 100;      // the gateway's limit (UTF-16 units after trimming, as JS counts)

// ---------------------------------------------------------------------------------------------------------------- prompts
// UIActionSheet / UIAlertView delegates are assign: an ENPrompt is their delegate and stays in sLive while it is on screen.
// The handler runs from ...didDismissWithButtonIndex: (the sheet is gone by then, so it may present, push or alert).
@interface ENPrompt : NSObject <UIActionSheetDelegate, UIAlertViewDelegate>
@property (nonatomic, strong) UIView *view;                       // the sheet / alert
@property (nonatomic, copy) void (^handler)(NSInteger index);
- (void)limitField:(UITextField *)field to:(NSUInteger)max;
@end

static NSMutableSet *sLive;            // every ENPrompt on screen
static ENPrompt *sMain;                // the one ••• sheet / New Playlist alert (one at a time: a second tap is ignored)
static ENPrompt *sError;               // the error alert on screen (a second failure meanwhile doesn't stack another)
static BOOL sMenuWaiting;              // a ••• is waiting for its saved state (up to 1.5 s)
static NSInteger sCreating;            // playlist creates in flight (the picker ignores taps meanwhile)
static NSMutableSet *sRemoving;        // (0.9.2) "<playlist uri> <song uri>" of the removes in flight

@implementation ENPrompt {
	NSUInteger _max;
}

- (void)dealloc {
	[[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)limitField:(UITextField *)field to:(NSUInteger)max {
	_max = max;
	[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(fieldChanged:) name:UITextFieldTextDidChangeNotification object:field];
}

- (void)fieldChanged:(NSNotification *)n {
	UITextField *f = n.object;
	NSString *s = f.text;
	if (s.length <= _max) return;
	f.text = [s substringToIndex:[s rangeOfComposedCharacterSequenceAtIndex:_max].location];
}

- (void)finish:(NSInteger)index {
	void (^h)(NSInteger) = self.handler;
	self.handler = nil;
	if (sMain == self) sMain = nil;
	if (sError == self) sError = nil;
	[[NSNotificationCenter defaultCenter] removeObserver:self];
	if ([self.view isKindOfClass:[UIActionSheet class]]) ((UIActionSheet *)self.view).delegate = nil;
	else if ([self.view isKindOfClass:[UIAlertView class]]) ((UIAlertView *)self.view).delegate = nil;
	// let go on the next turn: this is still the sheet's / alert's own callback, and we may hold its last reference
	ENPrompt *me = self;
	dispatch_async(dispatch_get_main_queue(), ^{
		[sLive removeObject:me];
	});
	if (h) h(index);
}

- (void)actionSheet:(UIActionSheet *)sheet didDismissWithButtonIndex:(NSInteger)index {
	[self finish:index];
}

- (void)alertView:(UIAlertView *)alert didDismissWithButtonIndex:(NSInteger)index {
	[self finish:index];
}

@end

static void ENKeepPrompt(ENPrompt *p) {
	if (!sLive) sLive = [NSMutableSet set];
	[sLive addObject:p];
}

// ---------------------------------------------------------------------------------------------------------------- actions
@interface ENTrackActions ()
+ (void)alertTitle:(NSString *)title message:(NSString *)message;    // also the picker's (declared in its .m)
+ (BOOL)writeInFlight;                                              // same
@end

@implementation ENTrackActions

+ (void)alertTitle:(NSString *)title message:(NSString *)message {
	if (sError) return;      // one failure on screen is enough (T-c4: several taps while rate limited)
	ENPrompt *p = [ENPrompt new];
	UIAlertView *a = [[ENAlertView alloc] initWithTitle:title message:message delegate:p cancelButtonTitle:ENL(@"OK") otherButtonTitles:nil];
	p.view = a;
	ENKeepPrompt(p);
	sError = p;
	[a show];
}

+ (void)showError:(NSError *)error title:(NSString *)title {
	[self alertTitle:title message:error ? [ENCatalog messageForError:error] : ENL(@"Something went wrong. Try again.")];
}

+ (BOOL)writeInFlight {
	return sCreating > 0;
}

// ---- the ••• sheet (§6.1)

+ (void)showMenuForTrack:(ENTrack *)track from:(UIViewController *)from options:(NSUInteger)options busy:(void (^)(BOOL on))busy {
	NSString *uri = track.uri;
	if (!uri.length || !from || sMain || sMenuWaiting) return;
	if (!ENIsSongURI(uri) || [[ENCatalog shared] savedStateForURI:uri]) {
		[self openMenuForTrack:track from:from options:options];
		return;
	}
	// Unknown saved state: a spinner in place of the •••, ask the gateway, open on the answer or after 1.5 s (then it counts
	// as not saved). Whichever comes first opens the sheet, once.
	sMenuWaiting = YES;
	if (busy) busy(YES);
	__weak UIViewController *wfrom = from;
	__block BOOL opened = NO;
	void (^open)(void) = ^{
		if (opened) return;
		opened = YES;
		sMenuWaiting = NO;
		if (busy) busy(NO);
		UIViewController *f = wfrom;
		if (f.view.window) [self openMenuForTrack:track from:f options:options];
	};
	[[ENCatalog shared] checkSaved:@[uri] done:open];
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), open);
}

+ (void)openMenuForTrack:(ENTrack *)track from:(UIViewController *)from options:(NSUInteger)options {
	if (sMain || !from.view.window) return;
	BOOL song = ENIsSongURI(track.uri);
	BOOL saved = song && [[[ENCatalog shared] savedStateForURI:track.uri] boolValue];
	BOOL goTo = !(options & ENTrackMenuNoGoTo);
	NSString *name = track.name.length ? track.name : ENL(@"Song");
	// 0.10: two lines, the song bold over the artists (ENActionSheet boldLine; just the song when there are no artists)
	NSString *title = track.artists.length ? [NSString stringWithFormat:@"%@\n%@", name, track.artists] : name;

	ENPrompt *p = [ENPrompt new];
	ENActionSheet *sheet = [[ENActionSheet alloc] initWithTitle:title delegate:p cancelButtonTitle:nil destructiveButtonTitle:nil otherButtonTitles:nil];
	if (track.artists.length) sheet.boldLine = name;
	NSMutableArray *acts = [NSMutableArray array];      // what each button does, by index (Cancel comes last)
	// 0.9.2: an editable playlist's own page hands this one back to the screen (DESIGN-0.9.2 §1); first, red, as iOS puts
	// a sheet's destructive button
	if (song && (options & ENTrackMenuRemoveFromPlaylist) && [from conformsToProtocol:@protocol(ENTrackMenuPlaylistScreen)]) {
		sheet.destructiveButtonIndex = [sheet addButtonWithTitle:ENL(@"Remove from This Playlist")];
		[acts addObject:@"remove"];
	}
	if (song) {
		[sheet addButtonWithTitle:ENL(@"Add to Playlist…")];
		[acts addObject:@"playlist"];
	}
	ENJam *jam = [ENJam shared];
	if (!jam.active) {
		[sheet addButtonWithTitle:ENL(@"Add to Queue")];
		[acts addObject:@"queue"];
	} else if ([jam can:@"add"]) {             // 0.6: Add to Jam (left out when this role can't add, §6.9)
		[sheet addButtonWithTitle:ENL(@"Add to Jam")];
		[acts addObject:@"queue"];
	}
	if (song) {
		[sheet addButtonWithTitle:saved ? ENL(@"Remove from Liked Songs") : ENL(@"Save to Liked Songs")];
		[acts addObject:@"like"];
	}
	if (goTo && !(options & ENTrackMenuNoAlbum) && track.albumURI.length) {
		[sheet addButtonWithTitle:ENL(@"Go to Album")];
		[acts addObject:@"album"];
	}
	if (goTo && !(options & ENTrackMenuNoArtist) && track.artistURI.length) {
		[sheet addButtonWithTitle:ENL(@"Go to Artist")];
		[acts addObject:@"artist"];
	}
	sheet.cancelButtonIndex = [sheet addButtonWithTitle:ENL(@"Cancel")];
	sheet.actionSheetStyle = UIActionSheetStyleBlackTranslucent;
	p.view = sheet;

	__weak UIViewController *wfrom = from;
	p.handler = ^(NSInteger i) {
		if (i < 0 || i >= (NSInteger)acts.count) return;      // Cancel
		NSString *act = acts[(NSUInteger)i];
		if ([act isEqualToString:@"playlist"]) {
			UIViewController *f = wfrom;
			if (f.view.window) [self addToPlaylist:track from:f];
		} else if ([act isEqualToString:@"queue"]) {
			[self addToQueue:track];
		} else if ([act isEqualToString:@"like"]) {
			[self setTrack:track saved:!saved];
		} else if ([act isEqualToString:@"album"]) {
			[self goToAlbumOf:track];
		} else if ([act isEqualToString:@"artist"]) {
			[self goToArtistOf:track];
		} else if ([act isEqualToString:@"remove"]) {
			UIViewController *f = wfrom;
			if (f.view.window) [(id<ENTrackMenuPlaylistScreen>)f trackMenuRemoveFromPlaylist:track];
		}
	};
	ENKeepPrompt(p);
	sMain = p;
	// inside the tabs: from the tab bar (else the tab bar swallows the sheet's bottom buttons); Now Playing: in its view
	UITabBarController *tabs = from.tabBarController;
	if (tabs.view.window) [sheet showFromTabBar:tabs.tabBar];
	else [sheet showInView:from.view];
}

// ---- like (§6.4)

+ (void)toggleSaved:(ENTrack *)track {
	if (!track.uri.length) return;
	BOOL saved = [[[ENCatalog shared] savedStateForURI:track.uri] boolValue];      // unknown counts as not saved
	[self setTrack:track saved:!saved];
}

+ (void)setTrack:(ENTrack *)track saved:(BOOL)saved {
	NSString *uri = track.uri;
	if (!uri.length) return;
	if (!ENIsSongURI(uri)) {
		[self alertTitle:ENL(@"Couldn't save") message:ENL(@"Only songs can be saved to Liked Songs.")];
		return;
	}
	NSString *text = saved ? ENL(@"Saved to Liked Songs") : ENL(@"Removed from Liked Songs");
	[ENHUD showDone:text glyph:(saved ? @"heart" : @"x")];
	ENLog(@"actions: %@ %@", saved ? @"like" : @"unlike", uri);
	[[ENCatalog shared] setSaved:saved tracks:@[track] done:^(NSError *error) {
		if (!error) return;
		// the catalog has already put every heart, the Liked list and the count back
		ENLog(@"actions: %@ %@ failed: %@", saved ? @"like" : @"unlike", uri, [ENCatalog logTextForError:error]);
		[ENHUD hideText:text];
		[self showError:error title:saved ? ENL(@"Couldn't save") : ENL(@"Couldn't remove")];
	}];
}

// ---- queue (§5.5)

+ (void)addToQueue:(ENTrack *)track {
	[self addToQueueURI:track.uri];
}

+ (void)addToQueueURI:(NSString *)uri {
	if (!uri.length) return;
	BOOL jam = [ENJam shared].active;          // 0.6: the same route is Add to Jam while a Jam is on
	[[ENPlayback shared] addToQueue:uri done:^(NSError *error) {
		if (!error) {
			if (jam) [ENHUD showDone:ENL(@"Added to the Jam") glyph:@"people"];
			else [ENHUD showDone:ENL(@"Added to Queue") glyph:@"queue"];
			return;
		}
		if (error.code == 409 && [[ENCatalog codeOfError:error] isEqualToString:@"unsupported"]) {
			[self alertTitle:ENL(@"Couldn't add to the Jam") message:[ENCatalog messageForError:error]];
			return;
		}
		if (error.code == 409 && [[ENCatalog codeOfError:error] isEqualToString:@"not_active"]) {
			// nothing is loaded on Encore: play the song instead, asking first when another device is playing
			NSString *device = [ENPlayback shared].remoteDevice;
			if (device.length) [self askPlayOnEncore:uri device:device];
			else [[ENPlayback shared] playURI:uri];
			return;
		}
		ENLog(@"actions: queue %@ failed: %@", uri, [ENCatalog logTextForError:error]);
		[self showError:error title:(jam ? ENL(@"Couldn't add to the Jam") : ENL(@"Couldn't add to the queue"))];
	}];
}

+ (void)askPlayOnEncore:(NSString *)uri device:(NSString *)device {
	ENPrompt *p = [ENPrompt new];
	NSString *msg = [NSString stringWithFormat:ENL(@"Spotify is playing on %@. Play this song on Encore instead?"), device];
	UIAlertView *a = [[ENAlertView alloc] initWithTitle:ENL(@"Play on Encore?") message:msg delegate:p cancelButtonTitle:ENL(@"Cancel") otherButtonTitles:ENL(@"Play"), nil];
	NSInteger play = a.firstOtherButtonIndex;
	p.view = a;
	p.handler = ^(NSInteger i) {
		if (i == play) [[ENPlayback shared] playURI:uri];
	};
	ENKeepPrompt(p);
	[a show];
}

// ---- add to playlist (§6.2)

+ (void)addToPlaylist:(ENTrack *)track from:(UIViewController *)from {
	if (!track.uri.length || !from.view.window) return;
	if (!ENIsSongURI(track.uri)) {
		[self alertTitle:ENL(@"Couldn't add") message:ENL(@"Only songs can be added to a playlist.")];
		return;
	}
	// inside the tabs: over the whole tab controller (mini player included); Now Playing: over itself. The window test, as
	// for the sheet: should iOS hand the modal Now Playing its presenting tab controller, that one's view is off screen
	// (and its presentedViewController is Now Playing, which would turn the ⊕ into a silent no-op)
	UITabBarController *tabs = from.tabBarController;
	UIViewController *host = tabs.view.window ? tabs : from;
	if (host.presentedViewController) return;      // already showing one (a double tap)
	ENAddToPlaylistViewController *vc = [[ENAddToPlaylistViewController alloc] initWithTrack:track];
	UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
	[host presentViewController:nav animated:YES completion:nil];
}

// ---- remove from this playlist (0.9.2, DESIGN-0.9.2 §1)

+ (BOOL)removeTrack:(ENTrack *)track fromPlaylist:(ENPlaylist *)pl done:(void (^)(NSError *error))done {
	NSString *uri = track.uri;
	if (!ENIsSongURI(uri) || !pl.uri.length) return NO;
	NSString *key = [NSString stringWithFormat:@"%@ %@", pl.uri, uri];
	if ([sRemoving containsObject:key]) return NO;           // the same song while its remove runs: ignored
	if (!sRemoving) sRemoving = [NSMutableSet set];
	[sRemoving addObject:key];
	NSString *name = pl.name;
	void (^d)(NSError *) = [done copy];
	ENLog(@"actions: remove %@ from a playlist", uri);
	[[ENCatalog shared] removeTrackURIs:@[uri] fromPlaylist:pl done:^(ENPlaylist *updated, NSError *error) {
		[sRemoving removeObject:key];
		if (error) {
			ENLog(@"actions: remove %@ failed: %@", uri, [ENCatalog logTextForError:error]);
			if (d) d(error);
			[self showError:error title:ENL(@"Couldn't remove")];
			return;
		}
		NSString *shown = updated.name.length ? updated.name : name;
		[ENHUD showDone:(shown.length ? [NSString stringWithFormat:ENL(@"Removed from %@"), shown] : ENL(@"Removed from the playlist")) glyph:@"x"];
		if (d) d(nil);
	}];
	return YES;
}

// ---- new playlist (§6.3)

+ (NSString *)playlistNameFrom:(NSString *)typed {
	NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];
	NSString *name = [typed ?: @"" stringByTrimmingCharactersInSet:ws];
	if (name.length > ENPlaylistNameMax) {
		name = [name substringToIndex:[name rangeOfComposedCharacterSequenceAtIndex:ENPlaylistNameMax].location];
		name = [name stringByTrimmingCharactersInSet:ws];
	}
	if (!name.length) name = [[ENCatalog shared].library defaultNewPlaylistName] ?: @"My Playlist #1";
	return name;
}

+ (void)newPlaylistFrom:(UIViewController *)from track:(ENTrack *)track done:(void (^)(ENPlaylist *created))done {
	if (sMain || !from.view.window) return;
	if (track && !ENIsSongURI(track.uri)) {
		[self alertTitle:ENL(@"Couldn't add") message:ENL(@"Only songs can be added to a playlist.")];
		return;
	}
	ENPrompt *p = [ENPrompt new];
	UIAlertView *a = [[ENAlertView alloc] initWithTitle:ENL(@"New Playlist") message:ENL(@"Enter a name for this playlist.") delegate:p
		cancelButtonTitle:ENL(@"Cancel") otherButtonTitles:ENL(@"Create"), nil];
	a.alertViewStyle = UIAlertViewStylePlainTextInput;
	UITextField *field = [a textFieldAtIndex:0];
	field.placeholder = ENL(@"My Playlist");
	field.autocapitalizationType = UITextAutocapitalizationTypeWords;
	field.clearButtonMode = UITextFieldViewModeWhileEditing;
	[p limitField:field to:ENPlaylistNameMax];
	NSInteger create = a.firstOtherButtonIndex;
	p.view = a;
	p.handler = ^(NSInteger i) {
		// the keyboard has gone: the lock-screen / AirPods controls need their first responder back
		[[ENTabBarController shared] reclaimFirstResponder];
		if (i != create) return;
		[self createPlaylistNamed:[self playlistNameFrom:field.text] track:track done:done];
	};
	ENKeepPrompt(p);
	sMain = p;
	[a show];
}

+ (void)createPlaylistNamed:(NSString *)name track:(ENTrack *)track done:(void (^)(ENPlaylist *created))done {
	NSString *busyText = ENL(@"Creating…");
	sCreating++;
	[ENHUD showBusy:busyText];
	ENLog(@"actions: create playlist (%lu song)", (unsigned long)(track ? 1 : 0));
	NSArray *uris = track.uri ? @[track.uri] : @[];
	[[ENCatalog shared] createPlaylistNamed:name trackURIs:uris done:^(ENPlaylist *created, NSString *addError, NSError *error) {
		sCreating--;
		if (!created) {
			ENLog(@"actions: create failed: %@", error ? [ENCatalog logTextForError:error] : @"no playlist");
			[ENHUD hideText:busyText];
			[self showError:error title:ENL(@"Couldn't create the playlist")];
			return;
		}
		NSString *shown = created.name.length ? created.name : name;
		if (!track) {
			[ENHUD hideText:busyText];          // the Playlists "+": pushing the new list is the feedback
		} else if (addError.length) {
			[ENHUD hideText:busyText];
			[self alertTitle:ENL(@"Couldn't add") message:[NSString stringWithFormat:ENL(@"%@ was created, but the song wasn't added. %@"), shown, addError]];
		} else {
			[ENHUD showDone:[NSString stringWithFormat:ENL(@"Added to %@"), shown]];
		}
		if (done) done(created);
	}];
}

// ---- go to (§6.1)

+ (void)goToAlbumOf:(ENTrack *)track {
	if (!track.albumURI.length) return;
	ENTabBarController *tabs = [ENTabBarController shared];
	if (!tabs) return;
	[tabs showViewController:[[ENTrackListViewController alloc] initWithAlbumURI:track.albumURI title:track.album image:track.image]];
}

+ (void)goToArtistOf:(ENTrack *)track {
	if (!track.artistURI.length) return;
	ENTabBarController *tabs = [ENTabBarController shared];
	if (!tabs) return;
	[tabs showViewController:[[ENArtistViewController alloc] initWithArtistURI:track.artistURI name:track.artistName]];
}

@end

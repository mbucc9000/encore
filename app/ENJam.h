#import <UIKit/UIKit.h>
#import "ENModel.h"

// Spotify Jam on the phone (app 0.6; owner: DATA; DESIGN-4b §4, §6.2). The gateway makes every Jam decision: this class
// mirrors its JAM object (GET /v1/jam, the `jam` event, the `jam` of every Jam write's reply), sends the six Jam writes and
// parses Jam links. It shows nothing: ENJamActions (ACTIONS) and the screens read it and observe ENJamChangedNotification.
//
// Privacy (§4.1): the join token, the link, the code token, member ids and session data never go into an ENLog line or
// /v1/diag. The clipboard bookkeeping (NSUserDefaults `jamClipboard`) keeps only SHA-1 hashes of the links it has seen.
// No prompt and no clipboard check ever calls the gateway (§6.6): a link is only checked by Join.
// Main thread only; every block is called on the main thread.

extern NSString *const ENJamChangedNotification;     // posted on every change. userInfo: ENJamEventKey -> the ev dictionary
                                                     // ({k, n?, why?}, §4.5) when something happened (absent otherwise), and
                                                     // ENJamOwnEventKey @YES when that ev is the echo of our own Start / Join /
                                                     // Leave / End (the action shows its own HUD, the event's is skipped)
extern NSString *const ENJamEventKey;
extern NSString *const ENJamOwnEventKey;
extern NSString *const ENJamGuestPlayNotification;   // a guest tapped a song row, Play / Shuffle, a search song or a pasted link:
                                                     // ENPlayback sent nothing (§6.3); userInfo ENJamURIKey -> the uri (a song,
                                                     // or the context of a Play / Shuffle button). ENJamActions observes it (§6.9)
extern NSString *const ENJamURIKey;
extern NSString *const ENJamErrorRoleKey;            // NSError userInfo of a 409 jam_active: error.r, the current role ("host" |
                                                     // "guest"); host: the caller confirms, then joins again with replace; guest: it re-sends at once

@interface ENJam : NSObject

+ (instancetype)shared;

// ENPlayback -start: the observers (gateway version, app active), then one refresh:NO as soon as the gateway is known to be
// 0.6.0 or newer; again on every `reset` event (ENPlayback calls refresh:NO) and when the app becomes active.
- (void)startObserving;

@property (nonatomic, readonly) BOOL available;      // gateway >= 0.6.0 ([ENCatalog shared].gatewayVersion); NO while unknown
@property (nonatomic, readonly) BOOL loaded;         // a JAM object arrived since launch (the clipboard prompt waits for it)
@property (nonatomic, readonly) BOOL active;         // on: a Jam plays on Encore (or wait / away)
@property (nonatomic, readonly) BOOL hosting;        // r "host"
@property (nonatomic, readonly) BOOL guest;          // r "guest" (neither while lim: the role is unknown)
@property (nonatomic, readonly) BOOL limited;        // lim: seen on the speaker, the session can't be read (plan B)
@property (nonatomic, readonly) BOOL away;           // the Jam goes on, another device took playback from Encore
@property (nonatomic, readonly) BOOL waiting;        // wait: Spotify started our Jam but hasn't sent it to Encore
@property (nonatomic, readonly) BOOL fake;           // the admin page's fake Jam (T-j4)
@property (nonatomic, readonly) BOOL canControl;     // ctl; YES while no Jam is on
@property (nonatomic, readonly) BOOL guestsCanControl;   // gc
@property (nonatomic, readonly) NSArray *members;    // ENJamMember, join order (empty with lim)
@property (nonatomic, readonly) ENJamMember *host;
@property (nonatomic, readonly) NSString *hostName;  // hn (nil when unknown). (R2a) While Anonymous Mode is on: the host's made-up
                                                     // name (ENAnon), "You" for this account
@property (nonatomic, readonly) NSUInteger count;    // cnt (else members.count)
@property (nonatomic, readonly) NSString *token, *link, *codeImageToken;   // t, l, ci: never logged
@property (nonatomic, readonly) BOOL busy;           // a Jam write is waiting for its reply (another one is refused at once)

- (BOOL)can:(NSString *)capability;                  // x: sc, gc, kick, add, code
// (R2a) title, label, barText, pillText and the members' names follow Anonymous Mode: "Your Jam" when it is ours, the
// made-up name of anyone else's host
- (NSString *)title;      // "Alex’s Jam" / "Sam’s Jam" / "Jam on Encore"
- (NSString *)label;      // Settings value: "Off" / "Hosting · 3" / "In Sam’s Jam" (nil when not available)
- (NSString *)barText;    // §6.4: "Jam · You, Sam, Robin" / "In Sam’s Jam · 3 listening" / "Jam on Encore" / ...
- (NSString *)barTextFittingWidth:(CGFloat)width font:(UIFont *)font;   // the host's text with as many names as fit (+N)
- (NSString *)pillText;   // §6.7: "Jam · 3 listening" / "Sam’s Jam · 3 listening" / "Jam"
- (ENJamMember *)memberWithID:(NSString *)memberID;
// (R2a) the name a Jam event's HUD shows (ev.n): as sent while Anonymous Mode is off; while on the member's made-up name, by
// ev.id (H2) or by matching ev.n against the members (now, or just before this change); nil when nobody can be named
- (NSString *)nameForEvent:(NSDictionary *)ev;

// GET /v1/jam (ETag; 20 s). fresh -> &fresh=1 (pull to refresh: one session read on the gateway, at most every 10 s). While
// watching, every GET carries w=1 (the lease). Calls made while one is in flight are folded into one more GET after it.
- (void)refresh:(BOOL)fresh;
// The Jam screen: YES = a w=1 GET now and every 20 s while on and the app is active; NO stops the timer (the lease lapses
// after 25 s on the gateway).
- (void)watch:(BOOL)on;

// The writes (§4.4): POST /v1/jam/<action>, 60 s each, never retried here (not even after a network error on a new route:
// ENGateway -sendOnceMethod:…). The reply's `jam` replaces the state at once.
// Errors are ENCatalogErrorDomain NSErrors (code = status, ENCatalogErrorCodeKey, message, retry_after, ENJamErrorRoleKey).
- (void)start:(void (^)(NSError *e))done;
// link: what the user pasted (normalized when it is a socialsession / spotify.link link; the gateway parses and expands it).
// A reply `gen` is opened by ENPlayback like a genCommand reply.
- (void)joinLink:(NSString *)link replace:(BOOL)replace done:(void (^)(NSError *e))done;
- (void)leave:(void (^)(NSError *e))done;
- (void)end:(void (^)(NSError *e))done;              // a reply `gen` (the gateway restarted the song) is opened by ENPlayback
- (void)setGuestsCanControl:(BOOL)on done:(void (^)(NSError *e))done;
- (void)removeMember:(ENJamMember *)m done:(void (^)(NSError *e))done;

// §6.6: the Jam link on the clipboard to offer, or nil. Only when UIPasteboard's changeCount moved since the last look, its
// string (else its URL) is a socialsession URL / URI or a bare spotify.link URL, and that link isn't the current Jam's (its
// token's or its link's, isCurrentJamLink:), the one we copied (noteCopiedLink) or the one offered last; it is then
// recorded as offered. The pasteboard is never changed.
- (NSString *)clipboardJamLink;
- (void)noteCopiedLink;                              // after Copy Link: our own link (`l`) is never offered back
// 4b-c: s is the link of the Jam this phone is in (by its token, or as `l`, the session's own join_session_url, which may be
// a spotify.link URL or carry another token). Only while active; no request. Joining it would only end or leave our Jam.
- (BOOL)isCurrentJamLink:(NSString *)s;

// Links. tokenFromLink: a socialsession URL / URI or a bare token -> the token; a spotify.link URL -> @"" (only the gateway
// can expand it); anything else -> nil. isJamLink: the URL / URI forms only (a socialsession link or a spotify.link URL,
// with or without https://), never a bare word: what the clipboard, encore://open and the Settings field route to Join.
// normalizedJamLink: https://open.spotify.com/socialsession/<t> or https://spotify.link/<x> for those; nil otherwise.
+ (NSString *)tokenFromLink:(NSString *)s;
+ (BOOL)isJamLink:(NSString *)s;
+ (NSString *)normalizedJamLink:(NSString *)s;

// ---- fed by ENPlayback (DATA-internal)
- (void)handleEvent:(NSDictionary *)e;               // a /v1/events entry of type jam (data = JAM + ev)
- (void)noteSnapshot:(NSDictionary *)jamSummary;     // each snapshot's `jam` (nil = no Jam): refresh:NO when it appears,
                                                     // disappears or changes
@end

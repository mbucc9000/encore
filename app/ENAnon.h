#import <Foundation/Foundation.h>

// Anonymous Mode (app 1.1.0, RELEASE-PLAN D1-D5; owner: R2a): show the app off without personal information. Identity is
// hidden, the music is kept. Masking happens IN THE APP AT DISPLAY TIME (D3): the model getters (ENModel.m) and the ~15
// screens that build their own strings ask this helper, so cached models, the disk caches and a live switch all follow it
// on the next draw, and phone-local data (this iPhone's name, the bridge addresses, the device id, Recent searches) is
// covered too. Ids and uris are never masked: navigation, Follow and Remove keep working.
//
// Hidden while on: your name and picture ("You"; the greeting drops the name), other people's names (a stable made-up first
// name per person: +nameForUser:) and pictures (never requested: initials discs instead), follower / following counts,
// other devices' names ("another device", or its type from the bridge: "your computer"), this iPhone's name (the model),
// the bridge addresses ("Hidden"; editing blocked), the device id, the Jam invite (behind "Show Invite"), bridge messages
// that name people or devices (the app's own text, by code: +bridgeText:code:), people in Recent searches, Blends' names and
// covers. The pairing code (and Setup's addresses) are masked fields. Kept: songs, albums, artists, covers, other people's
// playlist names, lyrics, the lock screen. "Hide My Playlist Names" (D2, only while on): your playlists show as
// "My Playlist #n" (n by library order, from the bottom: the newest has the highest number, as Spotify names new ones), and
// their descriptions, folder names and custom-uploaded covers (the bridge's `ugc` flag) are hidden too.
//
// Storage (D5): NSUserDefaults "encore.anonymousMode" and "encore.anonHidePlaylists" (BOOLs, absent = NO), plus
// "encore.anonSalt" (16 random bytes, hex, made on first use) and "encore.anonNames" (keyed HMAC -> the name it was given,
// for the first 600 people, so they keep theirs across launches; no id is ever stored). All of it survives Unpair. A
// pseudonym is NAMES[HMAC-SHA256(salt, user id) mod N] (the next free one on a clash; with every name taken, a lettered
// "Mila R." or a numbered one, again the next free), unrelated to the real name. Two people never share a name.
//
// Threads: +on, +hidesPlaylists, +generation and the name / key helpers may be called from any thread (the model getters
// can run on ENCatalog's parse queue); the setters, +thisDeviceName and the library-derived lookups' refresh run on the
// main thread. Nothing here logs a name, an id or a uri.

extern NSString *const ENAnonChangedNotification;     // posted on the main thread after a switch changed (before the
                                                       // ENThemeDidChangeNotification that makes every list reload)
extern NSString *const ENAnonModeKey;                  // "encore.anonymousMode"
extern NSString *const ENAnonHidePlaylistsKey;         // "encore.anonHidePlaylists"

@class ENPlaylist;

@interface ENAnon : NSObject

// ---- the switches (Settings → Privacy)
+ (BOOL)on;
+ (void)setOn:(BOOL)on;                                // stores; when it changes: generation++, ENAnonChangedNotification,
                                                       // then ENThemeDidChangeNotification (object +[ENTheme current])
+ (BOOL)hidePlaylistsSetting;                          // the stored second switch (Settings shows it only while on)
+ (void)setHidePlaylistsSetting:(BOOL)hide;            // the same notifications when it changes
+ (BOOL)hidesPlaylists;                                // on && the second switch
+ (NSUInteger)generation;                              // bumped by every change: caches of drawn strings compare it

// ---- people. idOrURI: a Spotify user id (username) or its spotify:user: uri (percent-encoded ids are decoded).
+ (BOOL)isMe:(NSString *)idOrURI;                      // the signed-in account (the library's me.id)
// "You" for the signed-in account, "Spotify" for Spotify's own account, else the person's made-up first name; nil for nil /
// empty. Works whether or not the mode is on (callers ask only while it is).
+ (NSString *)nameForUser:(NSString *)idOrURI;
// the same, keyed by `name` when there is no id (an old cached row without `ou`); nil when both are nil
+ (NSString *)nameForUser:(NSString *)idOrURI fallbackName:(NSString *)name;
// what an avatar's colour hashes from while on: a keyed hash of the id (never the id itself)
+ (NSString *)avatarKeyForUser:(NSString *)idOrURI;
+ (NSString *)initialOf:(NSString *)name;              // the first letter, upper case; "?" for none

// ---- devices
// While on: another Spotify device's name as its kind, from the bridge's remote.type (H1) when it sent one: "your
// computer", "your phone", "your tablet", "a speaker", "your TV", "your car", "a game console", else "another device".
// While off (or for a nil name): name unchanged.
+ (NSString *)deviceName:(NSString *)name type:(NSString *)type;
+ (NSString *)thisDeviceName;                          // main thread: the model ("iPhone") while on, else the user-set name

// ---- playlists ("Hide My Playlist Names")
// YES for a playlist of yours: own, an editable collaborative one, one whose owner uri is yours, or one the library lists
// as such. Only meaningful with the library known (it is read from [ENCatalog shared].library on the main thread).
+ (BOOL)isMyPlaylist:(ENPlaylist *)pl;
+ (NSString *)myPlaylistTitleForURI:(NSString *)uri;   // "My Playlist #n" (n by library order), "My Playlist" when unknown

// ---- bridge messages (D1: "bridge messages that name people or devices")
// YES when a bridge message with this code can carry a person's, a device's or a playlist's name, or a Spotify route with an
// id in it: such a message is never logged (its code is) and shows as the app's own text while on.
+ (BOOL)codeNamesSomeone:(NSString *)code message:(NSString *)message;
// While on: the app's own text for such a message (by code); otherwise message unchanged.
+ (NSString *)bridgeText:(NSString *)message code:(NSString *)code;

@end

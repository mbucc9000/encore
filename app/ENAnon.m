#import "ENAnon.h"
#import "ENModel.h"
#import "ENCatalog.h"
#import "ENTheme.h"
#import "ENUtil.h"
#import "ENDiag.h"
#import <UIKit/UIKit.h>
#import <Security/Security.h>
#import <CommonCrypto/CommonHMAC.h>

// See ENAnon.h.

NSString *const ENAnonChangedNotification = @"ENAnonChangedNotification";
NSString *const ENAnonModeKey = @"encore.anonymousMode";
NSString *const ENAnonHidePlaylistsKey = @"encore.anonHidePlaylists";
static NSString *const ENAnonSaltKey = @"encore.anonSalt";
static NSString *const ENAnonNamesKey = @"encore.anonNames";
static const NSUInteger ENAnonNamesCap = 600;          // names kept across launches (keyed hashes); past it a name is still
                                                       // unique and stable for the rest of the run, only not saved

// The made-up first names: short, mixed, easy to read in a 22 pt avatar row. (A clash takes the next free one; past the
// list's end a name gets a letter, "Mila R.", the next free letter or name on a clash, then a number)
static NSString *const ENAnonNames[] = {
	@"Ada", @"Aiden", @"Alba", @"Alex", @"Ali", @"Alma", @"Amara", @"Amir", @"Ana", @"Anika", @"Ari", @"Arlo", @"Asha",
	@"Aya", @"Bea", @"Beau", @"Ben", @"Bianca", @"Bodhi", @"Bruno", @"Cai", @"Cal", @"Carla", @"Cass", @"Cleo", @"Cole",
	@"Cora", @"Dani", @"Dara", @"Dev", @"Dina", @"Dion", @"Eden", @"Eli", @"Ella", @"Elsa", @"Emil", @"Ena", @"Enzo",
	@"Esme", @"Eva", @"Ezra", @"Faye", @"Felix", @"Finn", @"Flora", @"Gia", @"Gus", @"Hana", @"Hugo", @"Ida", @"Ines",
	@"Iris", @"Isla", @"Ivo", @"Ivy", @"Jade", @"Jai", @"Jasper", @"Joel", @"Juno", @"Kai", @"Kara", @"Kenji", @"Kira",
	@"Lara", @"Leo", @"Lena", @"Levi", @"Lila", @"Lina", @"Luca", @"Lucy", @"Lulu", @"Luz", @"Maya", @"Mila", @"Milo",
	@"Mina", @"Nadia", @"Nell", @"Nico", @"Nina", @"Noa", @"Noor", @"Nora", @"Odin", @"Olive", @"Omar", @"Otto", @"Paz",
	@"Pia", @"Quinn", @"Rae", @"Remy", @"Rhea", @"Rio", @"Rosa", @"Ruby", @"Rumi", @"Sami", @"Sana", @"Sara", @"Sasha",
	@"Selma", @"Sid", @"Sora", @"Tara", @"Tess", @"Theo", @"Tia", @"Tomas", @"Uma", @"Vera", @"Vik", @"Wren", @"Yara",
	@"Yuki", @"Zara", @"Zeke", @"Zoe", @"Abel", @"Adele", @"Aditi", @"Agnes", @"Aiko", @"Alan", @"Alice", @"Anton",
	@"April", @"Arjun", @"Aurora", @"Basil", @"Bella", @"Boris", @"Brett", @"Celia", @"Chloe", @"Clara", @"Cyrus", @"Daisy",
	@"Dante", @"Diego", @"Dora", @"Edgar", @"Edith", @"Elena", @"Elio", @"Elliot", @"Emery", @"Erik", @"Etta", @"Fern",
	@"Fiona", @"Frida", @"Gemma", @"Greta", @"Hazel", @"Hector", @"Holly", @"Ilse", @"Imani", @"Ingrid", @"Isaac", @"Jonah",
	@"June", @"Kaito", @"Kamal", @"Karim", @"Kofi", @"Lars", @"Laila", @"Leila", @"Lev", @"Liam", @"Lior", @"Lotte",
	@"Mabel", @"Malik", @"Mara", @"Mateo", @"Maxim", @"Meera", @"Mika", @"Milan", @"Mira", @"Nala", @"Naomi",
	@"Nils", @"Nolan", @"Olga", @"Oren", @"Oscar", @"Paloma", @"Pablo", @"Petra", @"Priya", @"Rafa", @"Ravi", @"Reza",
	@"Rina", @"Rocco", @"Rohan", @"Ronja", @"Rowan", @"Sadie", @"Saul", @"Sean", @"Silas", @"Simone", @"Sofia", @"Stella",
	@"Suki", @"Talia", @"Tariq", @"Thea", @"Tobias", @"Ulla", @"Valeria", @"Vince", @"Viola", @"Wanda", @"Willa", @"Xena",
	@"Yasmin", @"Yusuf", @"Zain", @"Zelda", @"Ziggy", @"Zora",
};
static const NSUInteger ENAnonNameCount = sizeof ENAnonNames / sizeof ENAnonNames[0];

// state (see the header's "Threads"): the switches and the generation are plain words read from any thread; the name table
// and the library-derived lookups sit behind gLock
static BOOL gLoaded, gOn, gHide;
static volatile NSUInteger gGen = 1;
static NSObject *gLock;
static NSData *gSalt;
static NSMutableDictionary *gNames;                    // keyed hash (hex) -> name, everyone named in this run
static NSMutableDictionary *gSaved;                    // the part of it kept across launches (at most ENAnonNamesCap)
static NSMutableSet *gTaken;                           // the names given
static BOOL gSaveQueued;
static ENLibrary *gLib;                                // the library the two below were read from (compared only)
static NSString *gMeID;                                // its me.id
static NSDictionary *gMyNumbers;                       // playlist uri -> NSNumber n of "My Playlist #n"

static void ENAnonLoad(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		gLock = [NSObject new];
		NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
		gOn = [ud boolForKey:ENAnonModeKey];
		gHide = [ud boolForKey:ENAnonHidePlaylistsKey];
		NSDictionary *names = [ud dictionaryForKey:ENAnonNamesKey];
		gNames = [NSMutableDictionary dictionaryWithCapacity:names.count];
		gSaved = [NSMutableDictionary dictionaryWithCapacity:names.count];
		gTaken = [NSMutableSet setWithCapacity:names.count];
		for (id k in names) {
			id v = names[k];
			if (![k isKindOfClass:[NSString class]] || !ENJStr(v)) continue;
			gNames[k] = v;
			gSaved[k] = v;
			[gTaken addObject:v];
		}
		gLoaded = YES;
	});
}

// 16 random bytes, made once per install (kept across Unpair); hex in NSUserDefaults
static NSData *ENAnonSalt(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
		NSString *hex = ENJStr([ud stringForKey:ENAnonSaltKey]);
		NSMutableData *d = nil;
		if (hex.length == 32) {
			d = [NSMutableData dataWithCapacity:16];
			for (NSUInteger i = 0; i + 1 < hex.length; i += 2) {
				unsigned int b = 0;
				if (![[NSScanner scannerWithString:[hex substringWithRange:NSMakeRange(i, 2)]] scanHexInt:&b]) { d = nil; break; }
				uint8_t c = (uint8_t)b;
				[d appendBytes:&c length:1];
			}
		}
		if (d.length != 16) {
			uint8_t buf[16];
			if (SecRandomCopyBytes(kSecRandomDefault, sizeof buf, buf) != 0)
				for (NSUInteger i = 0; i < sizeof buf; i++) buf[i] = (uint8_t)arc4random_uniform(256);
			d = [NSMutableData dataWithBytes:buf length:sizeof buf];
			NSMutableString *out = [NSMutableString stringWithCapacity:32];
			for (NSUInteger i = 0; i < sizeof buf; i++) [out appendFormat:@"%02x", buf[i]];
			[ud setObject:out forKey:ENAnonSaltKey];
		}
		gSalt = [d copy];
	});
	return gSalt;
}

// HMAC-SHA256(salt, kind + ":" + value): the first 8 bytes as hex (the table key) and the first 4 as a number
static NSString *ENAnonKey(NSString *kind, NSString *value, uint32_t *num) {
	NSData *salt = ENAnonSalt();
	NSData *msg = [[NSString stringWithFormat:@"%@:%@", kind, value] dataUsingEncoding:NSUTF8StringEncoding];
	unsigned char mac[CC_SHA256_DIGEST_LENGTH];
	CCHmac(kCCHmacAlgSHA256, salt.bytes, salt.length, msg.bytes, msg.length, mac);
	if (num) *num = ((uint32_t)mac[0] << 24) | ((uint32_t)mac[1] << 16) | ((uint32_t)mac[2] << 8) | (uint32_t)mac[3];
	NSMutableString *out = [NSMutableString stringWithCapacity:16];
	for (int i = 0; i < 8; i++) [out appendFormat:@"%02x", mac[i]];
	return out;
}

// a user id from an id or a spotify:user: uri (nil for anything else that isn't a usable id)
static NSString *ENAnonUserID(NSString *idOrURI) {
	NSString *s = ENJStr(idOrURI);
	if (!s) return nil;
	if ([s hasPrefix:@"spotify:user:"]) return ENUserIDFromURI(s);
	return s;
}

static void ENAnonSaveNamesSoon(void) {
	if (gSaveQueued) return;          // (gLock held by the caller)
	gSaveQueued = YES;
	dispatch_async(dispatch_get_main_queue(), ^{
		NSDictionary *copy;
		@synchronized (gLock) {
			gSaveQueued = NO;
			copy = [gSaved copy];
		}
		[[NSUserDefaults standardUserDefaults] setObject:copy forKey:ENAnonNamesKey];
	});
}

// the name for a keyed hash: the one it was given, else the next free one from its own start in the list; with every
// first name taken, "<name> <letter>." from its own start and letter, the next free letter or name on a clash, and last
// "<name> <number>". Every name given is remembered for the run, so two people never share one; the first
// ENAnonNamesCap are also saved, so they come back after a restart.
static NSString *ENAnonNameForKey(NSString *key, uint32_t num) {
	ENAnonLoad();
	@synchronized (gLock) {
		NSString *n = gNames[key];
		if (n) return n;
		NSUInteger start = num % ENAnonNameCount;
		for (NSUInteger i = 0; i < ENAnonNameCount && !n; i++) {
			NSString *c = ENAnonNames[(start + i) % ENAnonNameCount];
			if (![gTaken containsObject:c]) n = c;
		}
		NSUInteger letter = (num >> 8) % 26;
		for (NSUInteger i = 0; i < ENAnonNameCount * 26 && !n; i++) {
			NSString *c = [NSString stringWithFormat:@"%@ %c.", ENAnonNames[(start + i / 26) % ENAnonNameCount],
			               (char)('A' + (letter + i) % 26)];
			if (![gTaken containsObject:c]) n = c;
		}
		for (NSUInteger k = 2; !n; k++) {
			NSString *c = [NSString stringWithFormat:@"%@ %lu", ENAnonNames[start], (unsigned long)k];
			if (![gTaken containsObject:c]) n = c;
		}
		gNames[key] = n;
		[gTaken addObject:n];
		if (gSaved.count < ENAnonNamesCap) {
			gSaved[key] = n;
			ENAnonSaveNamesSoon();
		}
		return n;
	}
}

// Main thread: me.id and the "My Playlist #n" numbers from the library the catalog holds now (only when it changed)
static void ENAnonSyncLibrary(void) {
	if (![NSThread isMainThread]) return;
	ENLibrary *lib = [ENCatalog shared].library;
	ENAnonLoad();
	@synchronized (gLock) {
		if (lib == gLib && (gMyNumbers || !lib)) return;
		gLib = lib;
		gMeID = [lib.meID copy];
		NSMutableArray *mine = [NSMutableArray array];
		for (ENPlaylist *p in lib.playlists) {
			BOOL m = p.own || (p.editable && p.collaborative) || (gMeID && [ENUserIDFromURI(p.ownerURI) isEqualToString:gMeID]);
			if (m && p.uri) [mine addObject:p.uri];
		}
		NSMutableDictionary *nums = [NSMutableDictionary dictionaryWithCapacity:mine.count];
		NSUInteger total = mine.count;
		[mine enumerateObjectsUsingBlock:^(NSString *uri, NSUInteger i, BOOL *stop) {
			if (!nums[uri]) nums[uri] = @(total - i);       // from the bottom: the newest (top) has the highest number
		}];
		gMyNumbers = [nums copy];
	}
}

@implementation ENAnon

#pragma mark - the switches

+ (BOOL)on {
	if (!gLoaded) ENAnonLoad();
	return gOn;
}

+ (BOOL)hidePlaylistsSetting {
	if (!gLoaded) ENAnonLoad();
	return gHide;
}

+ (BOOL)hidesPlaylists {
	if (!gLoaded) ENAnonLoad();
	return gOn && gHide;
}

+ (NSUInteger)generation { return gGen; }

+ (void)changed:(NSString *)what {
	gGen++;
	[[NSUserDefaults standardUserDefaults] synchronize];          // on disk now (a cold launch must find it)
	ENLog(@"privacy: %@", what);
	NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
	[nc postNotificationName:ENAnonChangedNotification object:nil];
	[nc postNotificationName:ENThemeDidChangeNotification object:[ENTheme current]];      // every list reloads
}

+ (void)setOn:(BOOL)on {
	ENAnonLoad();
	if (gOn == on) return;
	gOn = on;
	[[NSUserDefaults standardUserDefaults] setBool:on forKey:ENAnonModeKey];
	[self changed:(on ? @"anonymous mode on" : @"anonymous mode off")];
}

+ (void)setHidePlaylistsSetting:(BOOL)hide {
	ENAnonLoad();
	if (gHide == hide) return;
	gHide = hide;
	[[NSUserDefaults standardUserDefaults] setBool:hide forKey:ENAnonHidePlaylistsKey];
	[self changed:(hide ? @"hide my playlist names on" : @"hide my playlist names off")];
}

#pragma mark - people

+ (BOOL)isMe:(NSString *)idOrURI {
	NSString *uid = ENAnonUserID(idOrURI);
	if (!uid) return NO;
	ENAnonSyncLibrary();
	ENAnonLoad();
	@synchronized (gLock) {
		return gMeID && [gMeID isEqualToString:uid];
	}
}

+ (NSString *)nameForUser:(NSString *)idOrURI { return [self nameForUser:idOrURI fallbackName:nil]; }

+ (NSString *)nameForUser:(NSString *)idOrURI fallbackName:(NSString *)name {
	NSString *uid = ENAnonUserID(idOrURI);
	if (uid) {
		if ([uid isEqualToString:@"spotify"]) return @"Spotify";      // Spotify's own account is public catalog, not a person
		if ([self isMe:uid]) return @"You";
		uint32_t num = 0;
		NSString *key = ENAnonKey(@"u", uid, &num);
		return ENAnonNameForKey(key, num);
	}
	NSString *n = ENJStr(name);
	if (!n) return nil;
	uint32_t num = 0;
	NSString *key = ENAnonKey(@"n", n, &num);
	return ENAnonNameForKey(key, num);
}

+ (NSString *)avatarKeyForUser:(NSString *)idOrURI {
	NSString *uid = ENAnonUserID(idOrURI) ?: ENJStr(idOrURI);
	return uid ? [@"a" stringByAppendingString:ENAnonKey(@"a", uid, NULL)] : nil;
}

+ (NSString *)initialOf:(NSString *)name {
	NSString *n = [name stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
	return n.length ? [[n substringWithRange:[n rangeOfComposedCharacterSequenceAtIndex:0]] uppercaseString] : @"?";
}

#pragma mark - devices

+ (NSString *)deviceName:(NSString *)name type:(NSString *)type {
	if (!name || ![self on]) return name;
	NSString *t = [ENJStr(type) lowercaseString];
	if (!t) return @"another device";
	if ([t isEqualToString:@"computer"]) return @"your computer";
	if ([t isEqualToString:@"smartphone"]) return @"your phone";
	if ([t isEqualToString:@"tablet"]) return @"your tablet";
	if ([t isEqualToString:@"speaker"] || [t isEqualToString:@"avr"] || [t isEqualToString:@"audiodongle"] ||
	    [t isEqualToString:@"castaudio"]) return @"a speaker";
	if ([t isEqualToString:@"tv"] || [t isEqualToString:@"stb"] || [t isEqualToString:@"castvideo"]) return @"your TV";
	if ([t isEqualToString:@"automobile"]) return @"your car";
	if ([t isEqualToString:@"gameconsole"]) return @"a game console";
	return @"another device";
}

+ (NSString *)thisDeviceName {
	UIDevice *d = [UIDevice currentDevice];
	if ([self on]) return d.model.length ? d.model : @"iPhone";
	return d.name;
}

#pragma mark - playlists

+ (BOOL)isMyPlaylist:(ENPlaylist *)pl {
	if (!pl) return NO;
	if (pl.own || (pl.editable && pl.collaborative)) return YES;
	ENAnonSyncLibrary();
	ENAnonLoad();
	BOOL listed;
	@synchronized (gLock) {
		listed = pl.uri && gMyNumbers[pl.uri] != nil;
	}
	return listed || (pl.ownerURI && [self isMe:pl.ownerURI]);
}

+ (NSString *)myPlaylistTitleForURI:(NSString *)uri {
	ENAnonSyncLibrary();
	ENAnonLoad();
	NSNumber *n;
	@synchronized (gLock) {
		n = uri ? gMyNumbers[uri] : nil;
	}
	return n ? [NSString stringWithFormat:@"My Playlist #%ld", (long)[n integerValue]] : @"My Playlist";
}

#pragma mark - bridge messages

// "Spotify refused this (GET /v1/users/…: …)" and the like (gateway webapi.js): the route can carry an id
static BOOL ENAnonHasRoute(NSString *m) {
	static NSRegularExpression *re;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		re = [NSRegularExpression regularExpressionWithPattern:@"\\b(GET|POST|PUT|DELETE|PATCH)\\s+/" options:0 error:NULL];
	});
	return m.length && [re firstMatchInString:m options:0 range:NSMakeRange(0, m.length)] != nil;
}

+ (BOOL)codeNamesSomeone:(NSString *)code message:(NSString *)message {
	static NSSet *named, *routed;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		// in_jam / jam_no_control name the host, jam_moved / jam_away a device, duplicate a playlist (gateway jam.js,
		// player.js, catalog.js)
		named = [NSSet setWithObjects:@"in_jam", @"jam_no_control", @"jam_moved", @"jam_away", @"duplicate", nil];
		routed = [NSSet setWithObjects:@"spotify_forbidden", @"spotify_error", @"not_found", @"spotify_auth", nil];
	});
	if (!code) return NO;
	if ([named containsObject:code]) return YES;
	return [routed containsObject:code] && ENAnonHasRoute(message);
}

+ (NSString *)bridgeText:(NSString *)message code:(NSString *)code {
	if (!message.length || ![self on] || ![self codeNamesSomeone:code message:message]) return message;
	if ([code isEqualToString:@"in_jam"]) return @"Leave this Jam to play something else.";
	if ([code isEqualToString:@"jam_no_control"]) return @"Only the Jam’s host can control its playback. You can still add songs.";
	if ([code isEqualToString:@"jam_moved"]) return @"Your Jam is playing on another device. Play it here from Spotify on that device.";
	if ([code isEqualToString:@"jam_away"]) return @"Spotify started the Jam on another device. Play it on Encore from there, or end it.";
	if ([code isEqualToString:@"duplicate"]) return [self hidesPlaylists] ? @"This song is already in that playlist." : message;
	if ([code isEqualToString:@"spotify_forbidden"]) return @"Spotify refused this.";
	if ([code isEqualToString:@"not_found"]) return @"Spotify doesn’t have this.";
	return @"Spotify didn’t answer. Try again in a moment.";
}

@end

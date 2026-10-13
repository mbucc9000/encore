#import "ENUserRows.h"
#import "ENModel.h"
#import "ENUtil.h"
#import "ENAnon.h"
#import "ENL.h"

// (0.11 profiles) see ENUserRows.h

@implementation ENListCell (ENUser)

- (void)showUser:(ENUserRow *)u subtitle:(NSString *)sub {
	[self showTitle:(u.name ?: @"") subtitle:sub image:nil chevron:YES];
	self.art = ENCellArtRound;             // the round art column (showTitle: with no image left none)
	[self setImageToken:u.image];          // 88 tier, round; nil = the round placeholder
	// (R2a) Anonymous Mode: u.name is the made-up name and u.image nil (no real picture is ever asked for): its initials disc
	if ([ENAnon on]) [self setInitialsName:u.name key:[ENAnon avatarKeyForUser:u.userID]];
	self.item = u;
}

@end

NSString *ENProfilePlaylistSub(ENPlaylist *pl, NSString *profileName) {
	if (pl.followers > 0) return ENCountText(pl.followers, ENL(@"follower"), ENL(@"followers"));
	if (pl.owner.length && !(profileName.length && [pl.owner isEqualToString:profileName])) return [NSString stringWithFormat:ENL(@"by %@"), pl.owner];
	return ENL(@"Playlist");
}

NSString *ENGroupedNumber(NSInteger n) {
	static NSNumberFormatter *f;
	if (!f) {
		f = [[NSNumberFormatter alloc] init];
		f.numberStyle = NSNumberFormatterDecimalStyle;
		f.usesGroupingSeparator = YES;
	}
	return [f stringFromNumber:@(n)] ?: [NSString stringWithFormat:@"%ld", (long)n];
}

BOOL ENSameUser(NSString *a, NSString *b) {
	NSString *x = ENUserIDFromURI(a), *y = ENUserIDFromURI(b);
	return x && y && [x isEqualToString:y];
}

#import "ENKeychain.h"
#import <Security/Security.h>

static NSString *const kService = @"com.mbucc9000.encore";
static NSString *const kAccount = @"gateway-pairing";

static NSString *ENFallbackPath(void) {
	NSString *dir = [NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES) objectAtIndex:0];
	return [dir stringByAppendingPathComponent:@"Encore/pairing.plist"];
}

@implementation ENKeychain

+ (NSMutableDictionary *)query {
	return [@{ (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
	           (__bridge id)kSecAttrService: kService,
	           (__bridge id)kSecAttrAccount: kAccount } mutableCopy];
}

+ (NSDictionary *)load {
	NSMutableDictionary *q = [self query];
	q[(__bridge id)kSecReturnData] = @YES;
	q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
	CFTypeRef out = NULL;
	OSStatus st = SecItemCopyMatching((__bridge CFDictionaryRef)q, &out);
	if (st == errSecSuccess && out) {
		NSData *data = (__bridge_transfer NSData *)out;
		NSDictionary *d = [NSPropertyListSerialization propertyListWithData:data options:0 format:NULL error:NULL];
		if ([d isKindOfClass:[NSDictionary class]]) return d;
	}
	NSDictionary *f = [NSDictionary dictionaryWithContentsOfFile:ENFallbackPath()];
	return f.count ? f : nil;
}

+ (BOOL)save:(NSDictionary *)creds {
	[self clear];
	NSData *data = [NSPropertyListSerialization dataWithPropertyList:creds format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL];
	if (!data) return NO;
	NSMutableDictionary *q = [self query];
	q[(__bridge id)kSecValueData] = data;
	q[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlock;   // background audio after a reboot+unlock
	OSStatus st = SecItemAdd((__bridge CFDictionaryRef)q, NULL);
	if (st == errSecSuccess) return YES;
	NSLog(@"[Encore] keychain add failed (%d), using the file fallback", (int)st);
	NSString *path = ENFallbackPath();
	[[NSFileManager defaultManager] createDirectoryAtPath:[path stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:nil error:NULL];
	BOOL ok = [creds writeToFile:path atomically:YES];
	[[NSFileManager defaultManager] setAttributes:@{ NSFilePosixPermissions: @0600,
	                                                  NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication }
	                                 ofItemAtPath:path error:NULL];
	return ok;
}

+ (void)clear {
	SecItemDelete((__bridge CFDictionaryRef)[self query]);
	[[NSFileManager defaultManager] removeItemAtPath:ENFallbackPath() error:NULL];
}

@end

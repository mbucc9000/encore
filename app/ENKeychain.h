#import <Foundation/Foundation.h>

// Pairing credentials (device id + secret). Keychain first; falls back to a protected file if the Keychain refuses
// (ldid-signed apps on some jailbreaks don't get a working keychain access group).
@interface ENKeychain : NSObject
+ (NSDictionary *)load;
+ (BOOL)save:(NSDictionary *)creds;
+ (void)clear;
@end

#import "ENLang.h"

NSString *const ENLanguageDidChangeNotification = @"ENLanguageDidChangeNotification";
static NSString *const ENLanguageKey = @"ENLanguage";
static NSBundle *ENLangBundle;                    // the chosen language's .lproj; nil = the main bundle (Automatic)
static BOOL ENLangLoaded;

@implementation ENLang

+ (NSArray *)codes {
	return @[ @"en", @"es", @"pt", @"fr", @"de", @"it", @"nl", @"pl", @"ru", @"tr", @"ja", @"ko", @"zh_CN" ];
}

+ (NSString *)nativeNameForCode:(NSString *)code {
	static NSDictionary *names;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		names = @{ @"en": @"English", @"es": @"Español", @"pt": @"Português (Brasil)", @"fr": @"Français", @"de": @"Deutsch",
		           @"it": @"Italiano", @"nl": @"Nederlands", @"pl": @"Polski", @"ru": @"Русский", @"tr": @"Türkçe",
		           @"ja": @"日本語", @"ko": @"한국어", @"zh_CN": @"简体中文" };
	});
	return names[code] ?: names[@"en"];
}

+ (NSString *)chosen {
	NSString *c = [[NSUserDefaults standardUserDefaults] stringForKey:ENLanguageKey];
	return [[self codes] containsObject:c] ? c : nil;
}

+ (void)useCode:(NSString *)code {
	NSString *path = code ? [[NSBundle mainBundle] pathForResource:code ofType:@"lproj"] : nil;
	ENLangBundle = path ? [NSBundle bundleWithPath:path] : nil;
	ENLangLoaded = YES;
}

+ (void)setChosen:(NSString *)code {
	if (![[self codes] containsObject:code]) code = nil;
	NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
	if (code) [d setObject:code forKey:ENLanguageKey]; else [d removeObjectForKey:ENLanguageKey];
	[d synchronize];
	[self useCode:code];
	[[NSNotificationCenter defaultCenter] postNotificationName:ENLanguageDidChangeNotification object:nil];
}

+ (NSString *)activeCode {
	return [self chosen] ?: [self systemCode];
}

+ (NSString *)systemCode {
	NSArray *picks = [[NSBundle mainBundle] preferredLocalizations];
	NSString *pick = picks.count ? picks[0] : nil;
	return [[self codes] containsObject:pick] ? pick : @"en";
}

+ (NSString *)localized:(NSString *)english {
	if (!english) return nil;
	if (!ENLangLoaded) [self useCode:[self chosen]];
	return [(ENLangBundle ?: [NSBundle mainBundle]) localizedStringForKey:english value:english table:nil];
}

@end

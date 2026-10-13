#import <Foundation/Foundation.h>

// The app's own language (Settings → Language), independent of the iPhone's: Automatic (the iPhone's language, as iOS picks
// it from the app's .lproj folders) or one of the app's languages. ENL() looks text up in the chosen language's
// Localizable.strings and falls back to the English text. The choice is saved in NSUserDefaults (ENLanguage) and applies at
// once: +setChosen: posts ENLanguageDidChangeNotification and ENAppDelegate rebuilds the tabs (playback keeps going).
// The bridge gets the same language (X-Encore-Lang on every request, ENGateway), so its messages match.
extern NSString *const ENLanguageDidChangeNotification;

@interface ENLang : NSObject
+ (NSArray *)codes;                              // en, es, pt, fr, de, it, nl, pl, ru, tr, ja, ko, zh_CN (the .lproj names)
+ (NSString *)nativeNameForCode:(NSString *)code; // "Deutsch", "日本語", ...
+ (NSString *)chosen;                            // nil = Automatic
+ (void)setChosen:(NSString *)code;              // nil = Automatic
+ (NSString *)systemCode;                        // iOS's pick for the app from the iPhone's languages (Automatic)
+ (NSString *)activeCode;                        // what the app shows now: the chosen one, else +systemCode
+ (NSString *)localized:(NSString *)english;     // ENL()
@end

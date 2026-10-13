// Localized UI text: ENL(s), with s an @"English text" literal, looks the text up in Localizable.strings for the app's
// language (Settings → Language, ENLang.h; Automatic = the phone's) in Resources/<lang>.lproj, and falls back to the English
// text itself. Only on-screen text goes through it: never keys, URLs, server values, log or diagnostics lines.
#import "ENLang.h"
#define ENL(s) [ENLang localized:(s)]

// Localized UI text: ENL(s), with s an @"English text" literal, looks the text up in Localizable.strings for the phone's language
// (Resources/<lang>.lproj) and falls back to the English text itself. Only on-screen text goes through it: never keys,
// URLs, server values, log or diagnostics lines.
#define ENL(s) [[NSBundle mainBundle] localizedStringForKey:(s) value:(s) table:nil]

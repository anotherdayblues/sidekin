// The user's preferred language list (comma-separated BCP-47 tags,
// e.g. "zh-Hans-CN,en-US"), for extensible locale matching.
#import <Foundation/Foundation.h>
#include <string.h>

void companion_preferred_language(char *out, size_t len) {
  @autoreleasepool {
    NSArray<NSString *> *langs = NSLocale.preferredLanguages;
    NSString *joined =
        langs.count > 0 ? [langs componentsJoinedByString:@","] : @"";
    strlcpy(out, joined.UTF8String ?: "", len);
  }
}

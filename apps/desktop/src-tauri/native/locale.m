// The user's first preferred language, e.g. "zh-Hans-CN", for plan/15.
#import <Foundation/Foundation.h>
#include <string.h>

void companion_preferred_language(char *out, size_t len) {
  @autoreleasepool {
    NSString *tag = NSLocale.preferredLanguages.firstObject ?: @"";
    strlcpy(out, tag.UTF8String ?: "", len);
  }
}

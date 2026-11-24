// Passive session tap. Report only a fresh Command+C press, never typed text.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdint.h>
#include <unistd.h>

extern void companion_copy_press(uint64_t ms, intptr_t owner, intptr_t counter);
static CFMachPortRef tap;
static CFRunLoopSourceRef source;
static CGEventRef handle(CGEventTapProxy proxy, CGEventType type, CGEventRef e, void *ctx) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (tap) CGEventTapEnable(tap, true);
    return e;
  }
  CGEventFlags relevant = kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate |
                          kCGEventFlagMaskShift | kCGEventFlagMaskControl;
  if (type != kCGEventKeyDown || (CGEventGetFlags(e) & relevant) != kCGEventFlagMaskCommand ||
      CGEventGetIntegerValueField(e, kCGKeyboardEventAutorepeat) ||
      CGEventGetIntegerValueField(e, kCGEventSourceUnixProcessID) == getpid()) return e;
  @autoreleasepool {
    if ([[NSEvent eventWithCGEvent:e].charactersIgnoringModifiers.lowercaseString isEqualToString:@"c"]) {
      companion_copy_press(CGEventGetTimestamp(e) / 1000000,
          NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier,
          NSPasteboard.generalPasteboard.changeCount);
    }
  }
  return e;
}
int companion_copy_permission(void) { return CGPreflightListenEventAccess(); }
void companion_request_copy_permission(void) {
  (void)CGRequestListenEventAccess();
  [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"]];
}
// Called only on the main event-loop thread.
void companion_copy_monitor(int enabled) {
  if (!enabled && tap) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    CFMachPortInvalidate(tap);
    CFRelease(source); CFRelease(tap); source = NULL; tap = NULL;
  } else if (enabled && !tap && companion_copy_permission()) {
    tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
                           CGEventMaskBit(kCGEventKeyDown), handle, NULL);
    if (!tap) return;
    source = CFMachPortCreateRunLoopSource(NULL, tap, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    CGEventTapEnable(tap, true);
  }
}

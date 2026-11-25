// Selection strategy adapted from yetone/get-selected-text, MIT OR Apache-2.0
// (0ddeb5d67de04660c067f8378970bc486f305032). Preserve all pasteboard items and
// representations.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
static intptr_t temporary_sequence = -1;
intptr_t companion_temporary_sequence(void) { return temporary_sequence; }
intptr_t companion_target(void) {
  return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
}
// The last app the user worked in other than 随伴, so the pet's menu can
// translate what is selected there after a click has brought 随伴 forward.
static pid_t last_other = 0;
static intptr_t last_other_seq = 0;
static id app_observer = nil;
void companion_watch_apps(void) {
  if (app_observer)
    return;
  pid_t me = NSProcessInfo.processInfo.processIdentifier;
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front && front.processIdentifier != me) {
    last_other = front.processIdentifier;
    last_other_seq++;
  }
  app_observer = [NSWorkspace.sharedWorkspace.notificationCenter
      addObserverForName:NSWorkspaceDidActivateApplicationNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                NSRunningApplication *a = note.userInfo[NSWorkspaceApplicationKey];
                if (a && a.processIdentifier != me) {
                  last_other = a.processIdentifier;
                  last_other_seq++;
                }
              }];
}
intptr_t companion_other_sequence(void) { return last_other_seq; }
intptr_t companion_previous_target(void) {
  pid_t me = NSProcessInfo.processInfo.processIdentifier;
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front && front.processIdentifier != me)
    return front.processIdentifier;
  return last_other;
}
intptr_t companion_clip_target(int allow_self) {
  if (allow_self) return companion_target();
  return companion_previous_target();
}
static NSString *attribute(AXUIElementRef el, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(el, name, &value) != kAXErrorSuccess ||
      !value)
    return nil;
  id object = CFBridgingRelease(value);
  return [object isKindOfClass:NSString.class] ? object : nil;
}
static NSString *ax_text(pid_t pid, BOOL *secure) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  CFTypeRef focus = NULL;
  AXUIElementSetMessagingTimeout(app, 0.35);
  AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focus);
  CFRelease(app);
  if (!focus)
    return nil;
  NSString *value = nil;
  if (CFGetTypeID(focus) == AXUIElementGetTypeID()) {
    AXUIElementRef el = (AXUIElementRef)focus;
    *secure = [attribute(el, kAXSubroleAttribute)
        isEqualToString:@"AXSecureTextField"];
    if (!*secure)
      value = attribute(el, kAXSelectedTextAttribute);
  }
  CFRelease(focus);
  return value;
}
static NSArray *snapshot(NSPasteboard *pb) {
  NSMutableArray *result = [NSMutableArray array];
  NSArray *items = pb.pasteboardItems;
  if (pb.types.count && !items.count)
    return nil;
  for (NSPasteboardItem *item in items) {
    NSPasteboardItem *clone = [NSPasteboardItem new];
    for (NSPasteboardType type in item.types) {
      NSData *data = [item dataForType:type];
      if (!data || ![clone setData:data forType:type])
        return nil;
    }
    [result addObject:clone];
  }
  return result;
}
static bool activate_target(intptr_t target);

char *companion_selection(intptr_t target, int *status) {
  @autoreleasepool {
    *status = 0;
    if (!AXIsProcessTrusted()) {
      *status = -1;
      return NULL;
    }
    if (target <= 0)
      return NULL;
    BOOL secure = NO;
    NSString *selection = ax_text((pid_t)target, &secure);
    if (secure)
      return NULL;
    if (selection.length) {
      *status = 1;
      return strdup(selection.UTF8String);
    }
    // When invoked from Suiby's own UI (e.g. the pet right-click menu),
    // Suiby is frontmost; briefly yield focus back to the prior app so AX
    // or Cmd+C can read its selection (matching Windows SetForegroundWindow).
    pid_t me = NSProcessInfo.processInfo.processIdentifier;
    if (companion_target() != target) {
      if (companion_target() != me || !activate_target(target))
        return NULL;
      selection = ax_text((pid_t)target, &secure);
      if (secure)
        return NULL;
      if (selection.length) {
        *status = 1;
        return strdup(selection.UTF8String);
      }
    }
    NSPasteboard *pb = NSPasteboard.generalPasteboard;
    if (companion_target() != target)
      return NULL;
    NSInteger before = pb.changeCount;
    NSArray *saved = snapshot(pb);
    if (!saved || pb.changeCount != before) {
      *status = -2;
      return NULL;
    }
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 8, true),
               up = CGEventCreateKeyboardEvent(NULL, 8, false);
    if (!down || !up) {
      if (down)
        CFRelease(down);
      if (up)
        CFRelease(up);
      *status = -2;
      return NULL;
    }
    CGEventSetFlags(down, kCGEventFlagMaskCommand);
    CGEventSetFlags(up, kCGEventFlagMaskCommand);
    CGEventPostToPid((pid_t)target, down);
    CGEventPostToPid((pid_t)target, up);
    CFRelease(down);
    CFRelease(up);
    for (int i = 0; i < 40 && pb.changeCount == before; i++)
      [NSThread sleepForTimeInterval:.01];
    NSInteger copied = pb.changeCount;
    if (copied == before)
      return NULL;
    // Some apps publish the text and RTF in separate updates. Wait for a quiet
    // interval so a late producer cannot overwrite the restored pasteboard.
    int quiet = 0;
    for (int i = 0; i < 70 && quiet < 10; i++) {
      [NSThread sleepForTimeInterval:.01];
      NSInteger next = pb.changeCount;
      if (next == copied)
        quiet++;
      else {
        copied = next;
        quiet = 0;
      }
    }
    if (quiet < 10 || companion_target() != target) {
      *status = -2;
      return NULL;
    }

    selection = [[pb stringForType:NSPasteboardTypeString] copy];
    // A newer clipboard owner wins; never replace an unrelated subsequent copy.
    if (pb.changeCount != copied) {
      *status = -2;
      return NULL;
    }
    [pb clearContents];
    if (saved.count && ![pb writeObjects:saved]) {
      *status = -2;
      return NULL;
    }
    temporary_sequence = pb.changeCount;
    if (!selection.length)
      return NULL;
    *status = 2;
    return strdup(selection.UTF8String);
  }
}
void companion_free(char *p) { free(p); }

extern NSPasteboard *clip_history_board(void);
static int copy_text(NSPasteboard *pb, const char *text, bool from_history) {
  @autoreleasepool {
    NSString *s = [NSString stringWithUTF8String:text];
    if (!s)
      return 0;
    [pb clearContents];
    BOOL written = [pb setString:s forType:NSPasteboardTypeString];
    if (written && from_history) temporary_sequence = pb.changeCount;
    return written;
  }
}
static int copy_png(NSPasteboard *pb, const uint8_t *bytes, size_t len,
                    bool from_history) {
  @autoreleasepool {
    if (!bytes || !len)
      return 0;
    NSData *png = [NSData dataWithBytes:bytes length:len];
    NSImage *image = [[NSImage alloc] initWithData:png];
    NSData *tiff = image.TIFFRepresentation;
    [pb clearContents];
    BOOL written = [pb setData:png forType:NSPasteboardTypePNG];
    if (tiff.length)
      written = [pb setData:tiff forType:NSPasteboardTypeTIFF] || written;
    if (written && from_history)
      temporary_sequence = pb.changeCount;
    return written ? 1 : 0;
  }
}
int companion_copy(const char *text) {
  return copy_text(NSPasteboard.generalPasteboard, text, false);
}
int companion_history_copy(const char *text) {
  return copy_text(clip_history_board(), text, true);
}
int companion_history_copy_image(const uint8_t *bytes, size_t len) {
  return copy_png(clip_history_board(), bytes, len, true);
}
int companion_access(void) { return AXIsProcessTrusted(); }
// Ask macOS for Accessibility: this adds 随伴 to the list in System Settings
// and shows the system prompt, so the user only has to switch it on.
int companion_request_access(void) {
  NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
  return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

// Double copy to translate: the count changes on every copy and reveals
// nothing about the content; the text is read only after a double copy.
intptr_t companion_clipboard_count(void) {
  return clip_history_board().changeCount;
}
char *companion_clipboard_text(void) {
  @autoreleasepool {
    NSString *s = [clip_history_board() stringForType:NSPasteboardTypeString];
    return s ? strdup(s.UTF8String) : NULL;
  }
}

static bool activate_target(intptr_t target) {
  NSRunningApplication *app = [NSRunningApplication
      runningApplicationWithProcessIdentifier:(pid_t)target];
  if (!app || app.terminated)
    return false;
  if (companion_target() != target) {
    void (^activate)(void) = ^{
      if (@available(macOS 14.0, *)) {
        [NSApp yieldActivationToApplication:app];
        [app activateFromApplication:NSRunningApplication.currentApplication
                             options:0];
      } else {
        [app activateWithOptions:0];
      }
    };
    if (NSThread.isMainThread)
      activate();
    else
      dispatch_sync(dispatch_get_main_queue(), activate);
    for (int i = 0; i < 50 && companion_target() != target; i++)
      [NSThread sleepForTimeInterval:.01];
    if (companion_target() != target)
      return false;
    // Let the app put its key window and focus back first.
    [NSThread sleepForTimeInterval:.08];
  }
  return true;
}

static bool send_cmd_v(intptr_t target) {
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, 9, true),
             up = CGEventCreateKeyboardEvent(NULL, 9, false);
  if (!down || !up) {
    if (down)
      CFRelease(down);
    if (up)
      CFRelease(up);
    return false;
  }
  CGEventSetFlags(down, kCGEventFlagMaskCommand);
  CGEventSetFlags(up, kCGEventFlagMaskCommand);
  CGEventPostToPid((pid_t)target, down);
  CGEventPostToPid((pid_t)target, up);
  CFRelease(down);
  CFRelease(up);
  return true;
}

// 替换为译文 (plan/41): put the translation where the selection was. Bring
// the app back, paste with ⌘V, then put the user's clipboard back once the
// app has read it. 1 done, 0 not, -1 no Accessibility.
static int paste_text(intptr_t target, const char *text, bool restore) {
  @autoreleasepool {
    if (!AXIsProcessTrusted())
      return -1;
    NSString *s = [NSString stringWithUTF8String:text];
    if (!s)
      return 0;
    NSPasteboard *pb = NSPasteboard.generalPasteboard;
    NSArray *saved = restore ? snapshot(pb) : nil;
    if (restore && !saved)
      return 0;
    if (!activate_target(target))
      return 0;
    [pb clearContents];
    if (![pb setString:s forType:NSPasteboardTypeString])
      return 0;
    NSInteger ours = pb.changeCount;
    temporary_sequence = ours;
    if (!send_cmd_v(target))
      return 0;
    // Apps read the pasteboard after the key; give them time, then restore
    // unless someone has copied something new meanwhile.
    if (!restore) return 1;
    [NSThread sleepForTimeInterval:.35];
    if (pb.changeCount == ours) {
      [pb clearContents];
      if (saved.count)
        [pb writeObjects:saved];
      temporary_sequence = pb.changeCount;
    }
    return 1;
  }
}

int companion_replace(intptr_t target, const char *text) {
  return paste_text(target, text, true);
}

int companion_history_paste(intptr_t target, const char *text) {
  return paste_text(target, text, false);
}

int companion_history_paste_image(intptr_t target, const uint8_t *bytes,
                                  size_t len) {
  @autoreleasepool {
    if (!AXIsProcessTrusted())
      return -1;
    if (!bytes || !len || !activate_target(target))
      return 0;
    NSPasteboard *pb = NSPasteboard.generalPasteboard;
    if (!copy_png(pb, bytes, len, true))
      return 0;
    return send_cmd_v(target) ? 1 : 0;
  }
}

#import <AppKit/AppKit.h>

// The selection overlay must sit above the menu bar, the Dock and
// full-screen apps, appear without the zoom animation, and stay put on
// every Space (after TRex FrozenScreenSelectionOverlay). Tauri's
// always-on-top is only the floating level, which the menu bar covers.
// Call on the main thread.
void companion_overlay_window(void *ns_window) {
  NSWindow *window = (__bridge NSWindow *)ns_window;
  if (!window)
    return;
  window.level = NSScreenSaverWindowLevel;
  window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                              NSWindowCollectionBehaviorFullScreenAuxiliary |
                              NSWindowCollectionBehaviorStationary |
                              NSWindowCollectionBehaviorIgnoresCycle;
  window.animationBehavior = NSWindowAnimationBehaviorNone;
  window.hidesOnDeactivate = NO;
}

// Puts a PNG on the clipboard, plus TIFF for apps that only read that.
int companion_copy_png(const uint8_t *bytes, size_t len) {
  @autoreleasepool {
    if (!bytes || len == 0)
      return 0;
    NSData *png = [NSData dataWithBytes:bytes length:len];
    NSImage *image = [[NSImage alloc] initWithData:png];
    if (!image)
      return 0;
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    [board clearContents];
    BOOL ok = [board setData:png forType:NSPasteboardTypePNG];
    NSData *tiff = image.TIFFRepresentation;
    if (tiff)
      ok = [board setData:tiff forType:NSPasteboardTypeTIFF] || ok;
    return ok ? 1 : 0;
  }
}

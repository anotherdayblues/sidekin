// Adapted from Droper's pasteboardCounts and Tokri's mouse-drag detection.
// Sources and licenses are recorded in SOURCES.md. No clipboard contents are read.
#import <AppKit/AppKit.h>
typedef struct { double x, y; int left; long drag_count; } LabPointer;
LabPointer lab_pointer(void) {
  @autoreleasepool {
    NSPoint p=NSEvent.mouseLocation;
    CGFloat h=NSScreen.screens.firstObject.frame.size.height;
    NSPasteboard *pb=[NSPasteboard pasteboardWithName:NSPasteboardNameDrag];
    return (LabPointer){p.x,h-p.y,(NSEvent.pressedMouseButtons & 1)!=0,pb.changeCount};
  }
}

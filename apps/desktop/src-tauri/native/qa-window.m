// Included only in the acceptance build. Request precisely one owned window.
// Resolve the legacy symbol just as xcap does, without ever falling back to the display.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <stdlib.h>
size_t qa_window_png(void *handle,unsigned char **bytes){
 @autoreleasepool{
   NSWindow *window=(__bridge NSWindow*)handle;
   if (!window || window.windowNumber<=0 || !CGPreflightScreenCaptureAccess())return 0;
   typedef CGImageRef (*Reader)(CGRect,CGWindowListOption,CGWindowID,CGWindowImageOption);
   Reader read=(Reader)dlsym(RTLD_DEFAULT,"CGWindowListCreateImage");if(!read)return 0;
   CGImageRef image=read(CGRectNull,kCGWindowListOptionIncludingWindow,(CGWindowID)window.windowNumber,kCGWindowImageBoundsIgnoreFraming);
   if(!image)return 0;
   NSBitmapImageRep *rep=[[NSBitmapImageRep alloc]initWithCGImage:image];CGImageRelease(image);
   NSData *data=[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
   if(!data.length)return 0;
   *bytes=malloc(data.length);if(!*bytes)return 0;memcpy(*bytes,data.bytes,data.length);return data.length;
 }}

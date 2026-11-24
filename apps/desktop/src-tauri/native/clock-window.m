#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

// The 番茄钟 clock's window grows from its resting bar into the clock and
// back (focus_clock.rs). The window itself is the glass (Liquid Glass, or
// the HUD material before macOS 26), so the window is what changes size:
// about its own centre, a step each frame on the main thread, the glass
// kept a capsule (corner radius half the height) at every step. Nothing
// runs between changes. Call on the main thread.

static NSTimer *clockTimer;

// The glass view (and the view holding the page inside it) carry the
// corner radius window_material.rs gave them; set it on each.
static void roundViews(NSView *view, CGFloat radius, int depth) {
  if (!view || depth > 4)
    return;
  Class glass = NSClassFromString(@"NSGlassEffectView");
  if ((glass && [view isKindOfClass:glass]) ||
      [view isKindOfClass:NSVisualEffectView.class]) {
    if ([view respondsToSelector:@selector(setCornerRadius:)])
      [(id)view setCornerRadius:radius];
  } else if (view.layer && view.layer.masksToBounds &&
             view.layer.cornerRadius > 0) {
    view.layer.cornerRadius = radius;
  }
  for (NSView *sub in view.subviews)
    roundViews(sub, radius, depth + 1);
}

static void roundWindow(NSWindow *window) {
  NSView *root = window.contentView.superview ?: window.contentView;
  roundViews(root, MAX(1, NSHeight(window.frame) / 2), 0);
}

// A little past the target and back: the system's springy feel.
static double easeOutBack(double t) {
  const double c1 = 1.2, c3 = c1 + 1;
  return 1 + c3 * pow(t - 1, 3) + c1 * pow(t - 1, 2);
}
static double easeOut(double t) { return 1 - pow(1 - t, 3); }

// Resizes to width × height points about the window's centre over
// `seconds`, springy when `spring`; 0 seconds is at once.
void companion_clock_resize(void *ns_window, double width, double height,
                            double seconds, int spring) {
  NSWindow *window = (__bridge NSWindow *)ns_window;
  if (!window)
    return;
  [clockTimer invalidate];
  clockTimer = nil;
  NSRect from = window.frame;
  NSPoint mid = NSMakePoint(NSMidX(from), NSMidY(from));
  void (^apply)(double) = ^(double e) {
    double w = MAX(2, NSWidth(from) + (width - NSWidth(from)) * e);
    double h = MAX(2, NSHeight(from) + (height - NSHeight(from)) * e);
    [window setFrame:NSMakeRect(round(mid.x - w / 2), round(mid.y - h / 2),
                                round(w), round(h))
             display:YES];
    roundWindow(window);
  };
  if (seconds <= 0) {
    apply(1);
    return;
  }
  CFTimeInterval start = CACurrentMediaTime();
  NSTimer *timer = [NSTimer
      timerWithTimeInterval:1.0 / 60
                    repeats:YES
                      block:^(NSTimer *t) {
                        double p =
                            MIN(1, (CACurrentMediaTime() - start) / seconds);
                        apply(spring ? easeOutBack(p) : easeOut(p));
                        if (p >= 1) {
                          [t invalidate];
                          if (clockTimer == t)
                            clockTimer = nil;
                        }
                      }];
  clockTimer = timer;
  [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
}

// Stops a change under way and rounds the glass to the window as it is
// now, after the host has moved or resized it itself.
void companion_clock_settle(void *ns_window) {
  NSWindow *window = (__bridge NSWindow *)ns_window;
  [clockTimer invalidate];
  clockTimer = nil;
  if (window)
    roundWindow(window);
}

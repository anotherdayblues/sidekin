// Observe before the foreground app receives Ctrl+C, so its clipboard write
// can be distinguished from stale text. Never consume a keyboard event.
#include <windows.h>
#include <cstdint>
extern "C" void companion_copy_press(uint64_t ms, intptr_t owner, intptr_t counter);
static HHOOK hook;
static bool c_down;
static bool held(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
static LRESULT CALLBACK observe(int code, WPARAM msg, LPARAM data) {
  if (code == HC_ACTION) {
    const auto *key = reinterpret_cast<KBDLLHOOKSTRUCT *>(data);
    if (key->vkCode == 'C' && !(key->flags & LLKHF_INJECTED)) {
      if (msg == WM_KEYUP || msg == WM_SYSKEYUP) c_down = false;
      else if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
        const bool fresh = !c_down;
        c_down = true;
        if (fresh && held(VK_CONTROL) && !held(VK_SHIFT) && !held(VK_MENU) &&
            !held(VK_LWIN) && !held(VK_RWIN))
          companion_copy_press(GetTickCount64(), reinterpret_cast<intptr_t>(GetForegroundWindow()),
                               GetClipboardSequenceNumber());
      }
    }
  }
  return CallNextHookEx(hook, code, msg, data);
}
extern "C" void companion_copy_monitor(int enabled) {
  if (enabled && !hook) {
    c_down = held('C');
    hook = SetWindowsHookExW(WH_KEYBOARD_LL, observe, GetModuleHandleW(nullptr), 0);
  } else if (!enabled && hook) {
    UnhookWindowsHookEx(hook);
    hook = nullptr;
  }
}

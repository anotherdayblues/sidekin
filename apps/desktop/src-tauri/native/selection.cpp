// Windows copy strategy adapted from yetone/get-selected-text (MIT OR
// Apache-2.0, 0ddeb5d67de04660c067f8378970bc486f305032). Snapshot full OLE
// formats before Ctrl+C.
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <ole2.h>
#include <shlobj.h>
#include <string>
#include <windows.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;

static intptr_t temporary_sequence = -1;
extern "C" intptr_t companion_temporary_sequence() { return temporary_sequence; }
extern "C" intptr_t companion_target() {
  return reinterpret_cast<intptr_t>(GetForegroundWindow());
}
// Installed on the application's message-loop thread. Remember a window only,
// never its contents. Ignore foreground changes belonging to our own process.
static SRWLOCK foreground_lock = SRWLOCK_INIT;
static HWND previous_window = nullptr;
static DWORD previous_pid = 0;
static intptr_t previous_seq = 0;
static DWORD process_of(HWND window) {
  DWORD pid = 0;
  if (window) GetWindowThreadProcessId(window, &pid);
  return pid;
}
static void CALLBACK remember_foreground(HWINEVENTHOOK, DWORD, HWND window,
                                          LONG, LONG, DWORD, DWORD) {
  DWORD pid = process_of(window);
  if (!pid || pid == GetCurrentProcessId()) return;
  AcquireSRWLockExclusive(&foreground_lock);
  previous_window = window;
  previous_pid = pid;
  previous_seq++;
  ReleaseSRWLockExclusive(&foreground_lock);
}
extern "C" intptr_t companion_other_sequence() {
  AcquireSRWLockShared(&foreground_lock);
  intptr_t seq = previous_seq;
  ReleaseSRWLockShared(&foreground_lock);
  return seq;
}
extern "C" void companion_watch_apps() {
  static HWINEVENTHOOK hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND,
      EVENT_SYSTEM_FOREGROUND, nullptr, remember_foreground, 0, 0, WINEVENT_OUTOFCONTEXT);
  remember_foreground(hook, 0, GetForegroundWindow(), 0, 0, 0, 0);
}
extern "C" intptr_t companion_previous_target() {
  HWND front = GetForegroundWindow();
  if (front && process_of(front) != GetCurrentProcessId()) return reinterpret_cast<intptr_t>(front);
  AcquireSRWLockShared(&foreground_lock);
  HWND target = previous_window;
  DWORD pid = previous_pid;
  ReleaseSRWLockShared(&foreground_lock);
  // Only switch back when the user invoked selection from our foreground UI.
  if (!front || !target || !pid || process_of(target) != pid || !SetForegroundWindow(target))
    return 0;
  return reinterpret_cast<intptr_t>(target);
}
extern "C" intptr_t companion_clip_target(int allow_self) {
  HWND front=GetForegroundWindow();
  if (allow_self || (front && process_of(front)!=GetCurrentProcessId())) return reinterpret_cast<intptr_t>(front);
  AcquireSRWLockShared(&foreground_lock);
  HWND target=previous_window;
  DWORD pid=previous_pid;
  ReleaseSRWLockShared(&foreground_lock);
  return target && pid && process_of(target)==pid ? reinterpret_cast<intptr_t>(target) : 0;
}
struct Apartment {
  HRESULT hr = OleInitialize(nullptr);
  ~Apartment() {
    if (SUCCEEDED(hr))
      OleUninitialize();
  }
};
static bool snapshot(ComPtr<IDataObject> &saved) {
  if (!CountClipboardFormats())
    return true;
  ComPtr<IDataObject> source;
  if (FAILED(OleGetClipboard(&source)) ||
      FAILED(SHCreateDataObject(nullptr, 0, nullptr, nullptr,
                                IID_PPV_ARGS(&saved))))
    return false;
  ComPtr<IEnumFORMATETC> formats;
  if (FAILED(source->EnumFormatEtc(DATADIR_GET, &formats)))
    return false;
  FORMATETC f{};
  ULONG n = 0;
  HRESULT next;
  while ((next = formats->Next(1, &f, &n)) == S_OK) {
    STGMEDIUM medium{};
    HRESULT hr = source->GetData(&f, &medium);
    if (SUCCEEDED(hr)) {
      hr = saved->SetData(&f, &medium, TRUE);
      if (FAILED(hr))
        ReleaseStgMedium(&medium);
    }
    CoTaskMemFree(f.ptd);
    if (FAILED(hr))
      return false;
  }
  return next == S_FALSE;
}
extern "C" char *companion_selection(intptr_t target, int *status) {
  *status = 0;
  Apartment apartment;
  if (FAILED(apartment.hr)) {
    *status = -2;
    return nullptr;
  }
  // Wait for the initiating shortcut modifiers to be released, keeping the
  // original target.
  for (int i = 0;
       i < 150 && ((GetAsyncKeyState(VK_MENU) | GetAsyncKeyState(VK_CONTROL) |
                    GetAsyncKeyState(VK_SHIFT)) &
                   0x8000);
       i++)
    Sleep(10);
  if (companion_target() != target ||
      ((GetAsyncKeyState(VK_MENU) | GetAsyncKeyState(VK_CONTROL) |
        GetAsyncKeyState(VK_SHIFT)) &
       0x8000))
    return nullptr;
  DWORD initial = GetClipboardSequenceNumber();
  ComPtr<IDataObject> saved;
  if (!snapshot(saved) || GetClipboardSequenceNumber() != initial) {
    *status = -2;
    return nullptr;
  }
  DWORD before = GetClipboardSequenceNumber();
  INPUT events[4] = {};
  WORD keys[] = {VK_CONTROL, 'C', 'C', VK_CONTROL};
  for (int i = 0; i < 4; i++) {
    events[i].type = INPUT_KEYBOARD;
    events[i].ki.wVk = keys[i];
    events[i].ki.dwFlags = i >= 2 ? KEYEVENTF_KEYUP : 0;
  }
  if (SendInput(4, events, sizeof(INPUT)) != 4) {
    *status = -2;
    return nullptr;
  }
  for (int i = 0; i < 80 && GetClipboardSequenceNumber() == before; i++)
    Sleep(10);
  if (GetClipboardSequenceNumber() == before)
    return nullptr;
  DWORD stable = GetClipboardSequenceNumber();
  int quiet = 0;
  for (int i = 0; i < 70 && quiet < 10; i++) {
    Sleep(10);
    DWORD next = GetClipboardSequenceNumber();
    if (next == stable)
      quiet++;
    else {
      stable = next;
      quiet = 0;
    }
  }
  if (quiet < 10 || companion_target() != target) {
    *status = -2;
    return nullptr;
  }
  std::wstring wide;
  bool opened = false;
  for (int i = 0; i < 20 && !opened; i++) {
    opened = OpenClipboard(nullptr) != 0;
    if (!opened)
      Sleep(5);
  }
  if (opened) {
    HANDLE data = GetClipboardData(CF_UNICODETEXT);
    if (data) {
      auto p = static_cast<const wchar_t *>(GlobalLock(data));
      if (p) {
        wide.assign(p, wcsnlen(p, GlobalSize(data) / sizeof(wchar_t)));
        GlobalUnlock(data);
      }
    }
    stable = GetClipboardSequenceNumber();
    CloseClipboard();
  }
  DWORD copied = GetClipboardSequenceNumber();
  if (copied != stable || copied == before ||
      FAILED(OleSetClipboard(saved.Get())) ||
      (saved && FAILED(OleFlushClipboard()))) {
    *status = -2;
    return nullptr;
  }
  temporary_sequence = GetClipboardSequenceNumber();
  if (!opened) {
    *status = -2;
    return nullptr;
  }
  if (wide.empty())
    return nullptr;
  int n = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr,
                              nullptr);
  char *text = static_cast<char *>(malloc(n));
  if (!text) {
    *status = -2;
    return nullptr;
  }
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, text, n, nullptr, nullptr);
  *status = 2;
  return text;
}
extern "C" void companion_free(char *p) { free(p); }
// Double copy to translate: the sequence number changes on every copy and
// reveals nothing about the content; the text is read only after a double copy.
extern "C" intptr_t companion_clipboard_count() {
  return static_cast<intptr_t>(GetClipboardSequenceNumber());
}
extern "C" char *companion_clipboard_text() {
  if (!OpenClipboard(nullptr))
    return nullptr;
  std::wstring wide;
  if (HANDLE data = GetClipboardData(CF_UNICODETEXT)) {
    if (auto p = static_cast<const wchar_t *>(GlobalLock(data))) {
      wide.assign(p, wcsnlen(p, GlobalSize(data) / sizeof(wchar_t)));
      GlobalUnlock(data);
    }
  }
  CloseClipboard();
  if (wide.empty())
    return nullptr;
  int n = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
  char *text = static_cast<char *>(malloc(n));
  if (!text)
    return nullptr;
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, text, n, nullptr, nullptr);
  return text;
}

static int copy_text(const char *text, bool from_history) {
  int n =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, nullptr, 0);
  if (!n)
    return 0;
  HGLOBAL data = GlobalAlloc(GMEM_MOVEABLE, n * sizeof(wchar_t));
  if (!data)
    return 0;
  auto p = static_cast<wchar_t *>(GlobalLock(data));
  if (!p) {
    GlobalFree(data);
    return 0;
  }
  MultiByteToWideChar(CP_UTF8, 0, text, -1, p, n);
  GlobalUnlock(data);
  HWND w = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE,
                           nullptr, GetModuleHandleW(nullptr), nullptr);
  bool success = false;
  if (w && OpenClipboard(w)) {
    success = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, data);
    if (success && from_history) temporary_sequence = GetClipboardSequenceNumber();
    CloseClipboard();
  }
  if (w)
    DestroyWindow(w);
  if (!success)
    GlobalFree(data);
  return success;
}
static int copy_image(const uint8_t *png, size_t png_len, const uint8_t *rgba,
                      uint32_t width, uint32_t height, bool from_history) {
  if (!png || !png_len || !rgba || !width || !height)
    return 0;
  uint64_t dib_pixels = uint64_t(width) * height * 4;
  if (dib_pixels > MAXDWORD - sizeof(BITMAPINFOHEADER))
    return 0;
  static UINT png_fmt = RegisterClipboardFormatW(L"PNG");
  HGLOBAL png_mem = GlobalAlloc(GMEM_MOVEABLE, png_len);
  HGLOBAL dib_mem =
      GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(BITMAPINFOHEADER) + dib_pixels);
  if (!png_mem || !dib_mem) {
    if (png_mem)
      GlobalFree(png_mem);
    if (dib_mem)
      GlobalFree(dib_mem);
    return 0;
  }
  void *png_dst = GlobalLock(png_mem);
  auto header = static_cast<BITMAPINFOHEADER *>(GlobalLock(dib_mem));
  if (!png_dst || !header) {
    if (png_dst)
      GlobalUnlock(png_mem);
    if (header)
      GlobalUnlock(dib_mem);
    GlobalFree(png_mem);
    GlobalFree(dib_mem);
    return 0;
  }
  memcpy(png_dst, png, png_len);
  GlobalUnlock(png_mem);

  header->biSize = sizeof(*header);
  header->biWidth = width;
  header->biHeight = -static_cast<LONG>(height);
  header->biPlanes = 1;
  header->biBitCount = 32;
  header->biCompression = BI_RGB;
  header->biSizeImage = static_cast<DWORD>(dib_pixels);
  auto out = reinterpret_cast<uint8_t *>(header + 1);
  for (size_t i = 0; i < dib_pixels; i += 4) {
    out[i] = rgba[i + 2];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = rgba[i + 3];
  }
  GlobalUnlock(dib_mem);

  HWND w = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE,
                           nullptr, GetModuleHandleW(nullptr), nullptr);
  bool copied_png = false, copied_dib = false;
  if (w && OpenClipboard(w)) {
    if (EmptyClipboard()) {
      copied_png = SetClipboardData(png_fmt, png_mem) != nullptr;
      copied_dib = SetClipboardData(CF_DIB, dib_mem) != nullptr;
      if ((copied_png || copied_dib) && from_history)
        temporary_sequence = GetClipboardSequenceNumber();
    }
    CloseClipboard();
  }
  if (w)
    DestroyWindow(w);
  if (!copied_png)
    GlobalFree(png_mem);
  if (!copied_dib)
    GlobalFree(dib_mem);
  return (copied_png || copied_dib) ? 1 : 0;
}
extern "C" int companion_copy(const char *text) {
  return copy_text(text, false);
}
extern "C" int companion_history_copy(const char *text) {
  return copy_text(text, true);
}
extern "C" int companion_history_copy_image(const uint8_t *png, size_t png_len,
                                            const uint8_t *rgba, uint32_t width,
                                            uint32_t height) {
  return copy_image(png, png_len, rgba, width, height, true);
}

// 替换为译文 (plan/41): put the translation where the selection was. Bring
// the window back, paste with Ctrl+V, then put the user's clipboard back once
// the app has read it. 1 done, 0 not.
static int paste_text(intptr_t target, const char *text, bool restore) {
  HWND window = reinterpret_cast<HWND>(target);
  if (!window || !IsWindow(window))
    return 0;
  Apartment apartment;
  if (FAILED(apartment.hr))
    return 0;
  ComPtr<IDataObject> saved;
  if (restore && !snapshot(saved))
    return 0;
  if (GetForegroundWindow() != window) {
    SetForegroundWindow(window);
    for (int i = 0; i < 50 && GetForegroundWindow() != window; i++)
      Sleep(10);
    if (GetForegroundWindow() != window)
      return 0;
    Sleep(80);
  }
  if (!companion_copy(text))
    return 0;
  DWORD ours = GetClipboardSequenceNumber();
  temporary_sequence = ours;
  // A modifier still held would turn Ctrl+V into something else.
  for (int i = 0;
       i < 150 && ((GetAsyncKeyState(VK_MENU) | GetAsyncKeyState(VK_SHIFT) |
                    GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) &
                   0x8000);
       i++)
    Sleep(10);
  INPUT events[4] = {};
  WORD keys[] = {VK_CONTROL, 'V', 'V', VK_CONTROL};
  for (int i = 0; i < 4; i++) {
    events[i].type = INPUT_KEYBOARD;
    events[i].ki.wVk = keys[i];
    events[i].ki.dwFlags = i >= 2 ? KEYEVENTF_KEYUP : 0;
  }
  if (GetForegroundWindow() != window || GetClipboardSequenceNumber() != ours) return 0;
  if (SendInput(4, events, sizeof(INPUT)) != 4)
    return 0;
  if (!restore) return 1;
  Sleep(350);
  if (GetClipboardSequenceNumber() == ours) {
    if (saved) {
      if (SUCCEEDED(OleSetClipboard(saved.Get())))
        OleFlushClipboard();
    } else if (OpenClipboard(nullptr)) {
      EmptyClipboard();
      CloseClipboard();
    }
    temporary_sequence = GetClipboardSequenceNumber();
  }
  return 1;
}

extern "C" int companion_replace(intptr_t target, const char *text) {
  return paste_text(target, text, true);
}

extern "C" int companion_history_paste(intptr_t target, const char *text) {
  return paste_text(target, text, false);
}

extern "C" int companion_history_paste_image(intptr_t target,
                                             const uint8_t *png, size_t png_len,
                                             const uint8_t *rgba,
                                             uint32_t width, uint32_t height) {
  HWND window = reinterpret_cast<HWND>(target);
  if (!window || !IsWindow(window))
    return 0;
  if (GetForegroundWindow() != window) {
    SetForegroundWindow(window);
    for (int i = 0; i < 50 && GetForegroundWindow() != window; i++)
      Sleep(10);
    if (GetForegroundWindow() != window)
      return 0;
    Sleep(80);
  }
  if (!copy_image(png, png_len, rgba, width, height, true))
    return 0;
  DWORD ours = GetClipboardSequenceNumber();
  temporary_sequence = ours;
  for (int i = 0;
       i < 150 && ((GetAsyncKeyState(VK_MENU) | GetAsyncKeyState(VK_SHIFT) |
                    GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) &
                   0x8000);
       i++)
    Sleep(10);
  INPUT events[4] = {};
  WORD keys[] = {VK_CONTROL, 'V', 'V', VK_CONTROL};
  for (int i = 0; i < 4; i++) {
    events[i].type = INPUT_KEYBOARD;
    events[i].ki.wVk = keys[i];
    events[i].ki.dwFlags = i >= 2 ? KEYEVENTF_KEYUP : 0;
  }
  if (GetForegroundWindow() != window || GetClipboardSequenceNumber() != ours)
    return 0;
  return SendInput(4, events, sizeof(INPUT)) == 4 ? 1 : 0;
}

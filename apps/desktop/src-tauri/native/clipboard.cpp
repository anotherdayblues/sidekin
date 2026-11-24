#include <windows.h>

// Common Controls needs the Win32 window and message types above.
#include <commctrl.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <string>
extern "C" void clip_changed();
static LRESULT CALLBACK update(HWND w, UINT msg, WPARAM a, LPARAM b, UINT_PTR,
                               DWORD_PTR) {
  if (msg == WM_CLIPBOARDUPDATE)
    clip_changed();
  return DefSubclassProc(w, msg, a, b);
}
extern "C" int clip_listen(HWND w, int on) {
  if (!on) {
    RemoveClipboardFormatListener(w);
    RemoveWindowSubclass(w, update, 0x434c);
    return 1;
  }
  if (!SetWindowSubclass(w, update, 0x434c, 0))
    return 0;
  if (AddClipboardFormatListener(w))
    return 1;
  RemoveWindowSubclass(w, update, 0x434c);
  return 0;
}
static char *utf8(const wchar_t *s, int size) {
  int n =
      WideCharToMultiByte(CP_UTF8, 0, s, size, nullptr, 0, nullptr, nullptr);
  if (n <= 0 || n > 65536)
    return nullptr;
  char *out = static_cast<char *>(malloc(n + 1));
  if (!out)
    return nullptr;
  WideCharToMultiByte(CP_UTF8, 0, s, size, out, n, nullptr, nullptr);
  out[n] = 0;
  return out;
}
extern "C" char *clip_source(int allow_image) {
  static UINT exclude =
      RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
  static UINT allowed =
      RegisterClipboardFormatW(L"CanIncludeInClipboardHistory");
  static UINT png_fmt = RegisterClipboardFormatW(L"PNG");
  if (!OpenClipboard(nullptr))
    return nullptr;
  bool has_text = IsClipboardFormatAvailable(CF_UNICODETEXT);
  bool has_image = allow_image &&
                   (IsClipboardFormatAvailable(png_fmt) ||
                    IsClipboardFormatAvailable(CF_DIBV5) ||
                    IsClipboardFormatAvailable(CF_DIB));
  bool ok = (has_text || has_image) &&
            !IsClipboardFormatAvailable(CF_HDROP) &&
            !IsClipboardFormatAvailable(exclude);
  if (ok && IsClipboardFormatAvailable(allowed)) {
    HANDLE h = GetClipboardData(allowed);
    auto value = h && GlobalSize(h) >= sizeof(DWORD)
                     ? static_cast<DWORD *>(GlobalLock(h))
                     : nullptr;
    ok = value && *value != 0;
    if (value)
      GlobalUnlock(h);
  }
  HWND owner = GetClipboardOwner();
  if (!owner)
    owner = GetForegroundWindow();
  DWORD pid = 0;
  if (owner)
    GetWindowThreadProcessId(owner, &pid);
  CloseClipboard();
  if (!ok || !pid)
    return nullptr;
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc)
    return nullptr;
  wchar_t path[32768];
  DWORD n = 32768;
  bool got = QueryFullProcessImageNameW(proc, 0, path, &n) != 0;
  CloseHandle(proc);
  if (!got)
    return nullptr;
  std::wstring full(path, n);
  auto at = full.find_last_of(L"\\/");
  auto name = full.substr(at == std::wstring::npos ? 0 : at + 1);
  return utf8(name.c_str(), static_cast<int>(name.size()));
}
extern "C" char *clip_plain() {
  if (!OpenClipboard(nullptr))
    return nullptr;
  HANDLE data = GetClipboardData(CF_UNICODETEXT);
  char *out = nullptr;
  if (data && GlobalSize(data) <= 2 * (65536 + 1)) {
    auto p = static_cast<const wchar_t *>(GlobalLock(data));
    if (p) {
      out = utf8(
          p, static_cast<int>(wcsnlen(p, GlobalSize(data) / sizeof(wchar_t))));
      GlobalUnlock(data);
    }
  }
  CloseClipboard();
  return out;
}
extern "C" uint8_t *clip_image(size_t *out_len, int *out_format) {
  if (!out_len || !out_format)
    return nullptr;
  *out_len = 0;
  *out_format = 0;
  static UINT png_fmt = RegisterClipboardFormatW(L"PNG");
  if (!OpenClipboard(nullptr))
    return nullptr;
  UINT fmt = 0;
  int kind = 0;
  size_t limit = 0;
  if (IsClipboardFormatAvailable(png_fmt)) {
    fmt = png_fmt;
    kind = 1;
    limit = 15 * 1024 * 1024;
  } else if (IsClipboardFormatAvailable(CF_DIBV5)) {
    fmt = CF_DIBV5;
    kind = 2;
    limit = 32 * 1024 * 1024;
  } else if (IsClipboardFormatAvailable(CF_DIB)) {
    fmt = CF_DIB;
    kind = 2;
    limit = 32 * 1024 * 1024;
  }
  uint8_t *out = nullptr;
  if (fmt) {
    HANDLE h = GetClipboardData(fmt);
    size_t sz = h ? GlobalSize(h) : 0;
    if (sz > 0 && sz <= limit) {
      auto p = static_cast<const uint8_t *>(GlobalLock(h));
      if (p) {
        out = static_cast<uint8_t *>(malloc(sz));
        if (out) {
          memcpy(out, p, sz);
          *out_len = sz;
          *out_format = kind;
        }
        GlobalUnlock(h);
      }
    }
  }
  CloseClipboard();
  return out;
}

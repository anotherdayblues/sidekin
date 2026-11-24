#include <windows.h>
#include <cstdint>
#include <cstring>

extern "C" int64_t companion_idle_millis() {
  LASTINPUTINFO last = {sizeof(last), 0};
  if (!GetLastInputInfo(&last)) return -1;
  return static_cast<DWORD>(GetTickCount() - last.dwTime);
}

// CF_DIB is understood by standard Windows image editors, chat and Office.
// Screenshots are opaque. A top-down bitmap preserves their row order.
extern "C" int companion_copy_rgba(const uint8_t *pixels, uint32_t width, uint32_t height) {
  uint64_t size = uint64_t(width) * height * 4;
  if (!pixels || !width || !height || size > MAXDWORD) return 0;
  HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(BITMAPINFOHEADER) + size);
  if (!mem) return 0;
  auto header = static_cast<BITMAPINFOHEADER *>(GlobalLock(mem));
  bool copied = false;
  if (header) {
    header->biSize = sizeof(*header);
    header->biWidth = width;
    header->biHeight = -static_cast<LONG>(height);
    header->biPlanes = 1;
    header->biBitCount = 32;
    header->biCompression = BI_RGB;
    header->biSizeImage = static_cast<DWORD>(size);
    auto out = reinterpret_cast<uint8_t *>(header + 1);
    for (size_t i = 0; i < size; i += 4) {
      out[i] = pixels[i+2]; out[i+1] = pixels[i+1];
      out[i+2] = pixels[i]; out[i+3] = 255;
    }
    GlobalUnlock(mem);
    HWND owner = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (owner && OpenClipboard(owner)) {
      copied = EmptyClipboard() && SetClipboardData(CF_DIB, mem);
      CloseClipboard();
    }
    if (owner) DestroyWindow(owner);
  }
  if (!copied) GlobalFree(mem);
  return copied ? 1 : 0;
}

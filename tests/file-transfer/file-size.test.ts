import test from "node:test";
import assert from "node:assert/strict";
import { formatSize } from "../../apps/desktop/src/fileTransfer/fileSize.ts";

test("sizes read the way each system shows them", () => {
  assert.equal(formatSize(null, true), "—");
  assert.equal(formatSize(512, true), "512 字节");
  assert.equal(formatSize(2_400_000, true), "2.4 MB", "Finder counts in 1000s");
  assert.equal(
    formatSize(2_400_000, false),
    "2.3 MB",
    "Windows counts in 1024s",
  );
  assert.equal(formatSize(61_000, true), "61 KB");
  assert.equal(formatSize(1000, true), "1.0 KB");
  assert.equal(formatSize(1000, false), "1000 字节");
});

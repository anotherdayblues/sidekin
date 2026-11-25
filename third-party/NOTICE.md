# Third-Party Notices & Attributions

This document separates third-party code/assets included in this repository from design references that were implemented independently. Complete pinned versions and licenses for all npm and Rust dependencies are recorded in `package-lock.json` and `Cargo.lock`.

---

## 1. Vendored Code & Assets

The following third-party files are included directly in this repository under their respective licenses:

- **MakerCore / hatch-pet** (Apache-2.0)  
  Source: https://github.com/MakerCore/hatch-pet (`313a8c92f4847e88154d1e1f34e4ba1c124fbf3f`)  
  Vendored reference scripts and chroma-key helper in `skills/make-desktop-pet/vendor/hatch-pet/` and `skills/teach-desktop-pet/vendor/despill_chroma_edges.py`. License text preserved in `skills/make-desktop-pet/vendor/hatch-pet/LICENSE`.
- **Craybreeding / hatch-pet — Mika Sample** (MIT)  
  Source: https://github.com/Craybreeding/hatch-pet (`358880657836596bbf858cfd0909a94e019f823c`)  
  Sample pet sprite in `examples/mika/` (upstream reference in `third-party/mika-upstream.webp`), used solely as an attributed sample pack for import and animation verification. License and notice preserved in `Craybreeding-LICENSE` and `Craybreeding-NOTICE`.
- **File Transfer Utilities & Icons** (MIT / Apache-2.0)  
  Vendored helper modules and file-type SVG icons in `apps/desktop/src/fileTransfer/vendor/` (`drag-rs`, `droper`, `material-icons`), each accompanied by its original `LICENSE` file in the same directory.

---

## 2. Bundled Runtime & Major Dependencies

Key open-source components bundled in Suiby desktop builds:

| Component | Purpose | License |
| --- | --- | --- |
| [Tauri](https://github.com/tauri-apps/tauri) | Desktop shell, native windowing & global shortcuts | MIT / Apache-2.0 |
| [Bun](https://github.com/oven-sh/bun) | Local AI sidecar runtime (includes statically linked JavaScriptCore/WebKit LGPL components; see upstream `LICENSE.md`) | MIT (with LGPL components) |
| [Pi](https://github.com/earendil-works/pi) (`pi-ai`, `pi-agent-core`, `pi-mcp`) | Model streaming, tool loop & MCP client | MIT |
| [rusqlite](https://github.com/rusqlite/rusqlite) & SQLite | Local conversation & data storage | MIT / Public Domain |
| [xcap](https://github.com/nashaofu/xcap) | Cross-platform screen capture | Apache-2.0 |
| [keyring](https://docs.rs/keyring) | OS keychain / Windows Credential Manager integration | MIT / Apache-2.0 |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) & [mammoth](https://github.com/mwilliamson/mammoth.js) | Local PDF and DOCX parsing | Apache-2.0 / BSD-2-Clause |
| [Mozilla Readability](https://github.com/mozilla/readability) | Web article text extraction | Apache-2.0 |

---

## 3. Design References (Independent Implementations)

The following projects inspired specific interaction patterns or tool designs in Suiby. No code from these projects is depended upon at runtime; Suiby implements its own logic independently:

- **Hermes Agent** (MIT, see `Hermes-Agent-LICENSE`) — two-notebook memory tool design reference.
- **get-selected-text** (MIT / Apache-2.0) — reference for OS-level selected-text capture patterns.
- **Holdem** (MIT, see `apps/desktop/src/fileTransfer/vendor/holdem/LICENSE`) — reference for native file drag-out gesture handling.
- **Petex** — public documentation consulted for standard desktop pet action timing conventions.

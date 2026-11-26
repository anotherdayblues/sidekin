# Security Policy

## Supported Versions

Security fixes are released on the latest `1.x` version of Suiby.

| Version | Supported |
| --- | --- |
| Latest `1.x` | Yes |
| Older `1.x` | Please upgrade to latest |

## Security & Privacy Architecture

Suiby is designed as a **local-first, zero-telemetry** desktop utility:

- **No backend servers & zero analytics**: The desktop app makes no telemetry, update-check, or background network calls. Frontend CSP restricts IPC to local origin only (`apps/desktop/src-tauri/tauri.conf.json`).
- **OS-native credential storage**: Optional AI API keys are stored in macOS Keychain / Windows Credential Manager (`apps/desktop/src-tauri/src/credentials.rs`), never in plaintext project files.
- **Clipboard privacy**: Password managers and concealed/transient clipboard markers (e.g. 1Password, Keychain, Bitwarden) are automatically skipped (`apps/desktop/src-tauri/src/clipboard/`). Clipboard entries stay in a local SQLite database and are never sent to AI unless you explicitly trigger translation or chat.
- **Minimal OS permissions**:
  - **macOS Input Monitoring is NOT required**: Double-copy translation uses a zero-permission clipboard change detector instead of a global keylogger (`apps/desktop/src-tauri/src/clipboard/`).
  - **Accessibility** (optional): Only used to read selected text and send `⌘C` / `⌘V` for direct paste or replace-with-translation. If denied, clipboard history gracefully falls back to copying to the system clipboard.
  - **Screen Recording** (optional): Only used when you explicitly trigger region screenshot capture for AI vision.
  - **Local Network** (optional): Only used when you start the phone-to-computer LAN transfer server. The LAN server generates a 24-character random access token, auto-stops after 10 minutes of inactivity, and runs over plain local HTTP — **please use it on trusted home/office Wi-Fi only, not public Wi-Fi**.
- **Strict AI isolation**: The optional AI sidecar (`apps/brain/`) is disabled by default and only connects to the model, search, speech, or MCP endpoints you explicitly configure.

## Verifying Official Release Builds

Starting after `v1.2.1`, **both** `Suiby-Mac-arm64.dmg` and `Suiby-Windows-x64.exe` are built publicly from source by GitHub Actions (`.github/workflows/release.yml`) with **SHA-256 checksums** (`SHA256SUMS.txt`) and **GitHub Build Provenance Attestations** (`actions/attest-build-provenance`).

You can verify any downloaded installer matches the exact public source commit:

```bash
# 1. Verify SHA-256 checksum
shasum -a 256 -c SHA256SUMS.txt

# 2. Verify GitHub Actions build provenance attestation (requires GitHub CLI)
gh attestation verify Suiby-Mac-arm64.dmg --repo anotherdayblues/suiby
gh attestation verify Suiby-Windows-x64.exe --repo anotherdayblues/suiby
```

## Reporting a Vulnerability

If you discover a security vulnerability in Suiby, please report it privately via **GitHub Security Advisories** ("Report a vulnerability" on the Security tab of `anotherdayblues/suiby`) so we can investigate and patch it before public disclosure.

Please include:
- A clear description of the issue and affected component/file
- Reproduction steps or proof of concept
- Affected OS and Suiby version

We aim to acknowledge reports within 48 hours and publish fixes promptly.

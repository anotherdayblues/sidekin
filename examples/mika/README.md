# Mika reference pet

Mika is the first full reference implementation produced by Hatch Pet.

- species: calico cat
- persona: quiet, lazy, observant; alert while working
- v2 atlas: `1536×2288`
- idle cadence: one slow blink in a measured 6.6-second Codex loop
- work state: both front paws maintain physical keyboard contact with a silver MacBook Air; the user-required Apple mark remains visible and the final sprite has no colored rim/halo
- package SHA-256: `581ea466e51267e8653b25beb2ce0183b94f047d2d1c33bf0853b9fee6ad00bb`

Install into an isolated test home:

```bash
PYTHON=/absolute/path/to/python-with-Pillow \
  ./install.sh --codex-home "$(mktemp -d)"
```

Inside Codex, use the exact Python returned by `load_workspace_dependencies`.

Original reference photos are not distributed with the example.

The generated example package and preview assets are distributed under the repository's MIT License.

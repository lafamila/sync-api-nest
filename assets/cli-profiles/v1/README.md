# Public CLI Profile Release

Only these release artifacts are served at `/api/cli-profiles/v1/`:

- `manifest.json`: exact signed UTF8 bytes, at most65536 bytes.
- `manifest.sig`: raw64-byte Ed25519 signature over `manifest.json`.
- `claude-native-v1.json` and `codex-native-v1.json`: public data-only profiles,
  each at most65536 bytes, with digest/byte count bound by the signed manifest.

The Mac profile lane/main integration supplies the public signed baseline.
Until `manifest.sig` is installed, the endpoint returns503, never an unsigned
baseline or an invented signature. Files are served byte-for-byte without auth,
cookies, decompression, fetching, signing or interpretation. Native clients
verify pinned trust roots, signatures, SHA256, floor/revocations and expiry
before parsing/activation. Missing or modified artifacts fail closed there.

No private key, trust-root replacement, transcript, message, credential, dynamic
path, executable or unsigned development fixture belongs in this directory.
The release-only private signer stays in the development Mac Keychain. Bundle
public assets atomically before deployment; deployment remains user-controlled.

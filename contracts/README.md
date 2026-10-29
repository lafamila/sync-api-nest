# Sync Wire Contract

`sync-contract.json` is the canonical JSON Schema catalog and protocol/capability/
limit/proof-prefix source. `fixtures.json` contains public, synthetic test vectors.
`outputs.json` lists the only files the generator owns. All five consumers receive
the same schema SHA-256 and byte-identical `sync-golden.json`.

From `sync-api-nest`:

```sh
node scripts/generate-contracts.mjs
node scripts/generate-contracts.mjs --check
node scripts/generate-contracts.mjs --repo sync-app-swift --check
node --test scripts/generate-contracts.test.mjs
```

Repo targets: `sync-api-nest` (API plus canonical golden), `web`,
`sync-app-swift`, `sync-app-android`, `sync-app-windows`. Without `--repo`, missing
outputs in any client fail `--check`. No output timestamps or absolute paths are
generated. The hash uses recursively key-sorted JSON, not source whitespace.

## Supported Schema

The generator implements objects, arrays, strings, finite numbers, safe integers,
booleans, local `$defs`/`$ref`, `enum`, `const`, discriminated `oneOf`, defaults,
bounds, unique scalar arrays, `required`, boolean `additionalProperties`, anchored
portable regex patterns, UUID and ISO date-time formats. Extensions `x-nullable`
and `x-maxUtf8Bytes` express explicit JSON null and UTF-8 byte limits. Unknown
keywords, formats and references fail; do not silently add an unsupported schema
construct. Wire DTOs are named `Wire*`; ISO dates stay strings.

Generated DTO constructors are transport values, not authorization checks. Use the
generated validating decode boundary when receiving untrusted messages:

- TypeScript: `validateWire(model, value)` / `decodeWire<T>(model, value)`.
- Swift: `SyncContract.validate(model:json:)` / `decode(T.self, from: data)`.
- Kotlin: `SyncContract.validate(model, json)` / `Wire*.fromJson(JSONObject)`.
- C#: `SyncContract.Validate(model, json)` / `Deserialize<T>(json)`.

Swift structs use Foundation Codable; Kotlin uses Android's built-in `org.json`;
C# records use System.Text.Json. No new runtime crypto or npm dependency is added.
Hand-written date/domain adapters may consume DTOs, but guards must consume the
generated domains or compare their enums against the common fixtures/catalog.

Absent optional response metadata decodes to protocol 1 / empty capabilities;
absent feature flags are false. Public config is flat, includes the original
product/version/authConfigured/webUrl fields, and uses optional `modeDuration`.
`defaultModeSeconds=43200` preserves the original 12-hour policy. Absolute mode
bounds are not the server-configured picker range; always use server modeDuration.
Legacy requests must omit new fields until config explicitly declares support.

The runtime must still enforce authenticated routes/direction, active negotiated
capabilities, one-use proof/recovery authority, session/mode ownership, browser
deadlines and the inputEpoch/heartbeat barrier. Structural validity alone does
not authorize input or revive expired access. `directionCases`, `inputEpochCases`
and `unicodeEdits` are shared runtime vectors, not claims that a DTO enforces those
state machines.

Proof fixtures intentionally use the publicly known insecure P-256 scalar `d=1`
and fixed `k=1`. SPKI public key and ASN.1 DER signatures are deterministic test
vectors only. No real credential/private key is included. Generated proof builders
only canonicalize existing UTF-8 strings; OS-backed signing remains platform-owned.

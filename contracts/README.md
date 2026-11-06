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
absent feature flags are false/unsupported (`cliChat` remains optional, not
defaulted to a supported declaration). Public config is flat, includes the original
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

## Trusted Access Code

The eighth capability is `access-code`, not CLI chat. The separate
`WireAccessCodeFrame` strict request/result/error variants, data-only authority,
2048-byte limit and10-second request timeout are documented in
[Trusted Access Code](../docs/access-code.md). All generated languages use the
same model name and schema hash. Code frames remain peer-only; the browser
consumer receives generated validation code but no lookup UI or authorization.
HTTP catalog/list responses are compatibility-projected: only the exact
`X-Sync-Extensions: access-code` request opts into the new capability/code-session
rows. No header retains the genuine old enum7/maxItems7/purpose2 response domain.
The header is not permission and does not alter explicit ticket/connect
declarations or base protocol2. Schema/hash and generated outputs are unchanged
by this projection; all new native requests, including config probes, opt in.

## CLI Chat1

`cliChatProtocolVersion:1` is independent of base2/CLI1 and is not a
capability. `WireDevice` reflects only the currently live ticket declaration;
`WireRemoteSession` preserves the negotiated immutable snapshot. Old responses
omit this version and `features.cliChat`; old API requests must omit the new
version until both CLI feature flags and base2 support are explicitly present.

`WireCliChatFrame` and `WireCliChatMessage` are the exact generated names in all
languages. Strict variants cover `history`, `tail`, `unsubscribe`, `content`,
their results, `chunk` and `error`. Page results contain at most20 chronologically
ordered visible user/assistant messages. Stable IDs/revisions and segmented text
preserve source identity, not guessed draft/reply reconciliation. Results carry
independent older/tail cursors, snapshot/reset, resumable scan progress and optional
`warning: oversized-record | malformed-record` without inventing a visible role.
Content results contain at most one segment, or no message on warning/reset/
progress. `hasMore`/`progress` require a continuation cursor. Unsupported roles,
extra fields, null optionals and cross-op fields fail strict decode.

Each text/chunk is at most8KiB UTF8. Serialized frames remain32KiB; escaping can
make a structurally valid logical result too large for a frame. Transports MUST
measure the original serialized bytes before parse, chunk oversized results,
strictly validate assembled results, and recheck authorization/identity before
publication. Structural validation does not enforce chunk index/count correlation,
timeout, cumulative memory, message identity, cursor authority or frame-byte limits.
Runtime budgets are128 chunks/1MiB per assembly,4MiB concurrent,10 seconds,
4 pending requests and64KiB channel buffer, with heartbeat/release priority.
Visible cache ceilings are400 messages/2MiB text; older content stays retrievable.
Tail is visible-only polling at no faster than1 second, not a new subscription.

`fixtures.json` includes public synthetic request/result/warning/segment/chunk and
old-consumer rejection vectors. Contract tests compile and execute all fixtures
through TS, Swift, Kotlin and C#, including round-trip omission of chat optionals.
Public signed profile assets have a separate native-owned data schema and are not
wire messages. See [CLI sessions](../docs/cli-sessions.md) for API rollout/security.

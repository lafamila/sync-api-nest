import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const keywords = new Set(['$schema', '$id', 'title', 'description', 'x-sync', '$defs', '$ref', 'type', 'properties', 'required', 'additionalProperties', 'items', 'oneOf', 'enum', 'const', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'format', 'pattern', 'x-nullable', 'x-maxUtf8Bytes']);
const owned = new Map([
  ['sync-api-nest/src/generated/sync-wire.ts', ['sync-api-nest', 'typescript']],
  ['sync-api-nest/web/src/generated/sync-wire.ts', ['web', 'typescript']],
  ['sync-app-swift/Sources/SyncCore/Generated/SyncWire.swift', ['sync-app-swift', 'swift']],
  ['sync-app-android/app/src/main/java/xyz/lafamila/sync/android/protocol/generated/SyncWire.kt', ['sync-app-android', 'kotlin']],
  ['sync-app-windows/src/Sync.Contracts/Generated/SyncWire.g.cs', ['sync-app-windows', 'csharp']],
  ['sync-api-nest/contracts/sync-golden.json', ['sync-api-nest', 'fixtures']],
  ['sync-api-nest/web/tests/fixtures/sync-golden.json', ['web', 'fixtures']],
  ['sync-app-swift/Tests/SyncCoreTests/Fixtures/sync-golden.json', ['sync-app-swift', 'fixtures']],
  ['sync-app-android/app/src/test/resources/sync-golden.json', ['sync-app-android', 'fixtures']],
  ['sync-app-windows/tests/Sync.Contracts.Tests/Fixtures/sync-golden.json', ['sync-app-windows', 'fixtures']],
]);

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function checkSchema(contract) {
  const visit = (schema, path) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`Expected schema object at ${path}`);
    for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported schema keyword ${path}/${key}`);
    if (schema.type && !['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(schema.type)) throw new Error(`Unsupported schema type at ${path}`);
    if (schema.format && !['uuid', 'date-time'].includes(schema.format)) throw new Error(`Unsupported format at ${path}`);
    for (const key of ['minimum','maximum','minLength','maxLength','minItems','maxItems','x-maxUtf8Bytes']) {
      if (Object.hasOwn(schema,key) && (!Number.isFinite(schema[key]) || (key !== 'minimum' && key !== 'maximum' && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)))) throw new Error(`Invalid numeric schema keyword ${path}/${key}`);
    }
    for (const key of ['uniqueItems','x-nullable']) if (Object.hasOwn(schema,key) && typeof schema[key] !== 'boolean') throw new Error(`Invalid boolean schema keyword ${path}/${key}`);
    if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key=>typeof key !== 'string'))) throw new Error(`Invalid required at ${path}`);
    if (schema.enum && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some(value=>typeof value !== 'string'))) throw new Error(`Unsupported non-string/empty enum at ${path}`);
    if (schema.$ref && (!/^#\/\$defs\/[A-Za-z][A-Za-z0-9]*$/.test(schema.$ref) || !contract.$defs[schema.$ref.split('/').at(-1)])) throw new Error(`Unknown reference at ${path}`);
    if (schema.pattern) new RegExp(schema.pattern, 'u');
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new Error(`Unsupported additionalProperties at ${path}`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) visit(child, `${path}/properties/${key}`);
    for (const [key, child] of Object.entries(schema.$defs ?? {})) visit(child, `${path}/$defs/${key}`);
    if (schema.items) visit(schema.items, `${path}/items`);
    for (const [index, child] of (schema.oneOf ?? []).entries()) visit(child, `${path}/oneOf/${index}`);
  };
  visit(contract, '#');
  const complete = new Set();
  const inspectReferences = (schema, active) => {
    if (schema.$ref) {
      const name = schema.$ref.split('/').at(-1);
      if (active.has(name)) throw new Error(`Unsupported recursive schema reference ${name}`);
      if (!complete.has(name)) { inspectReferences(contract.$defs[name],new Set([...active,name])); complete.add(name); }
    }
    for (const child of Object.values(schema.properties ?? {})) inspectReferences(child,active);
    if (schema.items) inspectReferences(schema.items,active);
    for (const child of schema.oneOf ?? []) inspectReferences(child,active);
  };
  for (const [name,schema] of Object.entries(contract.$defs)) {
    inspectReferences(schema,new Set([name]));
    if (name.startsWith('Wire') && !(schema.type === 'object' && schema.properties) && !(schema.type === 'string' && schema.enum)) throw new Error(`Unsupported Wire DTO shape ${name}`);
    if (Object.hasOwn(schema,'default') && !validateValue(contract,name,schema.default)) throw new Error(`Invalid default for ${name}`);
  }
  if (canonicalJSON(contract['x-sync'].nativePlatforms) !== canonicalJSON(contract.$defs.NativePlatform.enum)
    || canonicalJSON(contract['x-sync'].sessionPlatforms) !== canonicalJSON(contract.$defs.SessionPlatform.enum)
    || canonicalJSON(contract['x-sync'].capabilities) !== canonicalJSON(contract.$defs.Capability.enum)) throw new Error('Catalog/schema enum drift');
  const bounds = contract['x-sync'].limits;
  const mirrored = [
    ['maxDisplays',contract.$defs.WireSignal.properties.displays.maxItems],
    ['maxDisplayIdLength',contract.$defs.DisplayId.maxLength],
    ['maxDisplayNameLength',contract.$defs.WireDisplay.properties.name.maxLength],
    ['maxDisplayDimension',contract.$defs.WireDisplay.properties.width.maximum],
    ['maxDisplayDimension',contract.$defs.WireDisplay.properties.height.maximum],
    ['maxTextUtf8Bytes',contract.$defs.WireInput.properties.text['x-maxUtf8Bytes']],
    ['maxScrollDelta',contract.$defs.WireInput.properties.dx.maximum],
    ['maxScrollDelta',contract.$defs.WireInput.properties.dy.maximum],
    ['maxSequence',contract.$defs.WireInput.properties.seq.maximum],
    ['maxSdpLength',contract.$defs.WireSignal.properties.sdp.maxLength],
    ['maxIceCandidateLength',contract.$defs.WireSignalCandidate.properties.candidate.maxLength],
    ['maxCapabilities',contract.$defs.Capabilities.maxItems],
    ['maxClientVersionLength',contract.$defs.WireDevice.properties.clientVersion.maxLength],
    ['cliProtocolVersion',contract.$defs.CliProtocolVersion.const],
    ['maxCliTextUtf8Bytes',contract.$defs.WireCliFrame.properties.text['x-maxUtf8Bytes']],
    ['maxCliSessions',contract.$defs.WireCliFrame.properties.sessions.maxItems],
    ['maxCliNameLength',contract.$defs.WireCliSession.properties.name.maxLength],
    ['maxCliProjectLength',contract.$defs.WireCliSession.properties.project.maxLength],
    ['maxCliCursorLength',contract.$defs.WireCliFrame.properties.cursor.maxLength],
    ['maxCliCursorLength',contract.$defs.WireCliFrame.properties.nextCursor.maxLength],
    ['maxSequence',contract.$defs.WireCliFrame.properties.submitSequence.maximum],
    ['maxSequence',contract.$defs.WireCliReceipt.properties.submitSequence.maximum],
    ['cliChatProtocolVersion',contract.$defs.CliChatProtocolVersion.const],
    ['maxCliChatMessages',contract.$defs.WireCliChatFrame.properties.messages.maxItems],
    ['maxCliChatCursorLength',contract.$defs.WireCliChatFrame.properties.cursor.maxLength],
    ['maxCliChatCursorLength',contract.$defs.WireCliChatMessage.properties.contentCursor.maxLength],
    ['maxCliChatMessageIdLength',contract.$defs.WireCliChatMessage.properties.id.maxLength],
    ['maxCliChatRevisionLength',contract.$defs.WireCliChatMessage.properties.revision.maxLength],
    ['maxCliChatChunkUtf8Bytes',contract.$defs.WireCliChatMessage.properties.text['x-maxUtf8Bytes']],
    ['maxCliChatChunkUtf8Bytes',contract.$defs.WireCliChatFrame.properties.payload['x-maxUtf8Bytes']],
    ['maxCliChatChunks',contract.$defs.WireCliChatFrame.properties.chunkCount.maximum],
  ];
  if (mirrored.some(([name,value])=>bounds[name] !== value)) throw new Error('Catalog/schema bound drift');
}

const unwrap = (schema, defs) => schema.$ref ? { ...unwrap(defs[schema.$ref.split('/').at(-1)], defs), ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref')) } : schema;

export function validateValue(contract, model, value) {
  const walk = (schema, data) => {
    if (data === null) return schema['x-nullable'] === true;
    schema = unwrap(schema, contract.$defs);
    if (schema.const !== undefined && data !== schema.const) return false;
    if (schema.enum && !schema.enum.includes(data)) return false;
    if (schema.oneOf && schema.oneOf.filter(branch => walk(branch, data)).length !== 1) return false;
    switch (schema.type) {
      case 'object':
        if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
        if ((schema.required ?? []).some(key => !Object.hasOwn(data, key))) return false;
        if (schema.additionalProperties === false && Object.keys(data).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
        break;
      case 'array':
        if (!Array.isArray(data) || data.length < (schema.minItems ?? 0) || data.length > (schema.maxItems ?? Infinity)) return false;
        if (schema.uniqueItems && new Set(data.map(canonicalJSON)).size !== data.length) return false;
        if (data.some(item => !walk(schema.items, item))) return false;
        break;
      case 'string':
        if (typeof data !== 'string' || [...data].length < (schema.minLength ?? 0) || [...data].length > (schema.maxLength ?? Infinity)) return false;
        if (schema.pattern && !new RegExp(schema.pattern, 'u').test(data)) return false;
        if (schema['x-maxUtf8Bytes'] && Buffer.byteLength(data, 'utf8') > schema['x-maxUtf8Bytes']) return false;
        if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data)) return false;
        if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data) || !Number.isFinite(Date.parse(data)))) return false;
        break;
      case 'integer': if (!Number.isSafeInteger(data)) return false; // falls through to finite/bounds
      case 'number': if (typeof data !== 'number' || !Number.isFinite(data) || data < (schema.minimum ?? -Infinity) || data > (schema.maximum ?? Infinity)) return false; break;
      case 'boolean': if (typeof data !== 'boolean') return false; break;
    }
    if (schema.properties && (!data || typeof data !== 'object' || Object.entries(schema.properties).some(([key, child]) => Object.hasOwn(data, key) && !walk(child, data[key])))) return false;
    if (schema.properties && schema.additionalProperties === false && Object.keys(data).some(key => !Object.hasOwn(schema.properties,key))) return false;
    if (schema.required?.some(key => !Object.hasOwn(data, key))) return false;
    return true;
  };
  return !!contract.$defs[model] && walk(contract.$defs[model], value);
}

function defaultsFor(schema, defs) {
  schema = unwrap(schema, defs);
  if (Object.hasOwn(schema, 'default')) return schema.default;
  return undefined;
}

const upper = value => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const pascal = value => value[0].toUpperCase() + value.slice(1);
const json = value => JSON.stringify(value);

function typeOf(schema, defs, language) {
  const name = schema.$ref?.split('/').at(-1);
  if (name?.startsWith('Wire') && (language === 'typescript' || defs[name].type === 'object')) return name;
  schema = unwrap(schema, defs);
  if (language === 'typescript' && Object.hasOwn(schema,'const')) return json(schema.const);
  if (schema.type === 'array') {
    const item = typeOf(schema.items, defs, language);
    return language === 'swift' ? `[${item}]` : language === 'kotlin' ? `List<${item}>` : language === 'csharp' ? `IReadOnlyList<${item}>` : `(${item})[]`;
  }
  if (language === 'typescript' && schema.enum) return schema.enum.map(json).join(' | ');
  return ({ swift: { string:'String', integer:'Int', number:'Double', boolean:'Bool' }, kotlin: { string:'String', integer:'Long', number:'Double', boolean:'Boolean' }, csharp: { string:'string', integer:'long', number:'double', boolean:'bool' }, typescript: { string:'string', integer:'number', number:'number', boolean:'boolean' } })[language][schema.type];
}

function fields(model, defs, language) {
  return Object.entries(model.properties).map(([name, schema]) => {
    const fallback = defaultsFor(schema, defs);
    const optional = !model.required?.includes(name);
    const nullable = schema['x-nullable'] || (optional && fallback === undefined);
    const type = typeOf(schema, defs, language);
    if (!type) throw new Error(`Cannot generate property ${name}`);
    return { name, schema, optional, nullable, fallback, type };
  });
}

function literal(value, type, language) {
  if (Array.isArray(value)) return language === 'swift' ? '[]' : language === 'kotlin' ? 'emptyList()' : 'Array.Empty<string>()';
  if (value && typeof value === 'object') return language === 'swift' ? `${type}()` : language === 'kotlin' ? `${type}()` : `new ${type}()`;
  return json(value);
}

function tsSource(contract, hash) {
  const meta = contract['x-sync'];
  const models = Object.entries(contract.$defs).filter(([name]) => name.startsWith('Wire')).map(([name, model]) => {
    if (model.type !== 'object') return `export type ${name} = ${typeOf(model,contract.$defs,'typescript')};`;
    const entries = fields(model, contract.$defs, 'typescript');
    return `export interface ${name} {\n${entries.map(field => `  ${field.name}${field.optional ? '?' : ''}: ${field.type}${field.schema['x-nullable'] ? ' | null' : ''};`).join('\n')}\n}`;
  }).join('\n\n');
  return `// Generated by scripts/generate-contracts.mjs. Do not edit.\nexport const SYNC_SCHEMA_HASH = ${json(hash)};\nexport const SYNC_PROTOCOL_VERSION = ${meta.protocolVersion};\nexport const SYNC_MINIMUM_PROTOCOL_VERSION = ${meta.minimumProtocolVersion};\nexport const SYNC_MINIMUM_WEB_PROTOCOL_VERSION = ${meta.minimumWebProtocolVersion};\nexport const NATIVE_PLATFORMS = ${json(meta.nativePlatforms)} as const;\nexport const SESSION_PLATFORMS = ${json(meta.sessionPlatforms)} as const;\nexport const SYNC_CAPABILITIES = ${json(meta.capabilities)} as const;\nexport const SYNC_LIMITS = ${json(meta.limits)} as const;\nexport const SYNC_SIGNAL_DIRECTIONS = ${json(meta.directions)} as const;\nexport const SYNC_KEYS = ${json(contract.$defs.Key.enum)} as const;\nexport const SYNC_MODIFIERS = ${json(contract.$defs.Modifier.enum)} as const;\nexport const SYNC_MOUSE_BUTTONS = ${json(contract.$defs.MouseButton.enum)} as const;\nexport type NativePlatform = typeof NATIVE_PLATFORMS[number];\nexport type SessionPlatform = typeof SESSION_PLATFORMS[number];\nexport type SyncCapability = typeof SYNC_CAPABILITIES[number];\n\n${models}\n\nexport const SYNC_WIRE_SCHEMA = ${JSON.stringify(contract.$defs)} as const;\n${tsRuntime(contract)}\n`;
}

function tsRuntime(contract) {
  // The TS interpreter is emitted without Node APIs so the same output works in a browser.
  return `type Schema = { [key: string]: unknown };\nfunction resolveSchema(source: Schema): Schema {\n  if (!source.$ref) return source;\n  const { $ref, ...rest } = source;\n  return { ...resolveSchema((SYNC_WIRE_SCHEMA as unknown as Record<string, Schema>)[String($ref).split('/').pop()!]!), ...rest };\n}\nexport function validateWire(model: keyof typeof SYNC_WIRE_SCHEMA, value: unknown): boolean {\n  function walk(raw: Schema, data: unknown): boolean {\n    const s = resolveSchema(raw);\n    if (data === null) return s['x-nullable'] === true;\n    if ('const' in s && data !== s.const) return false;\n    if (s.enum && !(s.enum as unknown[]).includes(data)) return false;\n    if (s.oneOf && (s.oneOf as Schema[]).filter(b => walk(b, data)).length !== 1) return false;\n    const object = data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;\n    if (s.type === 'object' && !object) return false;\n    if (s.properties || s.required) {\n      if (!object) return false;\n      const props = (s.properties ?? {}) as Record<string, Schema>;\n      if ((s.required as string[] | undefined)?.some(k => !Object.prototype.hasOwnProperty.call(object, k))) return false;\n      if (s.additionalProperties === false && Object.keys(object).some(k => !Object.prototype.hasOwnProperty.call(props,k))) return false;\n      if (Object.entries(props).some(([k,v]) => Object.prototype.hasOwnProperty.call(object,k) && !walk(v,object[k]))) return false;\n    }\n    if (s.type === 'string') {\n      if (typeof data !== 'string' || [...data].length < Number(s.minLength ?? 0) || [...data].length > Number(s.maxLength ?? Infinity)) return false;\n      if (s.pattern && !new RegExp(String(s.pattern), 'u').test(data)) return false;\n      if (s['x-maxUtf8Bytes'] && new TextEncoder().encode(data).length > Number(s['x-maxUtf8Bytes'])) return false;\n      if (s.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data)) return false;\n      if (s.format === 'date-time' && (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$/.test(data) || !Number.isFinite(Date.parse(data)))) return false;\n    }\n    if (s.type === 'number' || s.type === 'integer') {\n      if (typeof data !== 'number' || !Number.isFinite(data) || (s.type === 'integer' && !Number.isSafeInteger(data)) || data < Number(s.minimum ?? -Infinity) || data > Number(s.maximum ?? Infinity)) return false;\n    }\n    if (s.type === 'boolean' && typeof data !== 'boolean') return false;\n    if (s.type === 'array') {\n      if (!Array.isArray(data) || data.length < Number(s.minItems ?? 0) || data.length > Number(s.maxItems ?? Infinity)) return false;\n      if (s.uniqueItems && new Set(data.map(v => JSON.stringify(v))).size !== data.length) return false;\n      if (data.some(v => !walk(s.items as Schema,v))) return false;\n    }\n    return true;\n  }\n  const schema = (SYNC_WIRE_SCHEMA as unknown as Record<string, Schema>)[model];\n  return !!schema && walk(schema, value);\n}\nexport function decodeWire<T>(model: keyof typeof SYNC_WIRE_SCHEMA, value: unknown): T {\n  if (!validateWire(model,value)) throw new Error('Invalid ' + model);\n  function fill(raw: Schema, v: unknown): unknown {\n    const s = resolveSchema(raw);\n    if (v === null) return null;\n    if (s.type === 'array') return (v as unknown[]).map(item => fill(s.items as Schema,item));\n    if (s.type !== 'object') return v;\n    const result = { ...(v as Record<string,unknown>) };\n    for (const [key, child] of Object.entries((s.properties ?? {}) as Record<string,Schema>)) {\n      const resolved = resolveSchema(child);\n      if (!Object.prototype.hasOwnProperty.call(result,key) && 'default' in resolved) result[key] = structuredClone(resolved.default);\n      if (Object.prototype.hasOwnProperty.call(result,key)) result[key] = fill(child,result[key]);\n    }\n    return result;\n  }\n  return fill((SYNC_WIRE_SCHEMA as unknown as Record<string,Schema>)[model]!,value) as T;\n}\nfunction proof(prefix: string, parts: string[]): string {\n  if (parts.some(v => !v || /[:\\r\\n\\v\\f\\u0085\\u2028\\u2029]/u.test(v))) throw new Error('Invalid proof component');\n  return [prefix,...parts].join(':');\n}\nexport const registrationProof = (challengeId: string, nonce: string): string => proof(${json(contract['x-sync'].proofs.registration)},[challengeId,nonce]);\nexport const deviceProof = (deviceId: string, challengeId: string, nonce: string): string => proof(${json(contract['x-sync'].proofs.device)},[deviceId,challengeId,nonce]);`;
}

function swiftSource(contract, hash) {
  const meta = contract['x-sync'];
  const models = Object.entries(contract.$defs).filter(([name]) => name.startsWith('Wire')).map(([name, model]) => {
    if (model.type !== 'object') return `public typealias ${name} = ${typeOf(model,contract.$defs,'swift')}`;
    const fs = fields(model, contract.$defs, 'swift');
    const declaration = fs.map(f => `    public let ${f.name}: ${f.type}${f.nullable ? '?' : ''}`).join('\n');
    const params = fs.map(f => `${f.name}: ${f.type}${f.nullable ? '?' : ''}${f.fallback !== undefined ? ` = ${literal(f.fallback,f.type,'swift')}` : f.nullable ? ' = nil' : ''}`).join(', ');
    const assignments = fs.map(f => `        self.${f.name} = ${f.name}`).join('\n');
    const decode = fs.map(f => `        ${f.name} = try c.${f.nullable || f.fallback !== undefined ? 'decodeIfPresent' : 'decode'}(${f.type}.self, forKey: .${f.name})${f.fallback !== undefined ? ` ?? ${literal(f.fallback,f.type,'swift')}` : ''}`).join('\n');
    return `public struct ${name}: Codable, Equatable, Sendable${['WireDevice','WireRemoteSession','WireDisplay'].includes(name) ? ', Identifiable' : ''} {\n${declaration}\n\n    public init(${params}) {\n${assignments}\n    }\n\n    private enum CodingKeys: String, CodingKey { case ${fs.map(f=>f.name).join(', ')} }\n    public init(from decoder: Decoder) throws {\n        let c = try decoder.container(keyedBy: CodingKeys.self)\n${decode}\n    }\n}`;
  }).join('\n\n');
  return `// Generated by scripts/generate-contracts.mjs. Do not edit.\nimport Foundation\nimport CoreFoundation\n\npublic enum SyncContract {\n    public static let schemaHash = ${json(hash)}\n    public static let protocolVersion = ${meta.protocolVersion}\n    public static let minimumProtocolVersion = ${meta.minimumProtocolVersion}\n    public static let minimumWebProtocolVersion = ${meta.minimumWebProtocolVersion}\n    public static let nativePlatforms = ${json(meta.nativePlatforms)}\n    public static let sessionPlatforms = ${json(meta.sessionPlatforms)}\n    public static let capabilities = ${json(meta.capabilities)}\n    public static let keys = ${json(contract.$defs.Key.enum)}\n    public static let modifiers = ${json(contract.$defs.Modifier.enum)}\n    public static let mouseButtons = ${json(contract.$defs.MouseButton.enum)}\n    public static let limits: [String: Int] = [${Object.entries(meta.limits).map(([k,v])=>`${json(k)}: ${v}`).join(', ')}]\n    public static let signalDirections: [String: String] = [${Object.entries(meta.directions).map(([k,v])=>`${json(k)}: ${json(v)}`).join(', ')}]\n    public static func registrationProof(challengeID: String, nonce: String) throws -> String { try proof(${json(meta.proofs.registration)}, [challengeID,nonce]) }\n    public static func deviceProof(deviceID: String, challengeID: String, nonce: String) throws -> String { try proof(${json(meta.proofs.device)}, [deviceID,challengeID,nonce]) }\n    private static func proof(_ prefix: String, _ parts: [String]) throws -> String {\n        guard parts.allSatisfy({ !$0.isEmpty && !$0.contains(":") && !$0.contains(where: \\.isNewline) }) else { throw WireContractError.invalidProof }\n        return ([prefix] + parts).joined(separator: ":")\n    }\n${swiftRuntime()}\n    private static let schemas: [String: Any] = {\n        let data = #\"\"\"\n${JSON.stringify(contract.$defs)}\n\"\"\"#.data(using: .utf8)!\n        return (try! JSONSerialization.jsonObject(with: data)) as! [String: Any]\n    }()\n}\n\npublic enum WireContractError: Error { case invalidProof, invalidModel(String) }\n\n${models}\n`;
}

function swiftRuntime() {
  return `    public static func validate(model: String, json: Data) -> Bool {\n        guard let schema = schemas[model] as? [String: Any], let value = try? JSONSerialization.jsonObject(with: json, options: [.fragmentsAllowed]) else { return false }\n        return matches(schema, value)\n    }\n    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {\n        let model = String(describing: type)\n        guard validate(model: model, json: data) else { throw WireContractError.invalidModel(model) }\n        return try JSONDecoder().decode(type, from: data)\n    }\n    private static func matches(_ raw: [String: Any], _ value: Any) -> Bool {\n        var s = raw\n        if let ref = s.removeValue(forKey: "$ref") as? String, let base = schemas[String(ref.split(separator: "/").last!)] as? [String: Any] {\n            s = base.merging(s, uniquingKeysWith: { _, new in new })\n        }\n        if value is NSNull { return s["x-nullable"] as? Bool == true }\n        func equal(_ a: Any, _ b: Any) -> Bool {\n            guard let a = a as? NSObject, let b = b as? NSObject else { return false }\n            if let x = a as? NSNumber, let y = b as? NSNumber, (CFGetTypeID(x) == CFBooleanGetTypeID()) != (CFGetTypeID(y) == CFBooleanGetTypeID()) { return false }\n            return a.isEqual(b)\n        }\n        if let c = s["const"], !equal(c,value) { return false }\n        if let values = s["enum"] as? [Any], !values.contains(where: { equal($0,value) }) { return false }\n        if let branches = s["oneOf"] as? [[String:Any]], branches.filter({ matches($0,value) }).count != 1 { return false }\n        if s["type"] as? String == "object", !(value is [String:Any]) { return false }\n        if s["properties"] != nil || s["required"] != nil {\n            guard let object = value as? [String:Any] else { return false }\n            let props = s["properties"] as? [String:[String:Any]] ?? [:]\n            if (s["required"] as? [String] ?? []).contains(where: { object[$0] == nil }) { return false }\n            if s["additionalProperties"] as? Bool == false, object.keys.contains(where: { props[$0] == nil }) { return false }\n            for (key,child) in props { if let v = object[key], !matches(child,v) { return false } }\n        }\n        switch s["type"] as? String {\n        case "string":\n            guard let text = value as? String else { return false }\n            let count = text.unicodeScalars.count\n            if count < (s["minLength"] as? Int ?? 0) || count > (s["maxLength"] as? Int ?? Int.max) { return false }\n            if let pattern = s["pattern"] as? String, text.range(of: pattern, options: .regularExpression) == nil { return false }\n            if let max = s["x-maxUtf8Bytes"] as? Int, text.utf8.count > max { return false }\n            if s["format"] as? String == "uuid", text.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$", options: .regularExpression) == nil { return false }\n            if s["format"] as? String == "date-time" {\n                guard text.range(of: #"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$"#, options: .regularExpression) != nil else { return false }\n                let formatter = ISO8601DateFormatter()\n                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]\n                if formatter.date(from: text) == nil { formatter.formatOptions = [.withInternetDateTime]; if formatter.date(from: text) == nil { return false } }\n            }\n        case "number", "integer":\n            guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }\n            let d = n.doubleValue\n            if !d.isFinite || d < (s["minimum"] as? Double ?? -Double.infinity) || d > (s["maximum"] as? Double ?? Double.infinity) { return false }\n            if s["type"] as? String == "integer", d.rounded() != d || abs(d) > 9007199254740991 { return false }\n        case "boolean":\n            guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }\n        case "array":\n            guard let array = value as? [Any], let item = s["items"] as? [String:Any] else { return false }\n            if array.count < (s["minItems"] as? Int ?? 0) || array.count > (s["maxItems"] as? Int ?? Int.max) || array.contains(where: { !matches(item,$0) }) { return false }\n            if s["uniqueItems"] as? Bool == true { for i in array.indices { for j in array.indices where j < i { if equal(array[i],array[j]) { return false } } } }\n        default: break\n        }\n        return true\n    }`;
}

function kotlinSource(contract, hash) {
  const meta = contract['x-sync'];
  const kotlinRead = (schema, expression) => {
    const name = schema.$ref?.split('/').at(-1);
    if (name?.startsWith('Wire') && contract.$defs[name].type === 'object') return `${name}.fromJson(${expression} as JSONObject)`;
    const s = unwrap(schema, contract.$defs);
    if (s.type === 'array') return `(${expression} as JSONArray).let { a -> (0 until a.length()).map { i -> ${kotlinRead(s.items,'a.get(i)')} } }`;
    return s.type === 'integer' ? `(${expression} as Number).toLong()` : s.type === 'number' ? `(${expression} as Number).toDouble()` : `${expression} as ${typeOf(schema,contract.$defs,'kotlin')}`;
  };
  const models = Object.entries(contract.$defs).filter(([name]) => name.startsWith('Wire')).map(([name, model]) => {
    if (model.type !== 'object') return `typealias ${name} = ${typeOf(model,contract.$defs,'kotlin')}`;
    const fs = fields(model, contract.$defs, 'kotlin');
    return `data class ${name}(\n${fs.map(f=>`    val ${f.name}: ${f.type}${f.nullable?'?':''}${f.fallback !== undefined ? ` = ${literal(f.fallback,f.type,'kotlin')}` : f.nullable ? ' = null' : ''}`).join(',\n')}\n) {\n    companion object {\n        fun fromJson(json: JSONObject): ${name} {\n            require(SyncContract.validate(${json(name)}, json)) { "Invalid ${name}" }\n            return ${name}(\n${fs.map(f=>`                ${f.name} = ${f.nullable || f.fallback !== undefined ? `if (!json.has(${json(f.name)}) || json.isNull(${json(f.name)})) ${f.fallback !== undefined ? literal(f.fallback,f.type,'kotlin') : 'null'} else ` : ''}${kotlinRead(f.schema,`json.get(${json(f.name)})`)}`).join(',\n')}\n            )\n        }\n    }\n}`;
  }).join('\n\n');
  return `// Generated by scripts/generate-contracts.mjs. Do not edit.\npackage xyz.lafamila.sync.android.protocol.generated\n\nimport org.json.JSONArray\nimport org.json.JSONObject\n\nobject SyncContract {\n    const val SCHEMA_HASH = ${json(hash)}\n    const val PROTOCOL_VERSION = ${meta.protocolVersion}\n    const val MINIMUM_PROTOCOL_VERSION = ${meta.minimumProtocolVersion}\n    const val MINIMUM_WEB_PROTOCOL_VERSION = ${meta.minimumWebProtocolVersion}\n    val NATIVE_PLATFORMS: List<String> = listOf(${meta.nativePlatforms.map(json).join(', ')})\n    val SESSION_PLATFORMS: List<String> = listOf(${meta.sessionPlatforms.map(json).join(', ')})\n    val CAPABILITIES: List<String> = listOf(${meta.capabilities.map(json).join(', ')})\n    val KEYS: List<String> = listOf(${contract.$defs.Key.enum.map(json).join(', ')})\n    val MODIFIERS: List<String> = listOf(${contract.$defs.Modifier.enum.map(json).join(', ')})\n    val MOUSE_BUTTONS: List<String> = listOf(${contract.$defs.MouseButton.enum.map(json).join(', ')})\n    val LIMITS: Map<String, Long> = mapOf(${Object.entries(meta.limits).map(([k,v])=>`${json(k)} to ${v}L`).join(', ')})\n    val SIGNAL_DIRECTIONS: Map<String, String> = mapOf(${Object.entries(meta.directions).map(([k,v])=>`${json(k)} to ${json(v)}`).join(', ')})\n    fun registrationProof(challengeId: String, nonce: String): String = proof(${json(meta.proofs.registration)}, listOf(challengeId,nonce))\n    fun deviceProof(deviceId: String, challengeId: String, nonce: String): String = proof(${json(meta.proofs.device)}, listOf(deviceId,challengeId,nonce))\n    private fun proof(prefix: String, parts: List<String>): String {\n        require(parts.all { it.isNotEmpty() && !Regex("[:\\\\r\\\\n\\\\u000B\\\\u000C\\\\u0085\\\\u2028\\\\u2029]").containsMatchIn(it) }) { "Invalid proof component" }\n        return (listOf(prefix) + parts).joinToString(":")\n    }\n${kotlinRuntime()}\n    private val schemas: JSONObject by lazy { JSONObject("""${JSON.stringify(contract.$defs).replaceAll("$", () => "${'$'}")}""") }\n}\n\n${models}\n`;
}

function kotlinRuntime() {
  return `    fun validate(model: String, json: JSONObject): Boolean = try {\n        schemas.has(model) && matches(schemas.getJSONObject(model), json)\n    } catch (_: Exception) { false }\n    fun validate(model: String, json: String): Boolean = try { validate(model, JSONObject(json)) } catch (_: Exception) { false }\n    private fun matches(raw: JSONObject, value: Any): Boolean {\n        val s = if (raw.has("\\$ref")) {\n            val base = JSONObject(schemas.getJSONObject(raw.getString("\\$ref").substringAfterLast('/')).toString())\n            raw.keys().forEach { if (it != "\\$ref") base.put(it, raw.get(it)) }; base\n        } else raw\n        if (value === JSONObject.NULL) return s.optBoolean("x-nullable", false)\n        fun elements(a: JSONArray) = (0 until a.length()).map { a.get(it) }\n        if (s.has("const")) {\n            val constant = s.get("const")\n            if (if (constant is Number && value is Number) constant.toDouble() != value.toDouble() else constant != value) return false\n        }\n        if (s.has("enum") && !elements(s.getJSONArray("enum")).contains(value)) return false\n        if (s.has("oneOf") && elements(s.getJSONArray("oneOf")).count { matches(it as JSONObject,value) } != 1) return false\n        if (s.optString("type") == "object" && value !is JSONObject) return false\n        if (s.has("properties") || s.has("required")) {\n            if (value !is JSONObject) return false\n            val props = s.optJSONObject("properties") ?: JSONObject()\n            if (elements(s.optJSONArray("required") ?: JSONArray()).any { !value.has(it as String) }) return false\n            if (s.has("additionalProperties") && !s.getBoolean("additionalProperties") && value.keys().asSequence().any { !props.has(it) }) return false\n            if (props.keys().asSequence().any { value.has(it) && !matches(props.getJSONObject(it), value.get(it)) }) return false\n        }\n        when (s.optString("type")) {\n            "string" -> {\n                if (value !is String) return false\n                val count = value.codePointCount(0,value.length)\n                if (count < s.optInt("minLength",0) || count > s.optInt("maxLength",Int.MAX_VALUE)) return false\n                if (s.has("pattern") && !Regex(s.getString("pattern")).containsMatchIn(value)) return false\n                if (s.has("x-maxUtf8Bytes") && value.toByteArray(Charsets.UTF_8).size > s.getInt("x-maxUtf8Bytes")) return false\n                if (s.optString("format") == "uuid" && !Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\$").matches(value)) return false\n                if (s.optString("format") == "date-time") {\n                    if (!Regex("^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(?:\\\\.\\\\d+)?(?:Z|[+-]\\\\d{2}:\\\\d{2})\$").matches(value)) return false\n                    try { java.time.OffsetDateTime.parse(value) } catch (_: Exception) { return false }\n                }\n            }\n            "integer", "number" -> {\n                if (value !is Number) return false\n                val n = value.toDouble()\n                if (!n.isFinite() || n < s.optDouble("minimum",Double.NEGATIVE_INFINITY) || n > s.optDouble("maximum",Double.POSITIVE_INFINITY)) return false\n                if (s.optString("type") == "integer" && (n % 1.0 != 0.0 || kotlin.math.abs(n) > 9007199254740991.0)) return false\n            }\n            "boolean" -> if (value !is Boolean) return false\n            "array" -> {\n                if (value !is JSONArray) return false\n                val array = elements(value)\n                if (array.size < s.optInt("minItems",0) || array.size > s.optInt("maxItems",Int.MAX_VALUE)) return false\n                if (s.optBoolean("uniqueItems",false) && array.distinct().size != array.size) return false\n                if (array.any { !matches(s.getJSONObject("items"),it) }) return false\n            }\n        }\n        return true\n    }`;
}

function csharpSource(contract, hash) {
  const meta = contract['x-sync'];
  const models = Object.entries(contract.$defs).filter(([name,model])=>name.startsWith('Wire') && model.type === 'object').map(([name, model]) => {
    const fs = fields(model,contract.$defs,'csharp');
    const properties = fs.map(f=>`    [JsonPropertyName(${json(f.name)})]\n${(name.startsWith('WireCli') || ['cliProtocolVersion','cliChatProtocolVersion','cliChat'].includes(f.name)) && f.nullable && !f.schema['x-nullable'] ? '    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]\n' : ''}    public ${f.type}${f.nullable?'?':''} ${pascal(f.name)} { get; init; }${f.fallback !== undefined ? ` = ${literal(f.fallback,f.type,'csharp')};` : f.nullable ? '' : f.type === 'string' ? ' = string.Empty;' : f.type.startsWith('IReadOnlyList') ? ` = Array.Empty<${typeOf(unwrap(f.schema,contract.$defs).items,contract.$defs,'csharp')}>();` : f.type.startsWith('Wire') ? ' = new();' : ''}`).join('\n');
    // A parameterless constructor keeps System.Text.Json and native object initializers predictable.
    return `public sealed record ${name}\n{\n${properties}\n}`;
  }).join('\n\n');
  const list = values => `Array.AsReadOnly(new[] { ${values.map(json).join(', ')} })`;
  return `// Generated by scripts/generate-contracts.mjs. Do not edit.\n#nullable enable\nusing System;\nusing System.Collections.Generic;\nusing System.Linq;\nusing System.Text;\nusing System.Text.Json;\nusing System.Text.Json.Serialization;\nusing System.Text.RegularExpressions;\nusing System.Globalization;\n\nnamespace Sync.Contracts.Generated;\n\npublic static class SyncContract\n{\n    public const string SchemaHash = ${json(hash)};\n    public const int ProtocolVersion = ${meta.protocolVersion};\n    public const int MinimumProtocolVersion = ${meta.minimumProtocolVersion};\n    public const int MinimumWebProtocolVersion = ${meta.minimumWebProtocolVersion};\n    public static IReadOnlyList<string> NativePlatforms { get; } = ${list(meta.nativePlatforms)};\n    public static IReadOnlyList<string> SessionPlatforms { get; } = ${list(meta.sessionPlatforms)};\n    public static IReadOnlyList<string> Capabilities { get; } = ${list(meta.capabilities)};\n    public static IReadOnlyList<string> Keys { get; } = ${list(contract.$defs.Key.enum)};\n    public static IReadOnlyList<string> Modifiers { get; } = ${list(contract.$defs.Modifier.enum)};\n    public static IReadOnlyList<string> MouseButtons { get; } = ${list(contract.$defs.MouseButton.enum)};\n    public static IReadOnlyDictionary<string,long> Limits { get; } = new System.Collections.ObjectModel.ReadOnlyDictionary<string,long>(new Dictionary<string,long> { ${Object.entries(meta.limits).map(([k,v])=>`[${json(k)}] = ${v}L`).join(', ')} });\n    public static IReadOnlyDictionary<string,string> SignalDirections { get; } = new System.Collections.ObjectModel.ReadOnlyDictionary<string,string>(new Dictionary<string,string> { ${Object.entries(meta.directions).map(([k,v])=>`[${json(k)}] = ${json(v)}`).join(', ')} });\n    public static string RegistrationProof(string challengeId, string nonce) => Proof(${json(meta.proofs.registration)}, challengeId,nonce);\n    public static string DeviceProof(string deviceId, string challengeId, string nonce) => Proof(${json(meta.proofs.device)},deviceId,challengeId,nonce);\n    private static string Proof(string prefix, params string[] parts)\n    {\n        if (parts.Any(p => string.IsNullOrEmpty(p) || Regex.IsMatch(p, @"[:\\r\\n\\v\\f\\u0085\\u2028\\u2029]"))) throw new ArgumentException("Invalid proof component");\n        return prefix + ":" + string.Join(":",parts);\n    }\n${csharpRuntime()}\n    private static readonly JsonElement Schemas = JsonDocument.Parse("""\n${JSON.stringify(contract.$defs)}\n""").RootElement.Clone();\n}\n\n${models}\n`;
}

function csharpRuntime() {
  return `    public static bool Validate(string model, string json)\n    {\n        try { using var document = JsonDocument.Parse(json); return Schemas.TryGetProperty(model,out var schema) && Matches(schema,document.RootElement); }\n        catch (JsonException) { return false; }\n    }\n    public static T Deserialize<T>(string json)\n    {\n        if (!Validate(typeof(T).Name,json)) throw new JsonException("Invalid " + typeof(T).Name);\n        return JsonSerializer.Deserialize<T>(json) ?? throw new JsonException("Missing model");\n    }\n    private static bool Matches(JsonElement s, JsonElement v)\n    {\n        if (v.ValueKind == JsonValueKind.Null) return s.TryGetProperty("x-nullable",out var nullable) && nullable.GetBoolean();\n        if (s.TryGetProperty("$ref",out var reference) && !Matches(Schemas.GetProperty(reference.GetString()!.Split('/').Last()),v)) return false;\n        if (s.TryGetProperty("const",out var constant) && (constant.ValueKind != v.ValueKind || (constant.ValueKind == JsonValueKind.String ? constant.GetString() != v.GetString() : constant.ValueKind == JsonValueKind.Number ? !v.TryGetDouble(out var numericConstant) || constant.GetDouble() != numericConstant : constant.GetRawText() != v.GetRawText()))) return false;\n        if (s.TryGetProperty("enum",out var values) && !values.EnumerateArray().Any(x => x.ValueKind == v.ValueKind && (x.ValueKind == JsonValueKind.String ? x.GetString() == v.GetString() : x.GetRawText() == v.GetRawText()))) return false;\n        if (s.TryGetProperty("oneOf",out var branches) && branches.EnumerateArray().Count(b => Matches(b,v)) != 1) return false;\n        var type = s.TryGetProperty("type",out var t) ? t.GetString() : null;\n        if (type == "object" && v.ValueKind != JsonValueKind.Object) return false;\n        if (s.TryGetProperty("required",out var required) && (v.ValueKind != JsonValueKind.Object || required.EnumerateArray().Any(k => !v.TryGetProperty(k.GetString()!,out _)))) return false;\n        if (s.TryGetProperty("properties",out var props))\n        {\n            if (v.ValueKind != JsonValueKind.Object) return false;\n            if (s.TryGetProperty("additionalProperties",out var extra) && !extra.GetBoolean() && v.EnumerateObject().Any(p => !props.TryGetProperty(p.Name,out _))) return false;\n            foreach (var p in props.EnumerateObject()) if (v.TryGetProperty(p.Name,out var child) && !Matches(p.Value,child)) return false;\n        }\n        double Bound(string key, double fallback) => s.TryGetProperty(key,out var bound) ? bound.GetDouble() : fallback;\n        if (type == "string")\n        {\n            if (v.ValueKind != JsonValueKind.String) return false;\n            var text = v.GetString()!; var length = text.EnumerateRunes().Count();\n            if (length < Bound("minLength",0) || length > Bound("maxLength",double.PositiveInfinity)) return false;\n            if (s.TryGetProperty("pattern",out var pattern) && !Regex.IsMatch(text,pattern.GetString()!,RegexOptions.CultureInvariant)) return false;\n            if (Encoding.UTF8.GetByteCount(text) > Bound("x-maxUtf8Bytes",double.PositiveInfinity)) return false;\n            if (s.TryGetProperty("format",out var format))\n            {\n                if (format.GetString() == "uuid" && !Regex.IsMatch(text,@"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")) return false;\n                if (format.GetString() == "date-time" && (!Regex.IsMatch(text,@"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$") || !DateTimeOffset.TryParse(text,CultureInfo.InvariantCulture,DateTimeStyles.None,out _))) return false;\n            }\n        }\n        if (type == "integer" || type == "number")\n        {\n            if (v.ValueKind != JsonValueKind.Number || !v.TryGetDouble(out var number) || !double.IsFinite(number) || number < Bound("minimum",double.NegativeInfinity) || number > Bound("maximum",double.PositiveInfinity)) return false;\n            if (type == "integer" && (Math.Truncate(number) != number || Math.Abs(number) > 9007199254740991)) return false;\n        }\n        if (type == "boolean" && v.ValueKind != JsonValueKind.True && v.ValueKind != JsonValueKind.False) return false;\n        if (type == "array")\n        {\n            if (v.ValueKind != JsonValueKind.Array) return false;\n            var array = v.EnumerateArray().ToArray();\n            if (array.Length < Bound("minItems",0) || array.Length > Bound("maxItems",double.PositiveInfinity)) return false;\n            if (s.TryGetProperty("uniqueItems",out var unique) && unique.GetBoolean() && array.Select(x => x.ValueKind == JsonValueKind.String ? x.GetString() : x.GetRawText()).Distinct().Count() != array.Length) return false;\n            if (array.Any(x => !Matches(s.GetProperty("items"),x))) return false;\n        }\n        return true;\n    }`;
}

export async function generate({ workspaceRoot = sourceRoot, check = false, repo } = {}) {
  const base = resolve(workspaceRoot, 'sync-api-nest/contracts');
  const contract = JSON.parse(await readFile(resolve(base,'sync-contract.json'),'utf8'));
  checkSchema(contract);
  const manifest = JSON.parse(await readFile(resolve(base,'outputs.json'),'utf8'));
  if (!Array.isArray(manifest.outputs) || manifest.outputs.length !== owned.size) throw new Error('Incomplete owned-output manifest');
  const seen = new Set();
  for (const output of manifest.outputs) {
    const expected = owned.get(output.path);
    if (!expected || expected[0] !== output.repo || expected[1] !== output.kind || seen.has(output.path)) throw new Error(`Unowned/duplicate output ${output.path}`);
    seen.add(output.path);
  }
  const repos = new Set([...owned.values()].map(([r])=>r));
  if (repo && !repos.has(repo)) throw new Error(`Unknown repo ${repo}; expected ${[...repos].join(', ')}`);
  const hash = createHash('sha256').update(canonicalJSON(contract)).digest('hex');
  const fixtures = JSON.parse(await readFile(resolve(base,'fixtures.json'),'utf8'));
  for (const fixture of fixtures.valid) if (!validateValue(contract,fixture.model,fixture.value)) throw new Error(`Invalid positive fixture ${fixture.name}`);
  for (const fixture of fixtures.invalid) if (validateValue(contract,fixture.model,fixture.value)) throw new Error(`Valid negative fixture ${fixture.name}`);
  const emitters = { typescript:tsSource, swift:swiftSource, kotlin:kotlinSource, csharp:csharpSource };
  const rendered = new Map();
  const drift = [];
  let count = 0;
  for (const output of manifest.outputs.filter(o=>!repo || o.repo === repo)) {
    const target = resolve(workspaceRoot,output.path);
    if (!rendered.has(output.kind)) rendered.set(output.kind, output.kind === 'fixtures' ? JSON.stringify({ schemaHash:hash, ...fixtures },null,2)+'\n' : emitters[output.kind](contract,hash));
    const content = rendered.get(output.kind);
    // Reject pre-existing symlink escapes as well as lexical traversal, before creating/writing anything.
    let ancestor = dirname(target);
    while (true) {
      try { const physical = await realpath(ancestor); if (physical !== resolve(await realpath(workspaceRoot),relative(workspaceRoot,ancestor))) throw new Error(`Output escapes workspace or redirects through symlink: ${output.path}`); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; const next = dirname(ancestor); if (next === ancestor) throw error; ancestor = next; }
    }
    let current;
    try { const physical = await realpath(target); if (physical !== resolve(await realpath(workspaceRoot),relative(workspaceRoot,target))) throw new Error(`Output escapes workspace or redirects through symlink: ${output.path}`); current = await readFile(target,'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (content !== current) {
      if (check) drift.push(output.path);
      else { await mkdir(dirname(target),{ recursive:true }); await writeFile(target,content); }
    }
    count++;
  }
  if (drift.length) throw new Error(`Generated contract drift:\n${drift.join('\n')}`);
  return { hash, count };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let check = false, repo;
    for (let i=2; i<process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--check') check = true;
      else if (arg === '--repo' && process.argv[i+1]) repo = process.argv[++i];
      else if (arg.startsWith('--repo=')) repo = arg.slice(7);
      else throw new Error(`Unknown argument ${arg}`);
    }
    const result = await generate({ check,repo });
    console.log(`${check ? 'Checked' : 'Generated'} ${result.count} contract outputs (${result.hash})`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

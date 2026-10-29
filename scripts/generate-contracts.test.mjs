import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, cp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { generate, canonicalJSON, checkSchema, validateValue } from './generate-contracts.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const api = resolve(workspace,'sync-api-nest');
const contract = JSON.parse(await readFile(resolve(api,'contracts/sync-contract.json'),'utf8'));
const fixtures = JSON.parse(await readFile(resolve(api,'contracts/fixtures.json'),'utf8'));
const manifest = JSON.parse(await readFile(resolve(api,'contracts/outputs.json'),'utf8'));
const require = createRequire(resolve(api,'package.json'));
const ts = require('typescript');
const source = await readFile(resolve(api,'src/generated/sync-wire.ts'),'utf8');
const js = ts.transpileModule(source,{ compilerOptions:{ target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.ES2022 } }).outputText;
const wire = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

async function tempWorkspace(t) {
  const root = await mkdtemp(resolve(tmpdir(),'sync-contract-'));
  t.after(()=>rm(root,{ recursive:true, force:true }));
  await mkdir(resolve(root,'sync-api-nest'),{ recursive:true });
  await cp(resolve(api,'contracts'),resolve(root,'sync-api-nest/contracts'),{ recursive:true });
  return root;
}

test('checked-in generation matches canonical hash and all owned outputs', async () => {
  const result = await generate({ check:true });
  assert.equal(result.count,10);
  assert.equal(result.hash,createHash('sha256').update(canonicalJSON(contract)).digest('hex'));
  assert.equal(wire.SYNC_SCHEMA_HASH,result.hash);
  assert.equal(await readFile(resolve(api,'src/generated/sync-wire.ts'),'utf8'),await readFile(resolve(api,'web/src/generated/sync-wire.ts'),'utf8'));
  const canonical = await readFile(resolve(api,'contracts/sync-golden.json'),'utf8');
  for (const output of manifest.outputs.filter(o=>o.kind === 'fixtures')) assert.equal(await readFile(resolve(workspace,output.path),'utf8'),canonical,output.path);
});

test('generation twice is byte-identical, does not touch unchanged outputs, or write non-owned files', async t => {
  const root = await tempWorkspace(t);
  const sentinel = resolve(root,'sync-api-nest/src/keep.txt');
  await mkdir(dirname(sentinel),{ recursive:true });
  await writeFile(sentinel,'not generated');
  await generate({ workspaceRoot:root });
  const first = await Promise.all(manifest.outputs.map(async o=>({ path:o.path, bytes:await readFile(resolve(root,o.path)), mtime:(await stat(resolve(root,o.path))).mtimeMs })));
  await generate({ workspaceRoot:root });
  for (const output of first) {
    assert.deepEqual(await readFile(resolve(root,output.path)),output.bytes,output.path);
    assert.equal((await stat(resolve(root,output.path))).mtimeMs,output.mtime,output.path);
  }
  assert.equal(await readFile(sentinel,'utf8'),'not generated');
  await generate({ workspaceRoot:root,check:true });
});

test('--check detects deliberate stale/missing output without rewriting it; repo targeting is isolated', async t => {
  const root = await tempWorkspace(t);
  await generate({ workspaceRoot:root });
  const target = resolve(root,'sync-api-nest/web/src/generated/sync-wire.ts');
  await writeFile(target,'deliberate fixture drift\n');
  await assert.rejects(generate({ workspaceRoot:root,check:true }),/Generated contract drift/);
  assert.equal(await readFile(target,'utf8'),'deliberate fixture drift\n');
  await generate({ workspaceRoot:root,repo:'sync-api-nest',check:true });
  await assert.rejects(generate({ workspaceRoot:root,repo:'web',check:true }),/web\/src\/generated/);
  await generate({ workspaceRoot:root,repo:'web' });
  await rm(target);
  await assert.rejects(generate({ workspaceRoot:root,repo:'web',check:true }),/Generated contract drift/);
  await assert.rejects(generate({ workspaceRoot:root,repo:'unknown' }),/Unknown repo/);
});

test('unsupported schema constructs and unsafe/incomplete manifests fail closed', async t => {
  for (const [key,value] of [['allOf',[]],['anyOf',[]],['not',{}],['if',{}],['unevaluatedProperties',false],['x-misspelled',true]]) {
    const changed = structuredClone(contract);
    changed.$defs.WireDisplay[key] = value;
    assert.throws(()=>checkSchema(changed),/Unsupported schema keyword/);
  }
  const unknown = structuredClone(contract);
  unknown.$defs.WireDisplay.properties.id.$ref = '#/$defs/DoesNotExist';
  assert.throws(()=>checkSchema(unknown),/Unknown reference/);
  const enumDrift = structuredClone(contract);
  enumDrift.$defs.NativePlatform.enum.push('linux');
  assert.throws(()=>checkSchema(enumDrift),/Catalog\/schema enum drift/);
  const boundDrift = structuredClone(contract);
  boundDrift.$defs.WireDisplay.properties.width.maximum++;
  assert.throws(()=>checkSchema(boundDrift),/Catalog\/schema bound drift/);
  const cycle = structuredClone(contract);
  cycle.$defs.UUID = { $ref:'#/$defs/UUID' };
  assert.throws(()=>checkSchema(cycle),/Unsupported recursive schema/);
  const malformed = structuredClone(contract);
  malformed.$defs.WireDisplay.properties.width.maximum = 'unbounded';
  assert.throws(()=>checkSchema(malformed),/Invalid numeric schema/);
  const root = await tempWorkspace(t);
  const path = resolve(root,'sync-api-nest/contracts/outputs.json');
  const bad = structuredClone(manifest);
  bad.outputs[0].path = 'sync-api-nest/src/app.module.ts';
  await writeFile(path,JSON.stringify(bad));
  await assert.rejects(generate({ workspaceRoot:root }),/Unowned\/duplicate/);
  bad.outputs.pop();
  await writeFile(path,JSON.stringify(bad));
  await assert.rejects(generate({ workspaceRoot:root }),/Incomplete owned-output/);
});

test('output symlinks cannot escape the workspace', async t => {
  const root = await tempWorkspace(t);
  const external = await mkdtemp(resolve(tmpdir(),'sync-contract-external-'));
  t.after(()=>rm(external,{ recursive:true,force:true }));
  await mkdir(resolve(root,'sync-api-nest/src'),{ recursive:true });
  await symlink(external,resolve(root,'sync-api-nest/src/generated'));
  await assert.rejects(generate({ workspaceRoot:root }),/Output escapes workspace/);
});

test('all shared positive/negative fixtures agree with source and browser-safe TS validator', () => {
  for (const name of Object.keys(contract.$defs).filter(name=>name.startsWith('Wire'))) assert.ok(fixtures.valid.some(f=>f.model === name),`missing DTO fixture ${name}`);
  for (const fixture of fixtures.valid) {
    assert.equal(validateValue(contract,fixture.model,fixture.value),true,fixture.name);
    assert.equal(wire.validateWire(fixture.model,fixture.value),true,fixture.name);
    assert.doesNotThrow(()=>wire.decodeWire(fixture.model,fixture.value),fixture.name);
  }
  for (const fixture of fixtures.invalid) {
    assert.equal(validateValue(contract,fixture.model,fixture.value),false,fixture.name);
    assert.equal(wire.validateWire(fixture.model,fixture.value),false,fixture.name);
    assert.throws(()=>wire.decodeWire(fixture.model,fixture.value),/Invalid/,fixture.name);
  }
  assert.equal(wire.validateWire('DoesNotExist',{}),false);
});

test('legacy response defaults and flat config remain compatible; request fixtures omit v2 fields', () => {
  for (const name of ['legacy-device-defaults','legacy-session-defaults']) {
    const fixture = fixtures.valid.find(f=>f.name === name);
    const decoded = wire.decodeWire(fixture.model,fixture.value);
    assert.equal(decoded.protocolVersion,1);
    assert.deepEqual(decoded.capabilities,[]);
    assert.equal('protocolVersion' in fixture.value,false,'decoding must not mutate input');
  }
  const config = wire.decodeWire('WirePublicConfig',{ authConfigured:true });
  assert.equal(config.protocolVersion,1);
  assert.equal(config.minimumProtocolVersion,1);
  assert.equal(config.minimumWebProtocolVersion,1);
  assert.equal(config.authConfigured,true);
  assert.deepEqual(config.features,{ displaySelection:false,browserIdle:false,browserRecovery:false });
  assert.equal(config.modeDuration,undefined);
  assert.equal(config.webIdleTimeoutSeconds,undefined);
  assert.equal(wire.SYNC_LIMITS.defaultModeSeconds,43200);
  assert.equal(wire.SYNC_LIMITS.defaultMaximumModeSeconds,86400);
  const modern = wire.decodeWire('WirePublicConfig',fixtures.valid.find(f=>f.name === 'public-config').value);
  assert.equal(modern.protocol,undefined);
  assert.equal(modern.minimumWebProtocolVersion,2);
  for (const value of Object.values(fixtures.legacyRequests)) for (const key of ['protocolVersion','capabilities','clientVersion']) assert.equal(key in value,false);
});

test('UTF8 byte, numeric, finite, array, SDP and display boundaries are exact', () => {
  const epoch = '33333333-3333-4333-8333-333333333333';
  const input = { type:'text',seq:1,epoch,text:'😀'.repeat(1024) };
  assert.equal(Buffer.byteLength(input.text),4096);
  assert.equal(wire.validateWire('WireInput',input),true);
  assert.equal(wire.validateWire('WireInput',{ ...input,text:input.text+'a' }),false);
  assert.equal(wire.validateWire('WireInput',{ ...input,text:'한'.repeat(1366) }),false);
  const display = fixtures.valid.find(f=>f.name === 'display').value;
  for (const bad of [NaN,Infinity,-Infinity,0,-1,1.5,32769,true,'1920',null]) assert.equal(wire.validateWire('WireDisplay',{ ...display,width:bad }),false,String(bad));
  assert.equal(wire.validateWire('WireDisplay',{ ...display,width:32768,height:1 }),true);
  const signal = fixtures.valid.find(f=>f.name === 'initial-displays').value;
  assert.equal(wire.validateWire('WireSignal',{ ...signal,displays:Array(32).fill(display) }),true);
  assert.equal(wire.validateWire('WireSignal',{ ...signal,displays:Array(33).fill(display) }),false);
  const offer = fixtures.valid.find(f=>f.name === 'offer').value;
  assert.equal(wire.validateWire('WireSignal',{ ...offer,sdp:'v'.repeat(120000) }),true);
  assert.equal(wire.validateWire('WireSignal',{ ...offer,sdp:'v'.repeat(120001) }),false);
  assert.equal(wire.validateWire('WireInput',{type:'heartbeat',seq:1,epoch,inputEpoch:null}),false);
});

test('public fixed P256 SPKI/DER signature vectors verify exact canonical UTF8 strings', () => {
  const proofs = fixtures.proofs;
  assert.equal(proofs.testOnly,true);
  const key = createPublicKey({ key:Buffer.from(proofs.publicKeySpki,'base64'),format:'der',type:'spki' });
  assert.equal(key.asymmetricKeyDetails.namedCurve,'prime256v1');
  for (const [name,p] of [['registration',proofs.registration],['device',proofs.device]]) {
    const canonical = name === 'registration' ? wire.registrationProof(p.challengeId,p.nonce) : wire.deviceProof(p.deviceId,p.challengeId,p.nonce);
    assert.equal(canonical,p.canonical);
    assert.equal(verify('sha256',Buffer.from(canonical,'utf8'),key,Buffer.from(p.signature,'base64')),true);
    assert.equal(verify('sha256',Buffer.from(canonical+'x','utf8'),key,Buffer.from(p.signature,'base64')),false);
  }
  for (const component of proofs.invalidComponents) {
    assert.throws(()=>wire.registrationProof(component,'valid'),/Invalid proof/);
    assert.throws(()=>wire.deviceProof('device','challenge',component),/Invalid proof/);
  }
});

test('fixture directions, display epochs and Unicode edits express runtime boundaries explicitly', () => {
  for (const c of fixtures.directionCases) assert.equal(wire.SYNC_SIGNAL_DIRECTIONS[c.type] === `${c.sender}-to-${c.sender === 'host' ? 'controller' : 'host'}`,c.allowed);
  for (const c of fixtures.inputEpochCases) assert.equal(c.protocolVersion === 1 || c.currentInputEpoch === c.messageInputEpoch,c.allowed);
  const segmenter = new Intl.Segmenter('ko',{ granularity:'grapheme' });
  for (const c of fixtures.unicodeEdits) {
    const before = [...segmenter.segment(c.before)].map(s=>s.segment);
    assert.equal(before.slice(0,before.length-c.deleteGraphemes).join('')+c.insert,c.after,c.name);
  }
});

test('generated TS passes actual strict compiler (including literal-union arrays)', () => {
  execFileSync(process.execPath,[require.resolve('typescript/bin/tsc'),'--noEmit','--strict','--skipLibCheck','--target','ES2022','--moduleResolution','node',resolve(api,'src/generated/sync-wire.ts')],{ cwd:api,stdio:'pipe' });
});

test('Swift generated models compile and execute shared fixtures/defaults/proof builders', { skip:process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(resolve(tmpdir(),'sync-wire-swift-'));
  t.after(()=>rm(root,{ recursive:true,force:true }));
  const main = resolve(root,'main.swift');
  await writeFile(main,`import Foundation
let fixtureData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let fixture = try JSONSerialization.jsonObject(with: fixtureData) as! [String: Any]
precondition(fixture["schemaHash"] as! String == SyncContract.schemaHash)
for kind in ["valid", "invalid"] {
    for example in fixture[kind] as! [[String: Any]] {
        let data = try JSONSerialization.data(withJSONObject: example["value"]!, options: [.fragmentsAllowed])
        precondition(SyncContract.validate(model: example["model"] as! String, json: data) == (kind == "valid"), example["name"] as! String)
    }
}
let examples = fixture["valid"] as! [[String: Any]]
let device = examples.first { $0["name"] as? String == "legacy-device-defaults" }!
let decoded = try SyncContract.decode(WireDevice.self, from: JSONSerialization.data(withJSONObject: device["value"]!))
precondition(decoded.protocolVersion == 1 && decoded.capabilities.isEmpty && decoded.mode == nil)
let config = try SyncContract.decode(WirePublicConfig.self, from: Data("{}".utf8))
precondition(config.protocolVersion == 1 && !config.features.displaySelection && config.modeDuration == nil)
let display = WireDisplay(id: "1",name: "Main",width:1920,height:1080,isPrimary:true)
let displayRoundTrip = try JSONDecoder().decode(WireDisplay.self, from: JSONEncoder().encode(display))
precondition(displayRoundTrip == display)
let proofs = fixture["proofs"] as! [String:Any]
let registration = proofs["registration"] as! [String:String]
let canonical = try SyncContract.registrationProof(challengeID: registration["challengeId"]!, nonce: registration["nonce"]!)
precondition(canonical == registration["canonical"]!)
let deviceProof = proofs["device"] as! [String:String]
let canonicalDevice = try SyncContract.deviceProof(deviceID:deviceProof["deviceId"]!,challengeID:deviceProof["challengeId"]!,nonce:deviceProof["nonce"]!)
precondition(canonicalDevice == deviceProof["canonical"]!)
for part in proofs["invalidComponents"] as! [String] {
    do { _ = try SyncContract.registrationProof(challengeID:part,nonce:"valid"); fatalError("accepted invalid proof") } catch {}
}
let epoch = "33333333-3333-4333-8333-333333333333"
for (count,valid) in [(1024,true),(1025,false)] {
    let object: [String:Any] = ["type":"text","seq":1,"epoch":epoch,"text":String(repeating:"😀",count:count)]
    let data = try JSONSerialization.data(withJSONObject:object)
    precondition(SyncContract.validate(model:"WireInput",json:data) == valid)
}
print("Swift contract fixtures/defaults/proofs/UTF8 passed")
`);
  const binary = resolve(root,'contract-test');
  try {
    execFileSync('/usr/bin/swiftc',['-module-cache-path',resolve(root,'module-cache'),resolve(workspace,'sync-app-swift/Sources/SyncCore/Generated/SyncWire.swift'),main,'-o',binary],{ stdio:'pipe' });
    assert.match(execFileSync(binary,[resolve(api,'contracts/sync-golden.json')],{ encoding:'utf8' }),/passed/);
  } catch (error) { throw new Error(`${error.message}\n${error.stderr?.toString() ?? ''}`); }
});

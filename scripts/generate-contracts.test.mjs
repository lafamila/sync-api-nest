import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, cp, rm, stat, symlink } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, dirname, delimiter } from 'node:path';
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
  for (const [name,schema] of Object.entries(contract.$defs).filter(([name,schema])=>name.startsWith('Wire') && schema.type === 'object')) assert.ok(fixtures.valid.some(f=>f.model === name),`missing DTO fixture ${name}`);
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
  assert.deepEqual(config.features,{ displaySelection:false,browserIdle:false,browserRecovery:false,cliSessions:false });
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

test('CLI optional negotiation defaults never imply support and dates remain strings', () => {
  assert.equal(wire.SYNC_PROTOCOL_VERSION,2);
  assert.equal(wire.SYNC_CAPABILITIES.length,8);
  assert.equal(wire.SYNC_CAPABILITIES.includes('cli-sessions'),false);
  for (const name of ['legacy-device-defaults','legacy-session-defaults']) {
    const fixture = fixtures.valid.find(f=>f.name === name);
    const decoded = wire.decodeWire(fixture.model,fixture.value);
    assert.equal(decoded.cliProtocolVersion,undefined);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(decoded)),'cliProtocolVersion'),false);
    if (fixture.model === 'WireRemoteSession') assert.equal(decoded.purpose,'screen');
  }
  assert.equal(wire.decodeWire('WireFeatureFlags',{}).cliSessions,false);
  assert.equal(wire.decodeWire('WirePublicConfig',{}).features.cliSessions,false);
  assert.equal(wire.decodeWire('WirePublicConfig',fixtures.valid.find(f=>f.name === 'cli-feature-config').value).features.cliSessions,true);
  const session = fixtures.valid.find(f=>f.name === 'cli-remote-session').value;
  for (const version of [null,'1',0,2,true,1.5]) assert.equal(wire.validateWire('WireRemoteSession',{...session,cliProtocolVersion:version}),false,String(version));
  for (const purpose of [null,'terminal',1,true]) assert.equal(wire.validateWire('WireRemoteSession',{...session,purpose}),false,String(purpose));
  const result = wire.decodeWire('WireCliReceipt',fixtures.valid.find(f=>f.name === 'cli-receipt').value);
  assert.equal(typeof result.updatedAt,'string');
  assert.equal(result.updatedAt,'2026-10-31T09:00:00+09:00');
});

test('CLI variants require every common/op field and reject every unused command field', () => {
  const schema = contract.$defs.WireCliFrame;
  const sample = Object.assign({},...fixtures.valid.filter(f=>f.model === 'WireCliFrame').map(f=>f.value));
  for (const op of schema.properties.op.enum) {
    const value = fixtures.valid.find(f=>f.model === 'WireCliFrame' && f.value.op === op).value;
    const branch = schema.oneOf.find(b=>b.properties.op.const === op);
    for (const key of [...schema.required,...(branch.required ?? [])]) {
      const changed = {...value}; delete changed[key];
      assert.equal(validateValue(contract,'WireCliFrame',changed),false,`${op} needs ${key}`);
      assert.equal(wire.validateWire('WireCliFrame',changed),false,`${op} needs ${key}`);
    }
    for (const key of Object.keys(schema.properties).filter(key=>!Object.hasOwn(branch.properties,key))) {
      const changed = {...value,[key]:sample[key]};
      assert.equal(validateValue(contract,'WireCliFrame',changed),false,`${op} forbids ${key}`);
      assert.equal(wire.validateWire('WireCliFrame',changed),false,`${op} forbids ${key}`);
    }
    for (const key of schema.required) assert.equal(wire.validateWire('WireCliFrame',{...value,[key]:null}),false,`${op} nonnull ${key}`);
  }
  for (const reason of contract.$defs.WireCliError.enum) {
    assert.equal(wire.validateWire('WireCliError',reason),true,reason);
    assert.equal(wire.validateWire('WireCliFrame',{...fixtures.valid.find(f=>f.name === 'cli-error-frame').value,reason}),true,reason);
  }
  for (const reason of ['completed','held',null,1]) assert.equal(wire.validateWire('WireCliError',reason),false,String(reason));
  for (const c of fixtures.cliDirectionCases) assert.equal(['list','submit','receipt'].includes(c.op) === (c.sender === 'controller'),c.allowed);
});

test('CLI shared UTF8, scalar lengths, page caps and serialized escaping boundaries are exact', () => {
  const submit = fixtures.valid.find(f=>f.name === 'cli-submit').value;
  for (const c of fixtures.cliTextByteCases) {
    const text = c.unit.repeat(c.count)+c.suffix;
    assert.equal(Buffer.byteLength(text),c.expectedBytes,c.name);
    assert.equal(validateValue(contract,'WireCliFrame',{...submit,text}),c.valid,c.name);
    assert.equal(wire.validateWire('WireCliFrame',{...submit,text}),c.valid,c.name);
  }
  for (const c of fixtures.cliFrameByteCases) {
    const value = {...submit,text:c.unit.repeat(c.count)};
    const compact = JSON.stringify(value);
    const raw = compact+' '.repeat(Math.max(0,(c.padToBytes ?? 0)-Buffer.byteLength(compact)));
    assert.equal(wire.validateWire('WireCliFrame',JSON.parse(raw)),true,c.name);
    assert.equal(Buffer.byteLength(raw) <= wire.SYNC_LIMITS.maxCliFrameBytes,c.allowed,c.name);
    if (c.padToBytes) assert.equal(Buffer.byteLength(raw),c.padToBytes,c.name);
    assert.ok(Buffer.byteLength(value.text) <= wire.SYNC_LIMITS.maxCliTextUtf8Bytes,c.name);
  }
  const session = fixtures.valid.find(f=>f.name === 'cli-daemon-session').value;
  const page = fixtures.valid.find(f=>f.name === 'cli-list-result').value;
  assert.equal(wire.validateWire('WireCliFrame',{...page,sessions:Array(50).fill(session)}),true);
  assert.equal(wire.validateWire('WireCliFrame',{...page,sessions:Array(51).fill(session)}),false);
  const full = {...page,sessions:Array(50).fill({...session,name:'😀'.repeat(128),project:'한'.repeat(512)})};
  assert.equal(wire.validateWire('WireCliFrame',full),true);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > wire.SYNC_LIMITS.maxCliFrameBytes,'page count alone does not enforce frame bytes');
  const list = fixtures.valid.find(f=>f.name === 'cli-list').value;
  for (const count of [64,65]) {
    assert.equal(wire.validateWire('WireCliFrame',{...list,cursor:'😀'.repeat(count)}),count === 64);
    assert.equal(wire.validateWire('WireCliFrame',{...page,nextCursor:'😀'.repeat(count)}),count === 64);
  }
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

test('chat negotiation remains separately optional and strict op fields reject cross-variant data',()=>{
  assert.equal(wire.decodeWire('WireFeatureFlags',{}).cliChat,undefined);
  assert.equal(wire.decodeWire('WirePublicConfig',{features:{cliSessions:true}}).features.cliChat,undefined);
  for(const model of ['WireDevice','WireRemoteSession']) {
    const legacy=fixtures.valid.find(f=>f.model===model && f.name.startsWith('legacy-')).value;
    assert.equal(wire.decodeWire(model,legacy).cliChatProtocolVersion,undefined);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(wire.decodeWire(model,legacy))),'cliChatProtocolVersion'),false);
  }
  const frameFields=Object.keys(contract.$defs.WireCliChatFrame.properties);
  for(const fixture of fixtures.valid.filter(f=>f.model==='WireCliChatFrame')) {
    const value=fixture.value;
    for(const key of contract.$defs.WireCliChatFrame.required) {
      const bad={...value}; delete bad[key];
      assert.equal(wire.validateWire('WireCliChatFrame',bad),false,`${fixture.name} missing ${key}`);
    }
    for(const key of frameFields) {
      if(Object.hasOwn(value,key)) continue;
      assert.equal(wire.validateWire('WireCliChatFrame',{...value,[key]:null}),false,`${fixture.name} null ${key}`);
    }
    assert.equal(wire.validateWire('WireCliChatFrame',{...value,extra:true}),false);
    assert.equal(wire.validateWire('WireCliFrame',value),false,'old CLI1 rejects chat frames');
    assert.equal(wire.validateWire('WireSignal',value),false,'HTTP/WSS must not accept chat');
  }
  assert.deepEqual(contract.$defs.WireCliReceipt.properties.state.enum,['received','queued','rejected','unknown']);
  assert.equal(wire.SYNC_PROTOCOL_VERSION,2);
  assert.equal(wire.SYNC_CAPABILITIES.length,8);
});

test('chat validators reject own prototype-named additional properties',()=>{
  for(const fixture of fixtures.valid.filter(f=>['WireCliChatMessage','WireCliChatFrame'].includes(f.model))) {
    for(const key of ['__proto__','constructor','toString']) {
      const value=JSON.parse(JSON.stringify({...fixture.value,[key]:true}));
      const name=`${fixture.name} forbids ${key}`;
      assert.equal(Object.hasOwn(value,key),true,name);
      assert.equal(validateValue(contract,fixture.model,value),false,name);
      assert.equal(wire.validateWire(fixture.model,value),false,name);
      assert.throws(()=>wire.decodeWire(fixture.model,value),/Invalid/,name);
    }
  }
});

test('chat pages, segments, warnings, chunk bytes and escaped frame budgets have exact boundaries',()=>{
  const page=fixtures.valid.find(f=>f.name==='cli-chat-history-result').value;
  const message=fixtures.valid.find(f=>f.name==='cli-chat-message').value;
  assert.equal(wire.validateWire('WireCliChatFrame',{...page,messages:Array(20).fill(message)}),true);
  assert.equal(wire.validateWire('WireCliChatFrame',{...page,messages:Array(21).fill(message)}),false);
  for(const text of ['x'.repeat(8192),'\u{1f600}'.repeat(2048),'\n'.repeat(8192)]) {
    assert.equal(wire.validateWire('WireCliChatMessage',{...message,text}),true);
    assert.equal(wire.validateWire('WireCliChatMessage',{...message,text:text+'x'}),false);
  }
  const content=fixtures.valid.find(f=>f.name==='cli-chat-content-result').value;
  assert.equal(wire.validateWire('WireCliChatFrame',{...content,messages:[message,message]}),false);
  const chunk=fixtures.valid.find(f=>f.name==='cli-chat-chunk').value;
  for(const [chunkCount,valid] of [[0,false],[1,true],[128,true],[129,false]]) {
    assert.equal(wire.validateWire('WireCliChatFrame',{...chunk,chunkCount}),valid);
  }
  for(const [chunkIndex,valid] of [[-1,false],[0,true],[127,true],[128,false]]) {
    assert.equal(wire.validateWire('WireCliChatFrame',{...chunk,chunkIndex}),valid);
  }
  for(const cursor of ['x'.repeat(2048),'\u{1f600}'.repeat(2048)]) {
    assert.equal(wire.validateWire('WireCliChatFrame',{...page,nextCursor:cursor}),true);
    assert.equal(wire.validateWire('WireCliChatFrame',{...page,nextCursor:cursor+'x'}),false);
  }
  assert.equal(wire.validateWire('WireCliChatFrame',{...page,messages:[],hasMore:false,progress:true,nextCursor:undefined}),false);
  for(const warning of ['oversized-record','malformed-record']) {
    assert.equal(wire.validateWire('WireCliChatFrame',{...page,messages:[],warning}),true);
  }
  const escaped={...page,messages:Array(20).fill({...message,text:'\u0000'.repeat(8192)})};
  assert.equal(wire.validateWire('WireCliChatFrame',escaped),true,'logical result is chunked by transport');
  assert.ok(Buffer.byteLength(JSON.stringify(escaped))>wire.SYNC_LIMITS.maxCliFrameBytes);
  assert.equal(wire.SYNC_LIMITS.maxCliFrameBytes,32768);
  assert.equal(wire.SYNC_LIMITS.maxCliBufferedBytes,65536);
  assert.equal(wire.SYNC_LIMITS.maxCliPendingRequests,4);
});

test('access-code strict variants, capability and serialized byte limits are locked',()=>{
  assert.equal(wire.SYNC_LIMITS.maxCapabilities,8);
  assert.equal(wire.SYNC_LIMITS.accessCodeProtocolVersion,1);
  assert.equal(wire.SYNC_LIMITS.accessCodeRequestTimeoutSeconds,10);
  assert.equal(wire.SYNC_LIMITS.maxAccessCodeFrameBytes,2048);
  assert.ok(wire.SYNC_CAPABILITIES.includes('access-code'));
  const schema=contract.$defs.WireAccessCodeFrame;
  for(const fixture of fixtures.valid.filter(f=>f.model==='WireAccessCodeFrame')) {
    const {value}=fixture;
    const branch=schema.oneOf.find(b=>b.properties.op.const===value.op);
    for(const key of [...schema.required,...(branch.required ?? [])]) {
      const changed={...value};delete changed[key];
      assert.equal(wire.validateWire('WireAccessCodeFrame',changed),false,`${value.op} requires ${key}`);
      assert.equal(wire.validateWire('WireAccessCodeFrame',{...value,[key]:null}),false);
    }
    for(const key of [...Object.keys(schema.properties),'extra','constructor','__proto__']) {
      if(Object.hasOwn(branch.properties,key)) continue;
      const changed=JSON.parse(JSON.stringify(value));
      Object.defineProperty(changed,key,{value:'unexpected',enumerable:true});
      assert.equal(wire.validateWire('WireAccessCodeFrame',changed),false,`${value.op} forbids ${key}`);
      assert.equal(validateValue(contract,'WireAccessCodeFrame',changed),false);
    }
    const raw=JSON.stringify(value);
    for(const size of [2048,2049]) {
      const padded=raw+' '.repeat(size-Buffer.byteLength(raw));
      assert.equal(wire.validateWire('WireAccessCodeFrame',JSON.parse(padded)),true);
      assert.equal(Buffer.byteLength(padded)<=wire.SYNC_LIMITS.maxAccessCodeFrameBytes,size===2048);
    }
  }
  const result=fixtures.valid.find(f=>f.name==='access-code-result').value;
  for(const code of ['000000','999999','012345']) assert.equal(wire.validateWire('WireAccessCodeFrame',{...result,code}),true);
  for(const code of ['12345','1234567','12345\n','１２３４５６','abcdef',123456,null]) {
    assert.equal(wire.validateWire('WireAccessCodeFrame',{...result,code}),false);
  }
  for(const expiresAt of ['not-a-date','2026-11-06',null]) assert.equal(wire.validateWire('WireAccessCodeFrame',{...result,expiresAt}),false);
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
precondition(decoded.cliProtocolVersion == nil)
let config = try SyncContract.decode(WirePublicConfig.self, from: Data("{}".utf8))
precondition(config.protocolVersion == 1 && !config.features.displaySelection && !config.features.cliSessions && config.modeDuration == nil)
let session = WireRemoteSession(id:"22222222-2222-4222-8222-222222222222",hostId:"11111111-1111-4111-8111-111111111111",scope:"control",epoch:"33333333-3333-4333-8333-333333333333",expiresAt:"2026-10-31T00:00:00Z")
precondition(session.purpose == "screen" && session.cliProtocolVersion == nil)
let sessionJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(session)) as! [String:Any]
precondition(sessionJSON["cliProtocolVersion"] == nil && sessionJSON["purpose"] as? String == "screen")
let frame = WireCliFrame(op:"list",sessionId:session.id,epoch:session.epoch,requestId:"55555555-5555-4555-8555-555555555555")
precondition(frame.type == "cli" && frame.version == 1 && frame.runtimeId == nil && frame.text == nil)
let frameData = try JSONEncoder().encode(frame)
let decodedFrame = try SyncContract.decode(WireCliFrame.self,from:frameData)
precondition(decodedFrame == frame)
let frameJSON = try JSONSerialization.jsonObject(with:frameData) as! [String:Any]
precondition(frameJSON["runtimeId"] == nil && frameJSON["text"] == nil && frameJSON["reason"] == nil)
for example in examples where (example["model"] as! String).hasPrefix("WireCli") || example["model"] as? String == "WireAccessCodeFrame" {
    let data = try JSONSerialization.data(withJSONObject:example["value"]!)
    switch example["model"] as! String {
    case "WireAccessCodeFrame":
        let model = try SyncContract.decode(WireAccessCodeFrame.self,from:data)
        let roundTrip = try SyncContract.decode(WireAccessCodeFrame.self,from:JSONEncoder().encode(model))
        precondition(roundTrip == model)
    case "WireCliSession":
        let model = try SyncContract.decode(WireCliSession.self,from:data)
        let roundTrip = try SyncContract.decode(WireCliSession.self,from:JSONEncoder().encode(model))
        precondition(roundTrip == model)
    case "WireCliReceipt":
        let model = try SyncContract.decode(WireCliReceipt.self,from:data)
        precondition(model.updatedAt.contains("T"))
        let roundTrip = try SyncContract.decode(WireCliReceipt.self,from:JSONEncoder().encode(model))
        precondition(roundTrip == model)
    case "WireCliFrame":
        let model = try SyncContract.decode(WireCliFrame.self,from:data)
        let roundTrip = try SyncContract.decode(WireCliFrame.self,from:JSONEncoder().encode(model))
        precondition(roundTrip == model)
    case "WireCliChatMessage":
        let model = try SyncContract.decode(WireCliChatMessage.self,from:data)
        let roundTrip = try SyncContract.decode(WireCliChatMessage.self,from:JSONEncoder().encode(model))
        precondition(roundTrip == model)
    case "WireCliChatFrame":
        let model = try SyncContract.decode(WireCliChatFrame.self,from:data)
        let roundTrip = try SyncContract.decode(WireCliChatFrame.self,from:JSONEncoder().encode(model))
        precondition(roundTrip == model)
    default: fatalError("unexpected CLI fixture")
    }
}
let submit = examples.first { $0["name"] as? String == "cli-submit" }!["value"] as! [String:Any]
for c in fixture["cliTextByteCases"] as! [[String:Any]] {
    var value = submit
    let text = String(repeating:c["unit"] as! String,count:c["count"] as! Int)+(c["suffix"] as! String)
    value["text"] = text
    precondition(text.utf8.count == c["expectedBytes"] as! Int)
    let data = try JSONSerialization.data(withJSONObject:value)
    precondition(SyncContract.validate(model:"WireCliFrame",json:data) == c["valid"] as! Bool)
}
for c in fixture["cliFrameByteCases"] as! [[String:Any]] {
    var value = submit
    value["text"] = String(repeating:c["unit"] as! String,count:c["count"] as! Int)
    var data = try JSONSerialization.data(withJSONObject:value)
    if let target = c["padToBytes"] as? Int { data.append(Data(repeating:32,count:target-data.count)); precondition(data.count == target) }
    precondition(SyncContract.validate(model:"WireCliFrame",json:data))
    precondition((data.count <= SyncContract.limits["maxCliFrameBytes"]!) == c["allowed"] as! Bool)
}
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
    execFileSync('/usr/bin/swiftc',['-swift-version','5','-warnings-as-errors','-module-cache-path',resolve(root,'module-cache'),resolve(workspace,'sync-app-swift/Sources/SyncCore/Generated/SyncWire.swift'),main,'-o',binary],{ stdio:'pipe' });
    assert.match(execFileSync(binary,[resolve(api,'contracts/sync-golden.json')],{ encoding:'utf8' }),/passed/);
  } catch (error) { throw new Error(`${error.message}\n${error.stderr?.toString() ?? ''}`); }
});

test('C# generated models compile offline and round-trip fixtures/defaults without null command fields', async t => {
  const sdkRoot = process.env.DOTNET_ROOT ?? resolve(workspace,'.tools/dotnet-10.0.114');
  const dotnet = resolve(sdkRoot,process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  if (!existsSync(dotnet)) return t.skip('No existing .NET SDK; no dependencies are installed by contract tests');
  const root = await mkdtemp(resolve(tmpdir(),'sync-wire-csharp-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const latest = path => readdirSync(path).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
  const sdk = resolve(sdkRoot,'sdk',latest(resolve(sdkRoot,'sdk')));
  const pack = resolve(sdkRoot,'packs/Microsoft.NETCore.App.Ref',latest(resolve(sdkRoot,'packs/Microsoft.NETCore.App.Ref')),'ref');
  const refs = resolve(pack,latest(pack));
  const runtime = latest(resolve(sdkRoot,'shared/Microsoft.NETCore.App'));
  const main = resolve(root,'Program.cs');
  await writeFile(main,`using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Sync.Contracts.Generated;
static class Program {
    static void Check(bool value,string name) { if(!value) throw new Exception(name); }
    static void RoundTrip<T>(JsonElement value) {
        var decoded = SyncContract.Deserialize<T>(value.GetRawText());
        var json = JsonSerializer.Serialize(decoded);
        Check(SyncContract.Validate(typeof(T).Name,json),typeof(T).Name+" round trip");
    }
    static void Main(string[] args) {
        using var fixture = JsonDocument.Parse(File.ReadAllText(args[0]));
        Check(fixture.RootElement.GetProperty("schemaHash").GetString() == SyncContract.SchemaHash,"hash");
        foreach(var kind in new[]{"valid","invalid"}) foreach(var example in fixture.RootElement.GetProperty(kind).EnumerateArray()) {
            var model = example.GetProperty("model").GetString()!;
            var value = example.GetProperty("value");
            Check(SyncContract.Validate(model,value.GetRawText()) == (kind == "valid"),example.GetProperty("name").GetString()!);
            if(kind == "valid") switch(model) {
                case "WireAccessCodeFrame": RoundTrip<WireAccessCodeFrame>(value); break;
                case "WireCliFrame": RoundTrip<WireCliFrame>(value); break;
                case "WireCliReceipt": RoundTrip<WireCliReceipt>(value); break;
                case "WireCliSession": RoundTrip<WireCliSession>(value); break;
                case "WireCliChatFrame": RoundTrip<WireCliChatFrame>(value); break;
                case "WireCliChatMessage": RoundTrip<WireCliChatMessage>(value); break;
            }
        }
        var config = SyncContract.Deserialize<WirePublicConfig>("{}");
        Check(!config.Features.CliSessions && config.ProtocolVersion == 1,"legacy config defaults");
        var legacy = fixture.RootElement.GetProperty("valid").EnumerateArray().First(x=>x.GetProperty("name").GetString() == "legacy-session-defaults").GetProperty("value");
        var session = SyncContract.Deserialize<WireRemoteSession>(legacy.GetRawText());
        Check(session.Purpose == "screen" && session.CliProtocolVersion == null,"legacy session defaults");
        using var serialized = JsonDocument.Parse(JsonSerializer.Serialize(session));
        Check(!serialized.RootElement.TryGetProperty("cliProtocolVersion",out _),"omit absent CLI version");
        var frame = new WireCliFrame { Op="list",SessionId=session.Id,Epoch=session.Epoch,RequestId="55555555-5555-4555-8555-555555555555" };
        Check(frame.Type == "cli" && frame.Version == 1,"CLI constructor defaults");
        var raw = JsonSerializer.Serialize(frame);
        Check(SyncContract.Validate("WireCliFrame",raw),"list omits unused fields");
        Check(SyncContract.Validate("WireCliFrame",raw.Replace("\\\"version\\\":1","\\\"version\\\":1.0")),"numeric constant equality");
        Console.WriteLine("C# fixtures/defaults/serde passed");
    }
}
`);
  const dll = resolve(root,'contract-test.dll');
  await writeFile(resolve(root,'contract-test.runtimeconfig.json'),JSON.stringify({runtimeOptions:{tfm:latest(pack),framework:{name:'Microsoft.NETCore.App',version:runtime}}}));
  const options = {stdio:'pipe',env:{...process.env,DOTNET_ROOT:sdkRoot,DOTNET_CLI_HOME:root,DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',DOTNET_GENERATE_ASPNET_CERTIFICATE:'false'}};
  try {
    execFileSync(dotnet,[resolve(sdk,'Roslyn/bincore/csc.dll'),'-nologo','-noconfig','-nostdlib+','-nullable:enable','-warnaserror+',`-out:${dll}`,...readdirSync(refs).filter(f=>f.endsWith('.dll')).map(f=>`-reference:${resolve(refs,f)}`),resolve(workspace,'sync-app-windows/src/Sync.Contracts/Generated/SyncWire.g.cs'),main],options);
    assert.match(execFileSync(dotnet,[dll,resolve(api,'contracts/sync-golden.json')],{...options,encoding:'utf8'}),/passed/);
  } catch(error) { throw new Error(`${error.message}\n${error.stdout?.toString() ?? ''}\n${error.stderr?.toString() ?? ''}`); }
});

test('Kotlin generated models compile offline and decode shared fixtures/defaults using cached compiler', async t => {
  const cache = resolve(process.env.GRADLE_USER_HOME ?? resolve(homedir(),'.gradle'),'caches/modules-2/files-2.1');
  const cachedJar = (group,name,version) => {
    const path = resolve(cache,group,name,version);
    if (!existsSync(path)) return undefined;
    return readdirSync(path).flatMap(hash=>readdirSync(resolve(path,hash)).filter(f=>f === `${name}-${version}.jar`).map(f=>resolve(path,hash,f)))[0];
  };
  const jars = [
    ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.3.20'],
    ['org.jetbrains.kotlin','kotlin-stdlib','2.3.20'],
    ['org.jetbrains.kotlin','kotlin-script-runtime','2.3.20'],
    ['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],
    ['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.3.20'],
    ['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'],
    ['org.jetbrains','annotations','13.0'],
    ['org.json','json','20250517'],
  ].map(args=>cachedJar(...args));
  const javaHome = process.env.JAVA_HOME ?? (process.platform === 'darwin' ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home' : undefined);
  if (jars.some(jar=>!jar) || !javaHome || !existsSync(resolve(javaHome,'bin/java'))) return t.skip('No cached Kotlin compiler/JDK; no dependencies are installed by contract tests');
  const root = await mkdtemp(resolve(tmpdir(),'sync-wire-kotlin-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const main = resolve(root,'Main.kt');
  await writeFile(main,`import java.io.File
import org.json.JSONObject
import xyz.lafamila.sync.android.protocol.generated.*
fun main(args: Array<String>) {
    val fixture = JSONObject(File(args[0]).readText())
    check(fixture.getString("schemaHash") == SyncContract.SCHEMA_HASH)
    for(kind in listOf("valid","invalid")) {
        val examples = fixture.getJSONArray(kind)
        for(i in 0 until examples.length()) {
            val example = examples.getJSONObject(i)
            val value = example.getJSONObject("value")
            val model = example.getString("model")
            check(SyncContract.validate(model,value) == (kind == "valid")) { example.getString("name") }
            if(kind == "valid") when(model) {
                "WireAccessCodeFrame" -> check(WireAccessCodeFrame.fromJson(value).type == "access-code")
                "WireCliFrame" -> check(WireCliFrame.fromJson(value).type == "cli")
                "WireCliReceipt" -> check(WireCliReceipt.fromJson(value).updatedAt.contains("T"))
                "WireCliSession" -> check(WireCliSession.fromJson(value).id == value.getString("id"))
                "WireCliChatFrame" -> check(WireCliChatFrame.fromJson(value).type == "cli-chat")
                "WireCliChatMessage" -> check(WireCliChatMessage.fromJson(value).id == value.getString("id"))
            }
        }
    }
    val config = WirePublicConfig.fromJson(JSONObject())
    check(!config.features.cliSessions && config.protocolVersion == 1L)
    val session = WireRemoteSession(id="22222222-2222-4222-8222-222222222222",hostId="11111111-1111-4111-8111-111111111111",scope="control",epoch="33333333-3333-4333-8333-333333333333",expiresAt="2026-10-31T00:00:00Z")
    check(session.purpose == "screen" && session.cliProtocolVersion == null)
    val frame = WireCliFrame(op="list",sessionId=session.id,epoch=session.epoch,requestId="55555555-5555-4555-8555-555555555555")
    check(frame.type == "cli" && frame.version == 1L && frame.runtimeId == null)
    val raw = JSONObject().put("type","cli").put("version",1.0).put("op","list").put("sessionId",session.id).put("epoch",session.epoch).put("requestId",frame.requestId)
    check(SyncContract.validate("WireCliFrame",raw))
    check(WireCliFrame.fromJson(raw).version == 1L)
    println("Kotlin fixtures/defaults/serde passed")
}
`);
  const java = resolve(javaHome,'bin/java');
  const classpath = jars.join(delimiter);
  const classes = resolve(root,'classes');
  try {
    execFileSync(java,['-cp',classpath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-Werror','-classpath',classpath,'-d',classes,resolve(workspace,'sync-app-android/app/src/main/java/xyz/lafamila/sync/android/protocol/generated/SyncWire.kt'),main],{stdio:'pipe'});
    assert.match(execFileSync(java,['-cp',[classes,...jars.slice(1)].join(delimiter),'MainKt',resolve(api,'contracts/sync-golden.json')],{encoding:'utf8'}),/passed/);
  } catch(error) { throw new Error(`${error.message}\n${error.stdout?.toString() ?? ''}\n${error.stderr?.toString() ?? ''}`); }
});

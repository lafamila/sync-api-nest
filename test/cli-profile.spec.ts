import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { CliProfileController } from '../src/cli-profiles/cli-profile.controller';
import { CLI_PROFILE_FILES, CliProfileService, MAX_CLI_PROFILE_BYTES } from '../src/cli-profiles/cli-profile.service';

describe('public opaque signed CLI profile artifacts',()=>{
  let directory:string;
  let app:INestApplication;
  let service:CliProfileService;
  let manifest:Buffer;
  let signature:Buffer;

  beforeEach(async()=>{
    directory=await realpath(await mkdtemp(join(tmpdir(),'sync-public-profiles-')));
    const pair=generateKeyPairSync('ed25519');
    manifest=Buffer.from('{"schemaVersion":1,"sequence":1,"publicFixture":true}\n');
    signature=sign(null,manifest,pair.privateKey);
    expect(verify(null,manifest,pair.publicKey,signature)).toBe(true);
    await writeFile(join(directory,'manifest.json'),manifest);
    await writeFile(join(directory,'manifest.sig'),signature);
    await writeFile(join(directory,'claude-native-v1.json'),'{"publicFixture":"claude"}\n');
    await writeFile(join(directory,'codex-native-v1.json'),'{"publicFixture":"codex"}\n');
    service=new CliProfileService(directory);
    const module=await Test.createTestingModule({controllers:[CliProfileController],
      providers:[{provide:CliProfileService,useValue:service}]}).compile();
    app=module.createNestApplication({logger:false});
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterEach(async()=>{ await app?.close(); await rm(directory,{recursive:true,force:true}); });

  it('serves the installed public release with valid pinned Ed25519 signature and exact profile digests',async()=>{
    const releaseDirectory=join(__dirname,'../assets/cli-profiles/v1');
    const release=new CliProfileService(releaseDirectory);
    jest.spyOn(service,'artifact').mockImplementation(name=>release.artifact(name));
    const response=await request(app.getHttpServer()).get('/api/cli-profiles/v1/manifest.json').expect(200);
    const bytes=await readFile(join(releaseDirectory,'manifest.json'));
    expect(Buffer.from(response.text)).toEqual(bytes);
    const rawSignature=await request(app.getHttpServer()).get('/api/cli-profiles/v1/manifest.sig').expect(200);
    // Public release-v1 root only. No Keychain, private key or sibling source is read.
    const publicKey=createPublicKey({format:'der',type:'spki',key:Buffer.concat([
      Buffer.from('302a300506032b6570032100','hex'),Buffer.from('5hiJ4Qjj/IqtpQ/B2Yp57UV3vksVmlWjKf2rS7xQ654=','base64')])});
    expect(rawSignature.body).toHaveLength(64);
    expect(verify(null,bytes,publicKey,rawSignature.body)).toBe(true);
    expect(verify(null,Buffer.concat([bytes,Buffer.from(' ')]),publicKey,rawSignature.body)).toBe(false);
    const manifest=JSON.parse(bytes.toString()) as {schemaVersion:number;sequence:number;securityFloor:number;minimumBrokerVersion:number;
      keyID:string;issuedAt:number;expiresAt:number;revokedProfileIDs:string[];profiles:{id:string;path:string;sha256:string;byteCount:number}[]};
    expect(manifest).toMatchObject({schemaVersion:1,keyID:'release-v1',sequence:1,securityFloor:1,minimumBrokerVersion:1,revokedProfileIDs:[]});
    expect(manifest.expiresAt-manifest.issuedAt).toBe(30*86400);
    expect(manifest.profiles).toHaveLength(2);
    let total=0;
    for(const profile of manifest.profiles) {
      expect(['claude-native-v1.json','codex-native-v1.json']).toContain(profile.path);
      const asset=await release.artifact(profile.path);
      expect(asset.bytes.length).toBe(profile.byteCount);
      expect(asset.bytes).toEqual(await readFile(join(releaseDirectory,profile.path)));
      expect(createHash('sha256').update(asset.bytes).digest('hex')).toBe(profile.sha256);
      total+=asset.bytes.length;
    }
    expect(total).toBeLessThanOrEqual(1048576);
    await request(app.getHttpServer()).get('/api/cli-profiles/v1/trust-roots.json').expect(404);
  });

  it('serves byte-identical public JSON and raw64 signature without authentication or cookies',async()=>{
    const response=await request(app.getHttpServer()).get('/api/cli-profiles/v1/manifest.json')
      .set('Cookie','unrelated=ignored').set('X-Sync-Session','not-a-credential').expect(200);
    expect(response.text).toBe(manifest.toString());
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('public, max-age=300, must-revalidate');
    const raw=await request(app.getHttpServer()).get('/api/cli-profiles/v1/manifest.sig').expect(200);
    expect(raw.body).toEqual(signature);
    expect(raw.headers['content-type']).toBe('application/octet-stream');
    for(const file of CLI_PROFILE_FILES) expect((await service.artifact(file)).bytes.length).toBeLessThanOrEqual(MAX_CLI_PROFILE_BYTES);
  });
  it('supports conditional GET and HEAD with content-specific ETags',async()=>{
    const first=await request(app.getHttpServer()).get('/api/cli-profiles/v1/manifest.json').expect(200);
    expect(first.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    const cached=await request(app.getHttpServer()).get('/api/cli-profiles/v1/manifest.json').set('If-None-Match',first.headers.etag).expect(304);
    expect(cached.text).toBe('');
    const head=await request(app.getHttpServer()).head('/api/cli-profiles/v1/manifest.json').expect(200);
    expect(head.headers['content-length']).toBe(String(manifest.length));
    expect(head.text).toBeUndefined();
    await writeFile(join(directory,'manifest.json'),Buffer.concat([manifest,Buffer.from(' ')]));
    const changed=await request(app.getHttpServer()).get('/api/cli-profiles/v1/manifest.json').set('If-None-Match',first.headers.etag).expect(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
  });
  it.each(['../manifest.json','/etc/passwd','trust-roots.json','private-key.pem','.env','manifest.json.gz','codex-native-v2.json'])
  ('never opens unallowlisted artifact %s',async(name)=>{
    await expect(service.artifact(name)).rejects.toMatchObject({status:404});
  });
  it('returns404 for unknown files/encoded traversal and does not expose static directory contents',async()=>{
    for(const path of ['trust-roots.json','manifest.json.gz','%2e%2e%2fmanifest.json']) {
      await request(app.getHttpServer()).get(`/api/cli-profiles/v1/${path}`).expect(404);
    }
    await request(app.getHttpServer()).get('/api/cli-profiles/v1/').expect(404);
    await request(app.getHttpServer()).post('/api/cli-profiles/v1/manifest.json').expect(404);
  });
  it.each(['missing-signature','short-signature','long-signature','missing-profile','symlink','directory','oversized','empty'] as const)
  ('fails closed with sanitized503 for %s',async(kind)=>{
    if(kind==='missing-signature') await rm(join(directory,'manifest.sig'));
    if(kind==='short-signature') await writeFile(join(directory,'manifest.sig'),Buffer.alloc(63));
    if(kind==='long-signature') await writeFile(join(directory,'manifest.sig'),Buffer.alloc(65));
    if(kind==='missing-profile') await rm(join(directory,'codex-native-v1.json'));
    if(kind==='symlink') { await rm(join(directory,'manifest.json')); await symlink('claude-native-v1.json',join(directory,'manifest.json')); }
    if(kind==='directory') { await rm(join(directory,'manifest.json')); await mkdir(join(directory,'manifest.json')); }
    if(kind==='oversized') await writeFile(join(directory,'manifest.json'),Buffer.alloc(65537,32));
    if(kind==='empty') await writeFile(join(directory,'manifest.json'),Buffer.alloc(0));
    const result=await request(app.getHttpServer()).get('/api/cli-profiles/v1/manifest.json').expect(503);
    expect(JSON.stringify(result.body)).not.toContain(directory);
    expect(result.body.message).toBe('Signed CLI profiles are not available');
  });
  it('bounds all public artifacts at65536 bytes without parsing/re-encoding their signed data',async()=>{
    const bytes=Buffer.alloc(65536,32);
    await writeFile(join(directory,'manifest.json'),bytes);
    expect((await service.artifact('manifest.json')).bytes).toEqual(bytes);
    await writeFile(join(directory,'codex-native-v1.json'),Buffer.alloc(65537,32));
    await expect(service.artifact('manifest.json')).rejects.toMatchObject({status:503});
  });
  it('rejects a redirected artifact directory, not just final-file symlinks',async()=>{
    const link=join(directory,'redirect');
    await symlink(directory,link);
    await expect(new CliProfileService(link).artifact('manifest.json')).rejects.toMatchObject({status:503});
  });
});

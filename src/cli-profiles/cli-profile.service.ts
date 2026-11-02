import { Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const CLI_PROFILE_DIRECTORY=Symbol('CLI_PROFILE_DIRECTORY');
export const CLI_PROFILE_FILES=['manifest.json','manifest.sig','claude-native-v1.json','codex-native-v1.json'] as const;
export const MAX_CLI_PROFILE_BYTES=65536;

@Injectable()
export class CliProfileService {
  private readonly directory:string;

  constructor(@Optional() @Inject(CLI_PROFILE_DIRECTORY) directory?:string) {
    this.directory=resolve(directory ?? join(process.cwd(),'assets','cli-profiles','v1'));
  }

  async artifact(name:string):Promise<{bytes:Buffer;etag:string;contentType:string}> {
    if(!(CLI_PROFILE_FILES as readonly string[]).includes(name)) throw new NotFoundException('Profile artifact not found');
    try {
      if(await realpath(this.directory)!==this.directory) throw new Error('Invalid artifact directory');
      // An unsigned/incomplete baseline must not become an advertised release. Signatures
      // remain opaque here: clients verify exact bytes against their pinned public root.
      const signature=await this.read('manifest.sig',64);
      if(signature.length!==64) throw new Error('Invalid signature size');
      let bytes=signature;
      for(const file of CLI_PROFILE_FILES) {
        if(file==='manifest.sig') continue;
        const data=await this.read(file,MAX_CLI_PROFILE_BYTES);
        if(data.length===0) throw new Error('Empty artifact');
        if(file===name) bytes=data;
      }
      return {bytes,etag:`"${createHash('sha256').update(bytes).digest('hex')}"`,
        contentType:name==='manifest.sig'?'application/octet-stream':'application/json; charset=utf-8'};
    } catch {
      throw new ServiceUnavailableException('Signed CLI profiles are not available');
    }
  }

  private async read(name:string,limit:number):Promise<Buffer> {
    const file=await open(join(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const before=await file.stat();
      if(!before.isFile() || before.size>limit) throw new Error('Invalid artifact size');
      const bytes=Buffer.alloc(limit+1);
      let length=0;
      while(length<bytes.length) {
        const {bytesRead}=await file.read(bytes,length,bytes.length-length,null);
        if(bytesRead===0) break;
        length+=bytesRead;
      }
      const after=await file.stat();
      if(length>limit || length!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs ||
        after.ctimeMs!==before.ctimeMs) throw new Error('Artifact changed during read');
      return bytes.subarray(0,length);
    } finally { await file.close(); }
  }
}

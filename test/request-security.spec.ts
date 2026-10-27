import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { sha256 } from '../src/common/crypto';
import { AuthSessionContext } from '../src/common/request';
import { RequestSecurityService } from '../src/common/request-security.service';
import { SyncConfigService } from '../src/config/config.service';
import { testConfig } from './helpers';

describe('RequestSecurityService', () => {
  const service=new RequestSecurityService(new SyncConfigService(testConfig()));
  const base:AuthSessionContext={ databaseId:'id',token:'opaque',source:'web',csrfHash:sha256('csrf'),
    account:{id:'owner',name:'Owner',permission:'member'},platform:'web' };

  it('requires allowed Origin and matching double-submit CSRF for browser writes', () => {
    const request={headers:{origin:'http://localhost:3053','x-csrf-token':'csrf',cookie:'sync_csrf=csrf'}} as unknown as Request;
    expect(()=>service.assertMutation(request,base)).not.toThrow();
  });
  it('rejects cross-origin browser writes even with a copied token', () => {
    const request={headers:{origin:'https://attacker.invalid','x-csrf-token':'csrf',cookie:'sync_csrf=csrf'}} as unknown as Request;
    expect(()=>service.assertMutation(request,base)).toThrow(ForbiddenException);
  });
  it('does not require browser CSRF on opaque native sessions', () => {
    const request={headers:{}} as Request;
    expect(()=>service.assertMutation(request,{...base,source:'native',platform:'ios'})).not.toThrow();
  });
});

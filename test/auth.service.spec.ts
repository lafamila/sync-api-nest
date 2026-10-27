import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { SyncConfigService } from '../src/config/config.service';
import { testConfig } from './helpers';

describe('AuthService claim enforcement', () => {
  const service=new AuthService(new SyncConfigService(testConfig()));

  it('accepts only the sync service member claim and uses sub as owner id', () => {
    expect(service.validatePayload({ sub:'account-1',name:'Owner',aud:'service:sync',iss:'http://localhost:3032',
      servicePermissions:[{serviceKey:'sync',permission:'member'}] })).toMatchObject({
        id:'account-1',subject:'account-1',name:'Owner',permission:'member',
      });
  });

  it.each(['visitor','tester','owner'])('rejects unsupported %s permission', (permission) => {
    expect(()=>service.validatePayload({sub:'account-1',servicePermissions:[{serviceKey:'sync',permission}]}))
      .toThrow(UnauthorizedException);
  });

  it('does not accept another service permission', () => {
    expect(()=>service.validatePayload({sub:'account-1',servicePermissions:[{serviceKey:'body-lab',permission:'superadmin'}]}))
      .toThrow('Sync member or superadmin permission is required');
  });
});

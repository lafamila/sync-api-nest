import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/request';
import { RequestSecurityService } from '../common/request-security.service';
import { SessionGuard } from '../auth/session.guard';
import { ApproveGrantDto, ConnectDeviceDto, DeviceChallengeDto, DeviceProofDto, RegisterDeviceDto, SetModeDto } from './device.dto';
import { DeviceProofService } from './device-proof.service';
import { DeviceService } from './device.service';

@Controller('devices')
@UseGuards(SessionGuard)
export class DeviceController {
  constructor(private readonly service: DeviceService, private readonly proofs: DeviceProofService, private readonly security: RequestSecurityService) {}

  @Post('challenge')
  challenge(@Req() req: AuthenticatedRequest, @Body() input: DeviceChallengeDto) {
    this.security.assertMutation(req,req.syncSession);
    this.security.assertNativeSession(req.syncSession);
    return this.proofs.challenge(req.syncSession.account,input.deviceId);
  }
  @Post()
  register(@Req() req: AuthenticatedRequest, @Body() input: RegisterDeviceDto) {
    this.security.assertMutation(req,req.syncSession); this.security.assertNativeSession(req.syncSession);
    return this.service.register(req.syncSession,input).then((device) => ({ device:publicDevice(device) }));
  }
  @Get()
  list(@Req() req: AuthenticatedRequest) { return this.service.list(req.syncSession); }
  @Delete(':id')
  remove(@Req() req: AuthenticatedRequest,@Param('id') id:string,@Body() proof:DeviceProofDto) {
    this.security.assertMutation(req,req.syncSession); this.security.assertNativeSession(req.syncSession);
    return this.service.remove(req.syncSession,id,proof);
  }
  @Post(':id/mode')
  mode(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() input:SetModeDto) {
    this.security.assertMutation(req,req.syncSession); this.security.assertNativeSession(req.syncSession);
    return this.service.setMode(req.syncSession,id,input);
  }
  @Get(':id/grants')
  grants(@Req() req:AuthenticatedRequest,@Param('id') id:string) { return this.service.listGrants(req.syncSession,id); }
  @Post(':id/grants')
  approveGrant(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() input:ApproveGrantDto) {
    this.security.assertMutation(req,req.syncSession); this.security.assertNativeSession(req.syncSession);
    return this.service.approveGrant(req.syncSession,id,input);
  }
  @Delete(':id/grants/:grantId')
  revokeGrant(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Param('grantId') grantId:string,@Body() proof:DeviceProofDto) {
    this.security.assertMutation(req,req.syncSession); this.security.assertNativeSession(req.syncSession);
    return this.service.revokeGrant(req.syncSession,id,grantId,proof);
  }
  @Post(':id/connect')
  connect(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() input:ConnectDeviceDto) {
    this.security.assertMutation(req,req.syncSession); return this.service.connect(req.syncSession,id,input,req.ip ?? 'unknown');
  }
}

function publicDevice(device: import('./device.repository').Device) {
  return { id:device.id,name:device.name,platform:device.platform,online:false,mode:null };
}

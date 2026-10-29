import { Body, Controller, Delete, Get, NotFoundException, Optional, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { AuthenticatedRequest } from '../common/request';
import { RequestSecurityService } from '../common/request-security.service';
import { DeviceProofService } from '../devices/device-proof.service';
import { BrowserActivityDto, BrowserRecoveryDto, EndSessionDto } from '../devices/device.dto';
import { DeviceService, presentSession } from '../devices/device.service';
import { RemoteSessionService } from './remote-session.service';

@Controller('sessions')
@UseGuards(SessionGuard)
export class RemoteSessionController {
  constructor(private readonly sessions:RemoteSessionService,private readonly proofs:DeviceProofService,private readonly security:RequestSecurityService,
    @Optional() private readonly devices?:DeviceService) {}
  @Get()
  async list(@Req() req:AuthenticatedRequest) { return { sessions:(await this.sessions.listOwned(req.syncSession.account.id)).map(presentSession) }; }
  @Post(':id/activity')
  activity(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() input:BrowserActivityDto) {
    this.security.assertMutation(req,req.syncSession);
    return this.devices!.webActivity(req.syncSession,id,input.activityToken);
  }
  @Post(':id/recover')
  recover(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() input:BrowserRecoveryDto) {
    this.security.assertMutation(req,req.syncSession);
    return this.devices!.recover(req.syncSession,id,input);
  }
  @Delete(':id')
  async end(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() input:EndSessionDto) {
    this.security.assertMutation(req,req.syncSession);
    const remote = await this.sessions.findOwned(req.syncSession.account.id,id);
    if (!remote) throw new NotFoundException('Remote session not found');
    if (req.syncSession.source === 'native') {
      if (!input.deviceId || !input.challengeId || !input.signature) throw new NotFoundException('Native device proof is required');
      if (input.deviceId !== remote.hostId && input.deviceId !== remote.controllerDeviceId) throw new NotFoundException('Device is not a session participant');
      await this.proofs.verify(req.syncSession.account,{ deviceId:input.deviceId,challengeId:input.challengeId,signature:input.signature });
    } else if (remote.authSessionId !== req.syncSession.databaseId) throw new NotFoundException('Remote session not found');
    await this.sessions.endOwned(req.syncSession.account.id,id,'revoked');
    return { ok:true };
  }
}

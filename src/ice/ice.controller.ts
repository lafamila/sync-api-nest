import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { AuthenticatedRequest } from '../common/request';
import { IceService } from './ice.service';

@Controller('ice')
@UseGuards(SessionGuard)
export class IceController {
  constructor(private readonly ice:IceService) {}
  @Get() get(@Req() req:AuthenticatedRequest) { return { iceServers:this.ice.forAccount(req.syncSession.account) }; }
}

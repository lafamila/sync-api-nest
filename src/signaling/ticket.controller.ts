import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { AuthenticatedRequest } from '../common/request';
import { RequestSecurityService } from '../common/request-security.service';
import { DeviceProofDto } from '../devices/device.dto';
import { DeviceProofService } from '../devices/device-proof.service';
import { TicketService } from './ticket.service';

@Controller('signaling/tickets')
@UseGuards(SessionGuard)
export class TicketController {
  constructor(private readonly tickets:TicketService,private readonly proofs:DeviceProofService,private readonly security:RequestSecurityService) {}
  @Post()
  async create(@Req() req:AuthenticatedRequest,@Body() proof:DeviceProofDto) {
    this.security.assertMutation(req,req.syncSession);
    this.security.assertNativeSession(req.syncSession);
    const device=await this.proofs.verify(req.syncSession.account,proof);
    const ticket=await this.tickets.issue({ role:'device',ownerAccountId:req.syncSession.account.id,deviceId:device.id,
      platform:device.platform,authSessionId:req.syncSession.databaseId });
    return { ticket };
  }
}

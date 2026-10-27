import { Module } from '@nestjs/common';
import { AuthService } from './auth/auth.service';
import { SessionController } from './auth/session.controller';
import { SessionGuard } from './auth/session.guard';
import { SessionRepository } from './auth/session.repository';
import { SessionService } from './auth/session.service';
import { RequestSecurityService } from './common/request-security.service';
import { RevocationBusService } from './common/revocation-bus.service';
import { SyncConfigService } from './config/config.service';
import { DatabaseService } from './database/database.service';
import { DeviceController } from './devices/device.controller';
import { DeviceProofService } from './devices/device-proof.service';
import { DeviceRepository } from './devices/device.repository';
import { DeviceService } from './devices/device.service';
import { ModeService } from './devices/mode.service';
import { HealthController } from './health.controller';
import { IceController } from './ice/ice.controller';
import { IceService } from './ice/ice.service';
import { RedisService } from './redis/redis.service';
import { RemoteSessionController } from './sessions/remote-session.controller';
import { RemoteSessionRepository } from './sessions/remote-session.repository';
import { RemoteSessionService } from './sessions/remote-session.service';
import { SignalingService } from './signaling/signaling.service';
import { TicketController } from './signaling/ticket.controller';
import { TicketService } from './signaling/ticket.service';
import { RuntimeIdentityService } from './runtime/runtime-identity.service';
import { RuntimeCoordinatorService } from './runtime/runtime-coordinator.service';

@Module({
  controllers:[HealthController,SessionController,DeviceController,RemoteSessionController,IceController,TicketController],
  providers:[SyncConfigService,DatabaseService,RedisService,RevocationBusService,RequestSecurityService,
    AuthService,SessionRepository,SessionService,SessionGuard,DeviceRepository,DeviceProofService,ModeService,
    RuntimeIdentityService,RemoteSessionRepository,RemoteSessionService,RuntimeCoordinatorService,
    IceService,TicketService,DeviceService,SignalingService],
})
export class AppModule {}

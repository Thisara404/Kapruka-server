import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeactivationService } from './deactivation.service.js';
import { DeactivationScheduler } from './deactivation.scheduler.js';
import { DeactivationController } from './deactivation.controller.js';
import { DeactivatedUserEntity } from '../database/entities/index.js';
import { UsersModule } from '../users/users.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeactivatedUserEntity]),
    UsersModule,
    ChatModule,
    AnalyticsModule,
    AuthModule,
  ],
  providers: [DeactivationService, DeactivationScheduler],
  controllers: [DeactivationController],
  exports: [DeactivationService],
})
export class DeactivationModule {}

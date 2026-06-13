import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeactivationService } from './deactivation.service';
import { DeactivationScheduler } from './deactivation.scheduler';
import { DeactivationController } from './deactivation.controller';
import {
  DeactivatedUser,
  DeactivatedUserSchema,
} from './schemas/deactivated-user.schema';
import { UsersModule } from '../users/users.module';
import { ChatModule } from '../chat/chat.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DeactivatedUser.name, schema: DeactivatedUserSchema },
    ]),
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

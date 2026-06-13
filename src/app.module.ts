import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { ChatModule } from './chat/chat.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { DeactivationModule } from './deactivation/deactivation.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local', '../thisari-app/.env.local'],
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    UsersModule,
    ChatModule,
    AnalyticsModule,
    DeactivationModule,
  ],
})
export class AppModule {}

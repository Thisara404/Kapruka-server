import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import {
  AgentSessionEntity,
  AgentTurnEntity,
  StepTraceEntity,
} from '../database/entities/index.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentSessionEntity,
      AgentTurnEntity,
      StepTraceEntity,
    ]),
    AnalyticsModule,
    AuthModule,
  ],
  providers: [ChatService],
  controllers: [ChatController],
  exports: [ChatService],
})
export class ChatModule {}

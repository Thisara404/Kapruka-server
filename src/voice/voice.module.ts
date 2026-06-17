import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { AgentTurnEntity } from '../database/entities/index.js';
import { VoiceGateway } from './voice.gateway.js';

@Module({
  imports: [
    ChatModule,
    AuthModule,
    TypeOrmModule.forFeature([AgentTurnEntity]),
  ],
  providers: [VoiceGateway],
})
export class VoiceModule {}

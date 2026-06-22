import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { AgentTurnEntity } from '../database/entities/index.js';
import { VoiceController } from './voice.controller.js';
import { VoiceGateway } from './voice.gateway.js';
import { VoiceTranscriptionService } from './voice-transcription.service.js';

@Module({
  imports: [
    ChatModule,
    AuthModule,
    TypeOrmModule.forFeature([AgentTurnEntity]),
  ],
  controllers: [VoiceController],
  providers: [VoiceGateway, VoiceTranscriptionService],
})
export class VoiceModule {}

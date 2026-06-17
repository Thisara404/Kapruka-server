import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { VoiceGateway } from './voice.gateway.js';

@Module({
  imports: [ChatModule, AuthModule],
  providers: [VoiceGateway],
})
export class VoiceModule {}

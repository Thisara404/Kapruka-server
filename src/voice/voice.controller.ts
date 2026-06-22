import { Body, Controller, Post } from '@nestjs/common';
import { VoiceTranscriptionService } from './voice-transcription.service.js';
import type { VoiceTranscribeInput } from './voice-transcription.service.js';

@Controller('voice')
export class VoiceController {
  constructor(
    private readonly voiceTranscriptionService: VoiceTranscriptionService,
  ) {}

  @Post('transcribe')
  transcribe(@Body() body: VoiceTranscribeInput) {
    return this.voiceTranscriptionService.transcribe(body);
  }
}

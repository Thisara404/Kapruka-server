import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { DEFAULT_GEMINI_TRANSCRIBE_MODEL } from './voice.constants.js';

const MAX_TRANSCRIBE_AUDIO_BYTES = 4 * 1024 * 1024;
const SUPPORTED_AUDIO_MEDIA_TYPES = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
]);

export interface VoiceTranscribeInput {
  audioBase64?: string;
  mediaType?: string;
  sessionId?: string;
}

export interface VoiceTranscribeResult {
  text: string;
  durationMs: number;
}

@Injectable()
export class VoiceTranscriptionService {
  constructor(private readonly configService: ConfigService) {}

  async transcribe(
    input: VoiceTranscribeInput,
  ): Promise<VoiceTranscribeResult> {
    const startedAt = Date.now();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new InternalServerErrorException({
        error: 'VOICE_API_KEY_MISSING',
      });
    }

    const audioBase64 = this.normalizeBase64(input.audioBase64);
    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length === 0) {
      throw new BadRequestException({ error: 'EMPTY_AUDIO' });
    }
    if (audio.length > MAX_TRANSCRIBE_AUDIO_BYTES) {
      throw new BadRequestException({
        error: 'AUDIO_TOO_LARGE',
        maxBytes: MAX_TRANSCRIBE_AUDIO_BYTES,
      });
    }

    const mediaType = input.mediaType?.trim() || 'audio/webm';
    if (!SUPPORTED_AUDIO_MEDIA_TYPES.has(mediaType)) {
      throw new BadRequestException({
        error: 'UNSUPPORTED_AUDIO_TYPE',
        mediaType,
      });
    }

    const google = createGoogleGenerativeAI({ apiKey });
    const result = await generateText({
      model: google(this.getTranscriptionModel()),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Transcribe this user voice message exactly. Return only the spoken text. ' +
                'If the speech is Sinhala, Tamil, English, Singlish, or mixed language, keep the wording as spoken.',
            },
            {
              type: 'file',
              data: audio,
              mediaType,
            },
          ],
        },
      ],
    });

    const text = result.text.trim();
    if (!text) {
      throw new BadRequestException({ error: 'NO_SPEECH_DETECTED' });
    }

    return {
      text,
      durationMs: Date.now() - startedAt,
    };
  }

  getModelPath(): string {
    return `models/${this.getTranscriptionModel()}`;
  }

  private getTranscriptionModel(): string {
    return (
      this.configService.get<string>('GEMINI_TRANSCRIBE_MODEL') ??
      DEFAULT_GEMINI_TRANSCRIBE_MODEL
    ).trim();
  }

  private getApiKey(): string | undefined {
    return (
      this.configService.get<string>('GEMINI_LIVE_API_KEY') ??
      this.configService.get<string>('GOOGLE_GENERATIVE_AI_API_KEY')
    );
  }

  private normalizeBase64(value?: string): string {
    const raw = value?.trim();
    if (!raw) {
      throw new BadRequestException({ error: 'AUDIO_REQUIRED' });
    }

    const commaIndex = raw.indexOf(',');
    const base64 = commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
      throw new BadRequestException({ error: 'INVALID_AUDIO_BASE64' });
    }
    return base64.replace(/\s/g, '');
  }
}

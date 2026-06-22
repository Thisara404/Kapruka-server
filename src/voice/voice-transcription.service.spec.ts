import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { VoiceTranscriptionService } from './voice-transcription.service.js';

jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(),
}));

jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

describe('VoiceTranscriptionService', () => {
  let service: VoiceTranscriptionService;
  let googleModel: jest.Mock;

  beforeEach(() => {
    googleModel = jest.fn((model: string) => ({ model }));
    (createGoogleGenerativeAI as jest.Mock).mockReturnValue(googleModel);
    (generateText as jest.Mock).mockResolvedValue({ text: 'hello Thisari' });

    service = new VoiceTranscriptionService({
      get: jest.fn((key: string) =>
        key === 'GEMINI_LIVE_API_KEY' ? 'test-key' : undefined,
      ),
    } as unknown as ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('uses a generateContent-compatible transcription model path', () => {
    expect(service.getModelPath()).toBe('models/gemini-3.5-flash');
  });

  it('transcribes one submitted audio blob with the transcription model', async () => {
    const result = await service.transcribe({
      audioBase64: Buffer.from('audio').toString('base64'),
      mediaType: 'audio/webm',
      sessionId: 'session-1',
    });

    expect(result.text).toBe('hello Thisari');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
    });
    expect(googleModel).toHaveBeenCalledWith('gemini-3.5-flash');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('rejects missing audio before calling Gemini', async () => {
    await expect(
      service.transcribe({ audioBase64: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generateText).not.toHaveBeenCalled();
  });
});

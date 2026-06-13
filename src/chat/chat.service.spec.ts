import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ChatService } from './chat.service';
import { Conversation } from './schemas/conversation.schema';
import { AnalyticsService } from '../analytics/analytics.service';

// Mock dependencies
const mockConversationModel = {
  findOne: jest.fn().mockReturnThis(),
  exec: jest.fn(),
  updateOne: jest.fn().mockReturnThis(),
  deleteMany: jest.fn().mockReturnThis(),
};

const mockAnalyticsService = {
  logEvent: jest.fn().mockResolvedValue(null),
  logProductView: jest.fn().mockResolvedValue(null),
  logDeliveryCheck: jest.fn().mockResolvedValue(null),
  logOrder: jest.fn().mockResolvedValue(null),
  migrateSession: jest.fn().mockResolvedValue(null),
};

// Mock MCP tools client
jest.mock('./mcp-client', () => ({
  callMcpTool: jest.fn(),
}));

// Mock AI SDK generateText
jest.mock('ai', () => {
  const original = jest.requireActual('ai');
  return {
    ...original,
    generateText: jest.fn(),
    streamText: jest.fn(),
  };
});

import { generateText } from 'ai';

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        {
          provide: getModelToken(Conversation.name),
          useValue: mockConversationModel,
        },
        {
          provide: AnalyticsService,
          useValue: mockAnalyticsService,
        },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('sanitizeIdentity', () => {
    it('should replace Llama, Groq, and Gemini with Thisari or Kapruka', () => {
      const input = 'I am Llama, powered by Groq. Google Gemini is my helper.';
      const output = (service as any).sanitizeIdentity(input);
      expect(output).toBe(
        'I am Thisari, powered by Kapruka. Thisari is my helper.',
      );
    });

    it('should handle empty or null values', () => {
      expect((service as any).sanitizeIdentity('')).toBe('');
      expect((service as any).sanitizeIdentity(null)).toBeNull();
    });
  });

  describe('translateInput', () => {
    it('should detect Sinhala text and mock translate', async () => {
      (generateText as jest.Mock).mockResolvedValue({
        text: 'sinhala: What is this cake?',
      });

      const result = await (service as any).translateInput(
        'මේ කේක් එක මොකක්ද?',
      );
      expect(result).toEqual({
        translatedText: 'What is this cake?',
        detectedLanguage: 'sinhala',
      });
      expect(generateText).toHaveBeenCalled();
    });

    it('should detect Tanglish text and mock translate', async () => {
      (generateText as jest.Mock).mockResolvedValue({
        text: 'tanglish: show cakes',
      });

      const result = await (service as any).translateInput(
        'cake monada thiyenne',
      );
      expect(result).toEqual({
        translatedText: 'show cakes',
        detectedLanguage: 'tanglish',
      });
    });

    it('should fall back to raw input on Gemini errors', async () => {
      (generateText as jest.Mock).mockRejectedValue(
        new Error('503 Service Unavailable'),
      );

      const result = await (service as any).translateInput('කේක්');
      expect(result).toEqual({
        translatedText: 'කේක්',
        detectedLanguage: 'english',
      });
    });
  });

  describe('translateOutput', () => {
    it('should translate output to Sinhala using Gemini', async () => {
      (generateText as jest.Mock).mockResolvedValue({
        text: 'කප්රුක වෙත සාදරයෙන් පිළිගනිමු',
      });

      const result = await (service as any).translateOutput(
        'Welcome to Kapruka',
        'sinhala',
      );
      expect(result).toBe('කප්රුක වෙත සාදරයෙන් පිළිගනිමු');
    });

    it('should fall back to English on Gemini failure', async () => {
      (generateText as jest.Mock).mockRejectedValue(
        new Error('Rate limit exceeded'),
      );

      const result = await (service as any).translateOutput(
        'Welcome to Kapruka',
        'sinhala',
      );
      expect(result).toBe('Welcome to Kapruka');
    });
  });

  describe('toUIMessages', () => {
    it('should convert mixed ModelMessages into clean UIMessages', () => {
      const dbMessages = [
        {
          role: 'user',
          content: 'Hello, search cakes',
          id: 'u1',
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Sure, searching cakes: ' },
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'kapruka_search_products',
              input: { q: 'cake' },
            },
          ],
          id: 'a1',
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 't1',
              toolName: 'kapruka_search_products',
              result: { results: [] },
            },
          ],
        },
      ];

      const uiMessages = (service as any).toUIMessages(dbMessages);

      expect(uiMessages).toHaveLength(2); // user and assistant (tool is merged)
      expect(uiMessages[0]).toEqual({
        id: 'u1',
        role: 'user',
        content: 'Hello, search cakes',
        metadata: undefined,
      });
      expect(uiMessages[1]).toEqual({
        id: 'a1',
        role: 'assistant',
        content: 'Sure, searching cakes: ',
        toolInvocations: [
          {
            state: 'result',
            toolCallId: 't1',
            toolName: 'kapruka_search_products',
            args: { q: 'cake' },
            result: { results: [] },
          },
        ],
        metadata: undefined,
      });
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChatService } from './chat.service.js';
import {
  AgentSessionEntity,
  AgentTurnEntity,
  StepTraceEntity,
} from '../database/entities/index.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { StepType } from '../database/enums/step-type.enum.js';

// Mock repositories
const mockSessionRepo = {
  findOne: jest.fn(),
  save: jest.fn().mockImplementation((val) => Promise.resolve(val)),
  create: jest.fn().mockImplementation((val) => val),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
};

const mockTurnRepo = {
  findOne: jest.fn(),
  save: jest.fn().mockImplementation((val) => Promise.resolve(val)),
  create: jest.fn().mockImplementation((val) => val),
};

const mockStepTraceRepo = {
  save: jest.fn().mockImplementation((val) => Promise.resolve(val)),
  create: jest.fn().mockImplementation((val) => val),
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
import { callMcpTool } from './mcp-client.js';

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        {
          provide: getRepositoryToken(AgentSessionEntity),
          useValue: mockSessionRepo,
        },
        {
          provide: getRepositoryToken(AgentTurnEntity),
          useValue: mockTurnRepo,
        },
        {
          provide: getRepositoryToken(StepTraceEntity),
          useValue: mockStepTraceRepo,
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
        text: 'What is this cake?',
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

    it('should detect Singlish text and mock translate', async () => {
      (generateText as jest.Mock).mockResolvedValue({
        text: 'show cakes',
      });

      const result = await (service as any).translateInput(
        'cake monada thiyenne',
      );
      expect(result).toEqual({
        translatedText: 'show cakes',
        detectedLanguage: 'singlish',
      });
    });

    it('should detect Tanglish text and mock translate', async () => {
      (generateText as jest.Mock).mockResolvedValue({
        text: 'I want a chocolate cake, is delivery available?',
      });

      const result = await (service as any).translateInput(
        'enaku chocolate cake venum, delivery iruka?',
      );
      expect(result).toEqual({
        translatedText: 'I want a chocolate cake, is delivery available?',
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
        detectedLanguage: 'sinhala',
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
        parts: [{ type: 'text', text: 'Hello, search cakes' }],
        metadata: undefined,
      });
      expect(uiMessages[1]).toEqual({
        id: 'a1',
        role: 'assistant',
        content: 'Sure, searching cakes: ',
        parts: [
          { type: 'text', text: 'Sure, searching cakes: ' },
          {
            type: 'tool-invocation',
            toolCallId: 't1',
            toolName: 'kapruka_search_products',
            args: { q: 'cake' },
            state: 'result',
            result: { results: [] },
          },
        ],
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

  describe('executeVoiceToolCall', () => {
    it('calls whitelisted MCP tools and saves a successful trace', async () => {
      const toolResult = { products: [] };
      (callMcpTool as jest.Mock).mockResolvedValue(toolResult);

      const result = await service.executeVoiceToolCall({
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        turnId: 'turn-1',
        toolName: 'kapruka_search_products',
        toolCallId: 'call-1',
        args: { query: 'tea' },
      });

      expect(result).toEqual({ ok: true, result: toolResult });
      expect(callMcpTool).toHaveBeenCalledWith('kapruka_search_products', {
        params: {
          response_format: 'json',
          query: 'tea',
        },
      });
      expect(mockStepTraceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          turnId: 'turn-1',
          stepType: StepType.MCP_TOOL_CALL,
          nodeName: 'kapruka_search_products',
          inputPayload: expect.objectContaining({
            toolCallId: 'call-1',
            params: expect.objectContaining({ query: 'tea' }),
          }),
          outputPayload: toolResult,
          isError: false,
        }),
      );
      expect(mockStepTraceRepo.save).toHaveBeenCalled();
    });

    it('rejects unknown voice tools and saves an error trace', async () => {
      const result = await service.executeVoiceToolCall({
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        turnId: 'turn-1',
        toolName: 'unsafe_tool',
        toolCallId: 'call-2',
        args: { query: 'tea' },
      });

      expect(result).toEqual({
        ok: false,
        error: 'Unsupported voice tool: unsafe_tool',
      });
      expect(callMcpTool).not.toHaveBeenCalled();
      expect(mockStepTraceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          turnId: 'turn-1',
          stepType: StepType.MCP_TOOL_CALL,
          nodeName: 'unsafe_tool',
          inputPayload: expect.objectContaining({
            query: 'tea',
            toolCallId: 'call-2',
          }),
          outputPayload: null,
          isError: true,
          errorMessage: 'Unsupported voice tool: unsafe_tool',
        }),
      );
    });
  });
});

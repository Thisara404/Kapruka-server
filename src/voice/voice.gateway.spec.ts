import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import WebSocket from 'ws';
import { ChatService } from '../chat/chat.service.js';
import { VoiceGateway } from './voice.gateway.js';

type MockListener = (...args: any[]) => void;

interface MockWebSocketInstance {
  readonly url: string;
  readonly listeners: Map<string, MockListener[]>;
  readonly sent: string[];
  readyState: number;
  emitOpen(): void;
  emitMessage(message: unknown): void;
  emitError(error: Error): void;
}

jest.mock('ws', () => ({
  __esModule: true,
  default: class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, MockListener[]>();
    readonly sent: string[] = [];
    readyState = MockWebSocket.CONNECTING;

    constructor(readonly url: string) {
      MockWebSocket.instances.push(this);
    }

    on(event: string, listener: MockListener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    send(data: string, callback?: (error?: Error) => void): void {
      this.sent.push(data);
      callback?.();
    }

    close(): void {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', 1000, Buffer.from(''));
    }

    emitOpen(): void {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open');
    }

    emitMessage(message: unknown): void {
      const payload =
        typeof message === 'string' ? message : JSON.stringify(message);
      this.emit('message', Buffer.from(payload));
    }

    emitError(error: Error): void {
      this.emit('error', error);
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  },
}));

describe('VoiceGateway', () => {
  const validSessionId = '123e4567-e89b-12d3-a456-426614174000';
  let gateway: VoiceGateway;
  let configService: { get: jest.Mock };
  let chatService: {
    findOrCreateSession: jest.Mock;
    saveInitialTurn: jest.Mock;
    executeVoiceToolCall: jest.Mock;
  };
  let jwtService: { verifyAsync: jest.Mock };
  let turnRepo: { find: jest.Mock };
  let socketCounter = 0;

  const webSocketInstances = () =>
    (
      WebSocket as unknown as {
        instances: MockWebSocketInstance[];
      }
    ).instances;

  const flush = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const makeSocket = (
    auth: Record<string, unknown> = { sessionId: validSessionId },
  ) =>
    ({
      id: `socket-${++socketCounter}`,
      connected: true,
      handshake: {
        auth,
        query: {},
        headers: {},
      },
      emit: jest.fn(),
      disconnect: jest.fn(function disconnect(this: { connected: boolean }) {
        this.connected = false;
      }),
    }) as unknown as Socket & {
      emit: jest.Mock;
      disconnect: jest.Mock;
      connected: boolean;
    };

  const latestWebSocket = () =>
    webSocketInstances()[webSocketInstances().length - 1];

  beforeEach(() => {
    webSocketInstances().length = 0;
    socketCounter = 0;
    configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          GEMINI_LIVE_API_KEY: 'test-key',
          GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview',
          GEMINI_LIVE_MAX_SESSIONS: '3',
        };
        return values[key];
      }),
    };
    chatService = {
      findOrCreateSession: jest.fn().mockResolvedValue({ id: validSessionId }),
      saveInitialTurn: jest.fn().mockResolvedValue({ id: 'turn-1' }),
      executeVoiceToolCall: jest
        .fn()
        .mockResolvedValue({ ok: true, result: { products: [] } }),
    };
    jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1' }),
    };
    turnRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    gateway = new VoiceGateway(
      configService as unknown as ConfigService,
      chatService as unknown as ChatService,
      jwtService as unknown as JwtService,
      turnRepo as any,
    );
  });

  afterEach(() => {
    gateway.onModuleDestroy();
  });

  it('rejects an invalid sessionId', async () => {
    const client = makeSocket({ sessionId: 'bad-session' });

    await gateway.handleConnection(client);
    await flush();

    expect(client.emit).toHaveBeenCalledWith('voice-status', {
      status: 'ERROR',
      error: 'INVALID_SESSION',
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(webSocketInstances()).toHaveLength(0);
  });

  it('rejects the fourth local session with LIMIT_EXHAUSTED', async () => {
    for (let index = 0; index < 3; index += 1) {
      await gateway.handleConnection(makeSocket());
    }

    const fourthClient = makeSocket();
    await gateway.handleConnection(fourthClient);
    await flush();

    expect(fourthClient.emit).toHaveBeenCalledWith('voice-status', {
      status: 'LIMIT_EXHAUSTED',
      error: 'ALL_CHANNELS_BUSY',
      retryAfterSeconds: 30,
    });
    expect(fourthClient.disconnect).toHaveBeenCalledWith(true);
    expect(webSocketInstances()).toHaveLength(3);
  });

  it('maps a Gemini 429 error to LIMIT_EXHAUSTED', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client);

    latestWebSocket().emitError(new Error('429 Resource Exhausted'));
    await flush();

    expect(client.emit).toHaveBeenCalledWith('voice-status', {
      status: 'LIMIT_EXHAUSTED',
      error: 'ALL_CHANNELS_BUSY',
      retryAfterSeconds: 30,
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('returns NOT_READY when audio arrives before setupComplete', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client);

    gateway.handleAudioInput(client, Buffer.from([1, 2, 3]));

    expect(client.emit).toHaveBeenCalledWith('voice-status', {
      status: 'ERROR',
      error: 'NOT_READY',
    });
  });

  it('forwards ready audio chunks with the Gemini realtimeInput schema', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client);
    const googleSocket = latestWebSocket();

    googleSocket.emitOpen();
    googleSocket.emitMessage({ setupComplete: {} });
    gateway.handleAudioInput(client, Buffer.from([1, 2, 3]));

    const realtimeInput = JSON.parse(
      googleSocket.sent[googleSocket.sent.length - 1],
    );
    expect(client.emit).toHaveBeenCalledWith('voice-status', {
      status: 'READY',
    });
    expect(realtimeInput).toEqual({
      realtimeInput: {
        audio: {
          data: Buffer.from([1, 2, 3]).toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    });
  });

  it('hydrates the Gemini setup frame with chronological chat history', async () => {
    turnRepo.find.mockResolvedValue([
      {
        sessionId: validSessionId,
        userPrompt: 'mata tea ona',
        finalAgentResponse: 'Menna tea items dekak.',
        metadata: {
          originalText: 'mata tea ona',
          englishText: 'I want tea',
          detectedLanguage: 'singlish',
          assistantEnglishText: 'Here are two tea items.',
        },
        createdAt: new Date('2026-06-18T10:01:00.000Z'),
      },
      {
        sessionId: validSessionId,
        userPrompt: 'Show me categories',
        finalAgentResponse: 'Here are 11 categories: Cakes, Flowers, Tea.',
        metadata: null,
        createdAt: new Date('2026-06-18T10:00:00.000Z'),
      },
    ]);
    const client = makeSocket();

    await gateway.handleConnection(client);
    const googleSocket = latestWebSocket();
    googleSocket.emitOpen();

    expect(turnRepo.find).toHaveBeenCalledWith({
      where: expect.objectContaining({
        sessionId: validSessionId,
        userPrompt: expect.any(Object),
        finalAgentResponse: expect.any(Object),
      }),
      order: { createdAt: 'DESC' },
      take: 8,
    });
    expect(
      chatService.saveInitialTurn.mock.invocationCallOrder[0],
    ).toBeGreaterThan(turnRepo.find.mock.invocationCallOrder[0]);

    const setupMessage = JSON.parse(googleSocket.sent[0]);
    expect(setupMessage.setup.model).toBe(
      'models/gemini-3.1-flash-live-preview',
    );
    expect(setupMessage.setup.generationConfig).toEqual({
      responseModalities: ['AUDIO'],
      candidateCount: 1,
    });
    expect(setupMessage.setup.systemInstruction.parts[0].text).toContain(
      'strictly forbidden from writing or reciting lists of specific products',
    );
    expect(setupMessage.setup.tools[0].functionDeclarations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'kapruka_search_products' }),
        expect.objectContaining({ name: 'kapruka_list_categories' }),
        expect.objectContaining({ name: 'kapruka_create_order' }),
      ]),
    );
    expect(setupMessage.setup.history).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Show me categories' }],
      },
      {
        role: 'model',
        parts: [{ text: 'Here are 11 categories: Cakes, Flowers, Tea.' }],
      },
      {
        role: 'user',
        parts: [
          {
            text: [
              'User message (singlish): mata tea ona',
              'English meaning: I want tea',
            ].join('\n'),
          },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            text: [
              'Assistant response shown to user: Menna tea items dekak.',
              'English source: Here are two tea items.',
            ].join('\n'),
          },
        ],
      },
    ]);
  });

  it('does not duplicate a models/ prefix from GEMINI_LIVE_MODEL', async () => {
    configService.get.mockImplementation((key: string) => {
      const values: Record<string, string> = {
        GEMINI_LIVE_API_KEY: 'test-key',
        GEMINI_LIVE_MODEL: 'models/gemini-3.1-flash-live-preview',
        GEMINI_LIVE_MAX_SESSIONS: '3',
      };
      return values[key];
    });
    const client = makeSocket();

    await gateway.handleConnection(client);
    const googleSocket = latestWebSocket();
    googleSocket.emitOpen();

    const setupMessage = JSON.parse(googleSocket.sent[0]);
    expect(setupMessage.setup.model).toBe(
      'models/gemini-3.1-flash-live-preview',
    );
  });

  it('emits Gemini inlineData audio as audio-output Buffer', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client);
    const googleSocket = latestWebSocket();
    const audio = Buffer.from([9, 8, 7]);

    googleSocket.emitOpen();
    googleSocket.emitMessage({ setupComplete: {} });
    googleSocket.emitMessage({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: audio.toString('base64'),
                mimeType: 'audio/pcm;rate=24000',
              },
            },
          ],
        },
      },
    });

    expect(client.emit).toHaveBeenCalledWith('audio-output', audio);
  });

  it('routes Gemini tool calls through ChatService and sends toolResponse', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client);
    const googleSocket = latestWebSocket();

    googleSocket.emitOpen();
    googleSocket.emitMessage({ setupComplete: {} });
    googleSocket.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'call-1',
            name: 'kapruka_search_products',
            args: { query: 'tea' },
          },
        ],
      },
    });
    await flush();

    expect(chatService.executeVoiceToolCall).toHaveBeenCalledWith({
      sessionId: validSessionId,
      turnId: 'turn-1',
      toolName: 'kapruka_search_products',
      toolCallId: 'call-1',
      args: { query: 'tea' },
    });

    const toolResponse = JSON.parse(
      googleSocket.sent[googleSocket.sent.length - 1],
    );
    expect(toolResponse).toEqual({
      toolResponse: {
        functionResponses: [
          {
            name: 'kapruka_search_products',
            id: 'call-1',
            response: { result: { products: [] } },
          },
        ],
      },
    });
  });

  it('pauses server content forwarding while a tool call is in flight', async () => {
    let resolveToolCall: (value: { ok: true; result: { products: never[] } }) => void;
    chatService.executeVoiceToolCall.mockReturnValue(
      new Promise((resolve) => {
        resolveToolCall = resolve;
      }),
    );
    const client = makeSocket();
    await gateway.handleConnection(client);
    const googleSocket = latestWebSocket();

    googleSocket.emitOpen();
    googleSocket.emitMessage({ setupComplete: {} });
    googleSocket.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'call-2',
            name: 'kapruka_search_products',
            args: { query: 'flowers' },
          },
        ],
      },
    });
    googleSocket.emitMessage({
      serverContent: {
        modelTurn: {
          parts: [{ text: 'Here are product options that should not leak.' }],
        },
      },
    });

    expect(client.emit).not.toHaveBeenCalledWith('voice-transcript', {
      source: 'model',
      text: 'Here are product options that should not leak.',
    });

    resolveToolCall!({ ok: true, result: { products: [] } });
    await flush();

    const toolResponse = JSON.parse(
      googleSocket.sent[googleSocket.sent.length - 1],
    );
    expect(toolResponse.toolResponse.functionResponses[0]).toEqual({
      name: 'kapruka_search_products',
      id: 'call-2',
      response: { result: { products: [] } },
    });
  });
});

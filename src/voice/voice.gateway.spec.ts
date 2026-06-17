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
    gateway = new VoiceGateway(
      configService as unknown as ConfigService,
      chatService as unknown as ChatService,
      jwtService as unknown as JwtService,
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
            id: 'call-1',
            response: { output: { products: [] } },
          },
        ],
      },
    });
  });
});

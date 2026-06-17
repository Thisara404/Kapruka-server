import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import WebSocket, { type RawData } from 'ws';
import { ChatService } from '../chat/chat.service.js';
import {
  DEFAULT_GEMINI_LIVE_MAX_SESSIONS,
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_MAX_AUDIO_CHUNK_BYTES,
  GEMINI_AUDIO_INPUT_MIME_TYPE,
  GEMINI_LIVE_WS_ENDPOINT,
} from './voice.constants.js';
import type {
  GeminiLiveClientMessage,
  GeminiLiveFunctionCall,
  GeminiLiveFunctionResponse,
  GeminiLiveServerMessage,
} from './gemini-live.types.js';
import type {
  ActiveVoiceSession,
  VoiceAuthPayload,
  VoiceStatusPayload,
  VoiceTranscriptPayload,
} from './voice.types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@WebSocketGateway({
  namespace: '/voice',
  cors: { origin: '*' },
})
export class VoiceGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(VoiceGateway.name);
  private readonly sessions = new Map<string, ActiveVoiceSession>();
  private reservedSessions = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const auth = this.getAuthPayload(client);
    const sessionId = auth.sessionId;

    if (!sessionId || !UUID_RE.test(sessionId)) {
      this.emitStatus(client, { status: 'ERROR', error: 'INVALID_SESSION' });
      this.disconnectClient(client);
      return;
    }

    if (this.reservedSessions >= this.getMaxSessions()) {
      this.rejectForLimit(client);
      return;
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      this.emitStatus(client, {
        status: 'ERROR',
        error: 'MISSING_GEMINI_API_KEY',
      });
      this.disconnectClient(client);
      return;
    }

    this.reservedSessions += 1;
    this.emitStatus(client, { status: 'CONNECTING' });

    try {
      const userId = await this.resolveUserId(auth.token);
      await this.chatService.findOrCreateSession(sessionId, userId);
      const turn = await this.chatService.saveInitialTurn(
        sessionId,
        '[voice session]',
        { channel: 'voice', socketId: client.id },
      );

      const googleSocket = new WebSocket(this.buildGeminiUrl(apiKey));
      const state: ActiveVoiceSession = {
        socketId: client.id,
        sessionId,
        turnId: turn.id,
        userId,
        googleSocket,
        isReady: false,
        isReleased: false,
        createdAt: Date.now(),
      };

      this.sessions.set(client.id, state);
      this.bindGeminiSocket(client, state);
    } catch (error) {
      this.reservedSessions -= 1;
      this.logger.warn(
        `Voice connection setup failed for ${client.id}: ${this.errorMessage(
          error,
        )}`,
      );
      this.emitStatus(client, {
        status: 'ERROR',
        error: this.isAuthError(error) ? 'AUTH_INVALID' : 'CONNECTION_FAILED',
      });
      this.disconnectClient(client);
    }
  }

  handleDisconnect(client: Socket): void {
    this.releaseSession(client.id, true);
  }

  onModuleDestroy(): void {
    for (const socketId of this.sessions.keys()) {
      this.releaseSession(socketId, true);
    }
  }

  @SubscribeMessage('audio-input')
  handleAudioInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: unknown,
  ): void {
    const state = this.sessions.get(client.id);
    if (!state || !state.isReady) {
      this.emitStatus(client, { status: 'ERROR', error: 'NOT_READY' });
      return;
    }

    if (state.googleSocket.readyState !== WebSocket.OPEN) {
      this.emitStatus(client, {
        status: 'ERROR',
        error: 'GEMINI_SOCKET_CLOSED',
      });
      return;
    }

    const audioBuffer = this.toAudioBuffer(payload);
    if (!audioBuffer || audioBuffer.length === 0) {
      this.emitStatus(client, { status: 'ERROR', error: 'INVALID_AUDIO' });
      return;
    }

    if (audioBuffer.length > this.getMaxAudioChunkBytes()) {
      this.emitStatus(client, {
        status: 'ERROR',
        error: 'AUDIO_CHUNK_TOO_LARGE',
      });
      return;
    }

    this.sendGemini(state, {
      realtimeInput: {
        audio: {
          data: audioBuffer.toString('base64'),
          mimeType: GEMINI_AUDIO_INPUT_MIME_TYPE,
        },
      },
    });
  }

  private bindGeminiSocket(client: Socket, state: ActiveVoiceSession): void {
    state.googleSocket.on('open', () => {
      this.sendGemini(state, this.buildSetupMessage());
    });

    state.googleSocket.on('message', (data) => {
      void this.handleGeminiMessage(client, state, data);
    });

    state.googleSocket.on('error', (error) => {
      const message = this.errorMessage(error);
      if (this.isLimitError(message)) {
        this.rejectForLimit(client);
      } else {
        this.logger.warn(`Gemini live socket error: ${message}`);
        this.emitStatus(client, { status: 'ERROR', error: 'GEMINI_ERROR' });
        this.disconnectClient(client);
      }
      this.releaseSession(client.id, true);
    });

    state.googleSocket.on('close', (_code, reason) => {
      const reasonText = reason.toString('utf8');
      if (this.isLimitError(reasonText)) {
        this.rejectForLimit(client);
      } else if (this.sessions.has(client.id)) {
        this.emitStatus(client, { status: 'CLOSED' });
      }
      this.releaseSession(client.id, false);
      this.disconnectClient(client);
    });
  }

  private async handleGeminiMessage(
    client: Socket,
    state: ActiveVoiceSession,
    data: RawData,
  ): Promise<void> {
    const rawText = this.rawDataToText(data);
    if (this.isLimitError(rawText)) {
      this.rejectForLimit(client);
      this.releaseSession(client.id, true);
      return;
    }

    let message: GeminiLiveServerMessage;
    try {
      message = JSON.parse(rawText) as GeminiLiveServerMessage;
    } catch {
      this.logger.debug(`Ignoring non-JSON Gemini live frame for ${client.id}`);
      return;
    }

    if (message.error) {
      const errorText = [
        message.error.code,
        message.error.status,
        message.error.message,
      ]
        .filter(Boolean)
        .join(' ');
      if (this.isLimitError(errorText)) {
        this.rejectForLimit(client);
      } else {
        this.emitStatus(client, { status: 'ERROR', error: 'GEMINI_ERROR' });
      }
      this.releaseSession(client.id, true);
      this.disconnectClient(client);
      return;
    }

    if (message.setupComplete) {
      state.isReady = true;
      this.emitStatus(client, { status: 'READY' });
    }

    if (message.toolCall) {
      await this.handleToolCall(state, message.toolCall.functionCalls ?? []);
      return; // Intercept immediately and halt downstream audio-out emissions
    }

    if (message.serverContent) {
      this.forwardServerContent(client, message);
    }
  }

  private forwardServerContent(
    client: Socket,
    message: GeminiLiveServerMessage,
  ): void {
    const content = message.serverContent;
    if (!content) return;

    if (content.outputTranscription?.text) {
      this.emitTranscript(client, {
        source: 'model',
        text: content.outputTranscription.text,
      });
    }

    if (content.inputTranscription?.text) {
      this.emitTranscript(client, {
        source: 'input',
        text: content.inputTranscription.text,
      });
    }

    for (const part of content.modelTurn?.parts ?? []) {
      if (part.text) {
        this.emitTranscript(client, { source: 'model', text: part.text });
      }

      if (part.inlineData?.data) {
        client.emit(
          'audio-output',
          Buffer.from(part.inlineData.data, 'base64'),
        );
      }
    }
  }

  private async handleToolCall(
    state: ActiveVoiceSession,
    functionCalls: GeminiLiveFunctionCall[],
  ): Promise<void> {
    const functionResponses: GeminiLiveFunctionResponse[] = [];

    for (const functionCall of functionCalls) {
      const toolName = functionCall.name ?? 'unknown';
      const toolCallId =
        functionCall.id ??
        `${toolName}-${Date.now()}-${functionResponses.length}`;
      const args = this.isRecord(functionCall.args) ? functionCall.args : {};

      const result = await this.chatService.executeVoiceToolCall({
        sessionId: state.sessionId,
        turnId: state.turnId,
        toolName,
        toolCallId,
        args,
      });

      functionResponses.push({
        id: toolCallId,
        response: result.ok
          ? { output: result.result ?? null }
          : { error: result.error ?? 'TOOL_FAILED' },
      });
    }

    if (functionResponses.length > 0) {
      this.sendGemini(state, {
        toolResponse: { functionResponses },
      });
    }
  }

  private buildSetupMessage(): GeminiLiveClientMessage {
    return {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
        },
        systemInstruction: {
          parts: [
            {
              text: "You are Thisari, an empathetic Kapruka shopping assistant. You have access to real-time inventory and delivery tools. If a user asks for an item, cake, flowers, or essentials, you MUST call the appropriate tool instantly without explaining your internal actions to the user or asking for permission. You converse in the user's language, but your internal tool arguments must be translated into English queries. Kapruka search results are paginated. Maintain an internal conversational state tracking which items have already been introduced. If the user rejects the first batch of items or requests more variety, you MUST execute `kapruka_search_products` again, keeping the exact same English search keyword, but incrementing the `page` argument by 1. Never stream the exact same list of product IDs back-to-back.",
            },
          ],
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'kapruka_search_products',
                description:
                  'Search Kapruka products by query/keyword. Keep search queries in English.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    q: {
                      type: 'STRING',
                      description:
                        "The extracted product search keyword translated to English, e.g., 'red flowers', 'birthday cake'.",
                    },
                    page: {
                      type: 'INTEGER',
                      description:
                        "The page number of product results to fetch. Defaults to 1. Increment this value by 1 when the user explicitly requests more alternatives, says 'next page', 'show me other options', or implies they want to see more items than what was previously shown.",
                    },
                  },
                  required: ['q'],
                },
              },
              {
                name: 'kapruka_check_delivery',
                description:
                  'Check whether Kapruka can deliver to a Sri Lankan city on a specific date.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    city: {
                      type: 'STRING',
                      description: 'The target city name in Sri Lanka.',
                    },
                    date: {
                      type: 'STRING',
                      description:
                        'The target delivery date in YYYY-MM-DD format.',
                    },
                    productId: {
                      type: 'STRING',
                      description:
                        'Optional product ID to check delivery eligibility for.',
                    },
                  },
                  required: ['city', 'date'],
                },
              },
            ],
          },
        ],
      },
    };
  }

  private sendGemini(
    state: ActiveVoiceSession,
    message: GeminiLiveClientMessage,
  ): void {
    if (state.googleSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    state.googleSocket.send(JSON.stringify(message), (error) => {
      if (error) {
        this.logger.warn(
          `Gemini live send failed: ${this.errorMessage(error)}`,
        );
      }
    });
  }

  private releaseSession(socketId: string, closeVendor: boolean): void {
    const state = this.sessions.get(socketId);
    if (!state || state.isReleased) return;

    state.isReleased = true;
    this.sessions.delete(socketId);
    this.reservedSessions = Math.max(0, this.reservedSessions - 1);

    if (
      closeVendor &&
      state.googleSocket.readyState !== WebSocket.CLOSING &&
      state.googleSocket.readyState !== WebSocket.CLOSED
    ) {
      state.googleSocket.close();
    }
  }

  private rejectForLimit(client: Socket): void {
    this.emitStatus(client, {
      status: 'LIMIT_EXHAUSTED',
      error: 'ALL_CHANNELS_BUSY',
    });
    this.disconnectClient(client);
  }

  private emitStatus(client: Socket, payload: VoiceStatusPayload): void {
    client.emit('voice-status', payload);
  }

  private emitTranscript(
    client: Socket,
    payload: VoiceTranscriptPayload,
  ): void {
    client.emit('voice-transcript', payload);
  }

  private disconnectClient(client: Socket): void {
    setImmediate(() => {
      if (client.connected) {
        client.disconnect(true);
      }
    });
  }

  private getAuthPayload(client: Socket): VoiceAuthPayload {
    const auth = this.isRecord(client.handshake.auth)
      ? client.handshake.auth
      : {};
    const query = this.isRecord(client.handshake.query)
      ? client.handshake.query
      : {};
    const authorization = client.handshake.headers.authorization;

    const sessionId =
      this.stringValue(auth.sessionId) ?? this.stringValue(query.sessionId);
    const token =
      this.stringValue(auth.token) ??
      this.stringValue(query.token) ??
      this.bearerToken(authorization);

    return { sessionId, token };
  }

  private async resolveUserId(token?: string): Promise<string | undefined> {
    if (!token) return undefined;

    const payload = await this.jwtService.verifyAsync<{ sub?: unknown }>(token);
    return typeof payload.sub === 'string' ? payload.sub : undefined;
  }

  private buildGeminiUrl(apiKey: string): string {
    const url = new URL(GEMINI_LIVE_WS_ENDPOINT);
    url.searchParams.set('key', apiKey);
    return url.toString();
  }

  private getApiKey(): string | undefined {
    return (
      this.configService.get<string>('GEMINI_LIVE_API_KEY') ??
      this.configService.get<string>('GOOGLE_GENERATIVE_AI_API_KEY')
    );
  }

  private getModel(): string {
    return (
      this.configService.get<string>('GEMINI_LIVE_MODEL') ??
      DEFAULT_GEMINI_LIVE_MODEL
    );
  }

  private getMaxSessions(): number {
    const configured = Number(
      this.configService.get<string>('GEMINI_LIVE_MAX_SESSIONS'),
    );
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_GEMINI_LIVE_MAX_SESSIONS;
  }

  private getMaxAudioChunkBytes(): number {
    const configured = Number(
      this.configService.get<string>('GEMINI_LIVE_MAX_AUDIO_CHUNK_BYTES'),
    );
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_AUDIO_CHUNK_BYTES;
  }

  private toAudioBuffer(payload: unknown): Buffer | null {
    if (Buffer.isBuffer(payload)) return payload;
    if (payload instanceof ArrayBuffer) return Buffer.from(payload);
    if (ArrayBuffer.isView(payload)) {
      return Buffer.from(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
      );
    }

    if (Array.isArray(payload) && payload.every((item) => this.isByte(item))) {
      return Buffer.from(payload);
    }

    if (
      this.isRecord(payload) &&
      payload.type === 'Buffer' &&
      Array.isArray(payload.data) &&
      payload.data.every((item) => this.isByte(item))
    ) {
      return Buffer.from(payload.data);
    }

    return null;
  }

  private rawDataToText(data: RawData): string {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return Buffer.from(data).toString('utf8');
  }

  private isLimitError(value: unknown): boolean {
    const text = this.errorMessage(value).toLowerCase();
    return (
      text.includes('429') ||
      text.includes('resource exhausted') ||
      text.includes('quota') ||
      text.includes('too many') ||
      text.includes('all_channels_busy')
    );
  }

  private isAuthError(value: unknown): boolean {
    const text = this.errorMessage(value).toLowerCase();
    return (
      text.includes('jwt') ||
      text.includes('token') ||
      text.includes('signature') ||
      text.includes('expired')
    );
  }

  private bearerToken(
    value: string | string[] | undefined,
  ): string | undefined {
    const header = Array.isArray(value) ? value[0] : value;
    if (!header) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match?.[1];
  }

  private stringValue(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return this.stringValue(value[0]);
    }
    return undefined;
  }

  private errorMessage(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return value.toString();
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isByte(value: unknown): value is number {
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 255
    );
  }
}

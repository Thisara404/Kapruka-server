import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { IsNull, Not, Repository } from 'typeorm';
import WebSocket, { type RawData } from 'ws';
import { ChatService } from '../chat/chat.service.js';
import { AgentTurnEntity } from '../database/entities/index.js';
import {
  DEFAULT_GEMINI_LIVE_MAX_SESSIONS,
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_MAX_AUDIO_CHUNK_BYTES,
  GEMINI_AUDIO_INPUT_MIME_TYPE,
  GEMINI_LIVE_TOOL_DECLARATIONS,
  GEMINI_LIVE_WS_ENDPOINT,
  THISARI_VOICE_SYSTEM_INSTRUCTION,
} from './voice.constants.js';
import type {
  GeminiLiveClientMessage,
  GeminiLiveContent,
  GeminiLiveFunctionCall,
  GeminiLiveFunctionResponse,
  GeminiLiveServerMessage,
} from './gemini-live.types.js';
import type {
  ActiveVoiceSession,
  VoiceAuthPayload,
  VoiceStatusPayload,
  VoiceToolResultPayload,
  VoiceTranscriptPayload,
} from './voice.types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_HISTORY_TURN_LIMIT = 8;
const MIN_HISTORY_TURN_LIMIT = 6;
const MAX_HISTORY_TURN_LIMIT = 10;

@WebSocketGateway({
  namespace: '/voice',
  path: '/voice/socket.io',
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
    @InjectRepository(AgentTurnEntity)
    private readonly turnRepo: Repository<AgentTurnEntity>,
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
      const history = await this.loadGeminiHistory(sessionId);
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
        history,
        isReady: false,
        isToolCallInFlight: false,
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

    state.googleSocket.on('close', (code, reason) => {
      const reasonText = reason.toString('utf8');
      if (this.isLimitError(reasonText)) {
        this.rejectForLimit(client);
      } else if (this.sessions.has(client.id)) {
        this.logger.warn(
          `Gemini live socket closed ${state.isReady ? 'after READY' : 'before setupComplete'}: code=${code}, reason=${reasonText || 'empty'}`,
        );
        this.emitStatus(client, {
          status: 'ERROR',
          error: reasonText
            ? `GEMINI_CLOSED: ${reasonText}`
            : `GEMINI_CLOSED_${code}`,
          retryAfterSeconds: 30,
        });
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
      this.hydrateGeminiHistory(state);
      state.isReady = true;
      this.emitStatus(client, { status: 'READY' });
    }

    if (message.toolCall) {
      state.isToolCallInFlight = true;
      try {
        await this.handleToolCall(
          client,
          state,
          message.toolCall.functionCalls ?? [],
        );
      } finally {
        state.isToolCallInFlight = false;
      }
      return; // Intercept immediately and halt downstream audio-out emissions
    }

    if (message.serverContent) {
      if (state.isToolCallInFlight) {
        return;
      }
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
    client: Socket,
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

      this.emitToolResult(client, {
        toolCallId,
        toolName,
        state: result.ok ? 'result' : 'error',
        result: result.result ?? null,
        error: result.error,
      });

      functionResponses.push({
        name: toolName,
        id: toolCallId,
        response: result.ok
          ? { result: result.result ?? null }
          : { error: result.error ?? 'TOOL_FAILED' },
      });
    }

    if (functionResponses.length > 0) {
      this.sendGemini(state, {
        toolResponse: { functionResponses },
      });
    }
  }

  private emitToolResult(
    client: Socket,
    payload: VoiceToolResultPayload,
  ): void {
    client.emit('voice-tool-result', payload);
  }

  private buildSetupMessage(): GeminiLiveClientMessage {
    return {
      setup: {
        model: this.getModelPath(),
        generationConfig: {
          responseModalities: ['AUDIO'],
          candidateCount: 1,
        },
        systemInstruction: {
          parts: [
            {
              text: THISARI_VOICE_SYSTEM_INSTRUCTION,
            },
          ],
        },
        tools: [
          {
            functionDeclarations: GEMINI_LIVE_TOOL_DECLARATIONS,
          },
        ],
      },
    };
  }

  private hydrateGeminiHistory(state: ActiveVoiceSession): void {
    if (state.history.length === 0) {
      return;
    }

    this.sendGemini(state, {
      clientContent: {
        turns: state.history,
        turnComplete: false,
      },
    });
  }

  private async loadGeminiHistory(
    sessionId: string,
  ): Promise<GeminiLiveContent[]> {
    const turns = await this.turnRepo.find({
      where: {
        sessionId,
        userPrompt: Not('[voice session]'),
        finalAgentResponse: Not(IsNull()),
      },
      order: { createdAt: 'DESC' },
      take: this.getHistoryTurnLimit(),
    });

    return this.mapTurnsToGeminiHistory(turns.reverse());
  }

  private mapTurnsToGeminiHistory(
    turns: AgentTurnEntity[],
  ): GeminiLiveContent[] {
    const history: GeminiLiveContent[] = [];

    for (const turn of turns) {
      const userText = this.formatUserHistoryText(turn);
      if (userText) {
        history.push({ role: 'user', parts: [{ text: userText }] });
      }

      const modelText = this.formatModelHistoryText(turn);
      if (modelText) {
        history.push({ role: 'model', parts: [{ text: modelText }] });
      }
    }

    return history;
  }

  private formatUserHistoryText(turn: AgentTurnEntity): string | undefined {
    const prompt = turn.userPrompt?.trim();
    if (!prompt || prompt === '[voice session]') return undefined;

    const metadata = turn.metadata ?? {};
    const originalText = this.stringValue(metadata.originalText) ?? prompt;
    const englishText = this.stringValue(metadata.englishText);
    const detectedLanguage = this.stringValue(metadata.detectedLanguage);

    if (englishText && englishText !== originalText) {
      return [
        `User message${detectedLanguage ? ` (${detectedLanguage})` : ''}: ${originalText}`,
        `English meaning: ${englishText}`,
      ].join('\n');
    }

    return originalText;
  }

  private formatModelHistoryText(turn: AgentTurnEntity): string | undefined {
    const response = turn.finalAgentResponse?.trim();
    if (!response) return undefined;

    const metadata = turn.metadata ?? {};
    const englishText =
      this.stringValue(metadata.assistantEnglishText) ??
      this.stringValue(metadata.englishText);

    if (englishText && englishText !== response) {
      return [
        `Assistant response shown to user: ${response}`,
        `English source: ${englishText}`,
      ].join('\n');
    }

    return response;
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
      retryAfterSeconds: 30,
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
    const headerSessionId =
      this.stringValue(client.handshake.headers['x-session-id']) ??
      this.stringValue(client.handshake.headers['session-id']) ??
      this.stringValue(client.handshake.headers['x-kapruka-session-id']);

    const sessionId =
      this.stringValue(auth.sessionId) ??
      this.stringValue(query.sessionId) ??
      headerSessionId;
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

  private getModelPath(): string {
    const model = this.getModel().trim();
    return model.startsWith('models/') ? model : `models/${model}`;
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

  private getHistoryTurnLimit(): number {
    const configured = Number(
      this.configService.get<string>('GEMINI_LIVE_HISTORY_TURNS'),
    );
    if (!Number.isFinite(configured) || configured <= 0) {
      return DEFAULT_HISTORY_TURN_LIMIT;
    }
    return Math.min(
      MAX_HISTORY_TURN_LIMIT,
      Math.max(MIN_HISTORY_TURN_LIMIT, Math.floor(configured)),
    );
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

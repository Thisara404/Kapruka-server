import type WebSocket from 'ws';
import type { GeminiLiveContent } from './gemini-live.types.js';

export type VoiceStatus =
  | 'CONNECTING'
  | 'READY'
  | 'ERROR'
  | 'LIMIT_EXHAUSTED'
  | 'CLOSED';

export type VoiceStatusPayload =
  | { status: 'CONNECTING' | 'READY' | 'CLOSED' }
  | { status: 'ERROR'; error: string }
  | {
      status: 'LIMIT_EXHAUSTED';
      error: 'ALL_CHANNELS_BUSY';
      retryAfterSeconds?: number;
    };

export interface VoiceAuthPayload {
  sessionId?: string;
  token?: string;
}

export interface VoiceTranscriptPayload {
  source: 'input' | 'model';
  text: string;
}

export interface ActiveVoiceSession {
  socketId: string;
  sessionId: string;
  turnId: string;
  userId?: string;
  googleSocket: WebSocket;
  history: GeminiLiveContent[];
  isReady: boolean;
  isToolCallInFlight: boolean;
  isReleased: boolean;
  createdAt: number;
}

export interface VoiceToolCallInput {
  sessionId: string;
  turnId: string;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

export interface VoiceToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

import type WebSocket from 'ws';
import type { GeminiLiveContent } from './gemini-live.types.js';

export type VoiceStatus =
  | 'CONNECTING'
  | 'READY'
  | 'ERROR'
  | 'CAPACITY_EXHAUSTED'
  | 'QUOTA_EXHAUSTED'
  | 'CLOSED';

export type VoiceStatusPayload =
  | { status: 'CONNECTING' | 'READY' | 'CLOSED' }
  | { status: 'ERROR'; error: string; retryAfterSeconds?: number }
  | {
      status: 'CAPACITY_EXHAUSTED';
      error: 'LOCAL_SESSION_LIMIT';
      retryAfterSeconds?: number;
    }
  | {
      status: 'QUOTA_EXHAUSTED';
      error: 'GEMINI_QUOTA_EXHAUSTED';
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

export interface VoiceToolResultPayload {
  toolCallId: string;
  toolName: string;
  state: 'result' | 'error';
  result?: unknown;
  error?: string;
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
  lastClientMessageKind?: string;
  lastClientMessageAt?: number;
  geminiCloseCode?: number;
  geminiCloseReason?: string;
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

export interface VoiceAutomationRedirectPayload {
  url: string;
}

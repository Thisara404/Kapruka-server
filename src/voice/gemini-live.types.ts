export type GeminiLiveResponseModality = 'AUDIO' | 'TEXT';

export type GeminiLiveSchemaType =
  | 'OBJECT'
  | 'ARRAY'
  | 'STRING'
  | 'NUMBER'
  | 'INTEGER'
  | 'BOOLEAN';

export interface GeminiLiveJsonSchema {
  type: GeminiLiveSchemaType;
  description?: string;
  properties?: Record<string, GeminiLiveJsonSchema>;
  items?: GeminiLiveJsonSchema;
  required?: string[];
}

export interface GeminiLiveFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiLiveJsonSchema;
}

export interface GeminiLiveSetupMessage {
  setup: {
    model: string;
    generationConfig: {
      responseModalities: GeminiLiveResponseModality[];
    };
    systemInstruction: {
      parts: Array<{ text: string }>;
    };
    tools: Array<{
      functionDeclarations: GeminiLiveFunctionDeclaration[];
    }>;
  };
}

export interface GeminiLiveRealtimeInputMessage {
  realtimeInput: {
    audio: {
      data: string;
      mimeType: string;
    };
  };
}

export interface GeminiLiveInlineData {
  data?: string;
  mimeType?: string;
}

export interface GeminiLivePart {
  text?: string;
  inlineData?: GeminiLiveInlineData;
}

export interface GeminiLiveFunctionCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface GeminiLiveToolCall {
  functionCalls?: GeminiLiveFunctionCall[];
}

export interface GeminiLiveServerContent {
  modelTurn?: {
    parts?: GeminiLivePart[];
  };
  outputTranscription?: {
    text?: string;
  };
  inputTranscription?: {
    text?: string;
  };
  interrupted?: boolean;
  turnComplete?: boolean;
}

export interface GeminiLiveError {
  code?: number;
  status?: string;
  message?: string;
}

export interface GeminiLiveServerMessage {
  setupComplete?: Record<string, never>;
  serverContent?: GeminiLiveServerContent;
  toolCall?: GeminiLiveToolCall;
  error?: GeminiLiveError;
}

export interface GeminiLiveFunctionResponse {
  name?: string;
  id?: string;
  response: {
    output?: unknown;
    result?: unknown;
    error?: string;
  };
}

export interface GeminiLiveToolResponseMessage {
  toolResponse: {
    functionResponses: GeminiLiveFunctionResponse[];
  };
}

export type GeminiLiveClientMessage =
  | GeminiLiveSetupMessage
  | GeminiLiveRealtimeInputMessage
  | GeminiLiveToolResponseMessage;

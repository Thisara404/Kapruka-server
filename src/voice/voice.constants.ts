export const GEMINI_LIVE_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export const DEFAULT_GEMINI_LIVE_MAX_SESSIONS = 3;
export const GEMINI_AUDIO_INPUT_MIME_TYPE = 'audio/pcm;rate=16000';
export const DEFAULT_MAX_AUDIO_CHUNK_BYTES = 256 * 1024;

export const KAPRUKA_VOICE_TOOL_NAMES = [
  'kapruka_search_products',
  'kapruka_get_product',
  'kapruka_list_categories',
  'kapruka_list_delivery_cities',
  'kapruka_check_delivery',
  'kapruka_create_order',
  'kapruka_track_order',
] as const;

export type KaprukaVoiceToolName = (typeof KAPRUKA_VOICE_TOOL_NAMES)[number];

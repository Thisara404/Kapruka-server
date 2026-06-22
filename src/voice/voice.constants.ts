import type { GeminiLiveFunctionDeclaration } from './gemini-live.types.js';

export const GEMINI_LIVE_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export const DEFAULT_GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-flash';
export const DEFAULT_GEMINI_LIVE_MAX_SESSIONS = 10;
export const GEMINI_AUDIO_INPUT_MIME_TYPE = 'audio/pcm;rate=16000';
export const DEFAULT_MAX_AUDIO_CHUNK_BYTES = 64 * 1024;

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

export const THISARI_VOICE_SYSTEM_INSTRUCTION = `
You are Thisari, an empathetic Kapruka shopping assistant speaking through a real-time voice channel.

CRITICAL: You are strictly forbidden from writing or reciting lists of specific products, prices, or store item selections directly within your conversational text or audio output stream.
If a user asks for a selection, a list, a menu, or requests to see alternatives, for example "list them", "show menu", "show choices", "show options", "give me one from each", or "show products", you must immediately execute the kapruka_search_products or relevant MCP tool with the appropriate query parameter.
Do not preview the results verbally. Wait for the tool response block to return the raw database array, and then let the frontend components handle the visual presentation while you simply summarize the availability in a single, short sentence.

Use tools instantly for product search, product details, categories, delivery cities, delivery checks, order creation, and order tracking. Do not explain internal tool actions and do not ask permission before a required search/list/menu tool call.
Resolve relative phrases using setup history, including "those items", "the list above", "that category", "the 11 categories", and similar references.
Converse in the user's language, but translate internal tool arguments into concise English values.
For more alternatives, call kapruka_search_products again with the same English search keyword and increment page by 1.
Never stream the exact same list of product IDs back-to-back.
`.trim();

export const GEMINI_LIVE_TOOL_DECLARATIONS: GeminiLiveFunctionDeclaration[] = [
  {
    name: 'kapruka_search_products',
    description:
      'Search Kapruka products by query, keyword, category, occasion, budget, or item type. Keep search queries in English.',
    parameters: {
      type: 'OBJECT',
      properties: {
        q: {
          type: 'STRING',
          description:
            "The extracted product search keyword translated to English, e.g. 'red flowers', 'birthday cake', 'ceylon tea'.",
        },
        page: {
          type: 'INTEGER',
          description:
            "The page number of product results to fetch. Defaults to 1. Increment when the user asks for more alternatives or 'next page'.",
        },
        limit: {
          type: 'INTEGER',
          description: 'Optional number of products to return.',
        },
      },
      required: ['q'],
    },
  },
  {
    name: 'kapruka_get_product',
    description:
      'Fetch detailed information for a Kapruka product by product ID.',
    parameters: {
      type: 'OBJECT',
      properties: {
        product_id: {
          type: 'STRING',
          description: 'The Kapruka product ID.',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'kapruka_list_categories',
    description: 'List Kapruka product categories and browse options.',
    parameters: {
      type: 'OBJECT',
      properties: {
        depth: {
          type: 'INTEGER',
          description: 'Sub-category depth, usually 1 or 2.',
        },
      },
    },
  },
  {
    name: 'kapruka_list_delivery_cities',
    description:
      'Search or list Sri Lankan cities supported for Kapruka delivery.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: "Optional city search text, e.g. 'Colombo' or 'Kandy'.",
        },
        limit: {
          type: 'INTEGER',
          description: 'Optional max result count.',
        },
      },
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
        delivery_date: {
          type: 'STRING',
          description: 'Optional target delivery date in YYYY-MM-DD format.',
        },
        product_id: {
          type: 'STRING',
          description: 'Optional product ID to check delivery eligibility for.',
        },
      },
      required: ['city'],
    },
  },
  {
    name: 'kapruka_create_order',
    description:
      'Create a Kapruka guest checkout order after all cart, recipient, delivery, and sender details are collected.',
    parameters: {
      type: 'OBJECT',
      properties: {
        cart: {
          type: 'ARRAY',
          description: 'Cart line items.',
          items: {
            type: 'OBJECT',
            properties: {
              product_id: { type: 'STRING' },
              quantity: { type: 'INTEGER' },
              icing_text: { type: 'STRING' },
            },
            required: ['product_id'],
          },
        },
        recipient: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            phone: { type: 'STRING' },
          },
        },
        delivery: {
          type: 'OBJECT',
          properties: {
            address: { type: 'STRING' },
            city: { type: 'STRING' },
            location_type: { type: 'STRING' },
            date: { type: 'STRING' },
            instructions: { type: 'STRING' },
          },
        },
        sender: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            anonymous: { type: 'BOOLEAN' },
          },
        },
        gift_message: { type: 'STRING' },
      },
      required: ['cart', 'recipient', 'delivery', 'sender'],
    },
  },
  {
    name: 'kapruka_track_order',
    description: 'Track a Kapruka order by order number.',
    parameters: {
      type: 'OBJECT',
      properties: {
        order_number: {
          type: 'STRING',
          description: 'Order number from the confirmation email.',
        },
      },
      required: ['order_number'],
    },
  },
];

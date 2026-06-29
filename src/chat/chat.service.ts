import {
  Injectable,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { streamText, tool, stepCountIs, generateText } from 'ai';
import { z } from 'zod';
import {
  AgentSessionEntity,
  AgentTurnEntity,
  StepTraceEntity,
} from '../database/entities/index.js';
import { StepType } from '../database/enums/step-type.enum.js';
import { SessionStatus } from '../database/enums/session-status.enum.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { callMcpTool } from './mcp-client.js';
import { filterResponseStream } from './stream-filter.util.js';
import { getSystemPrompt, type SystemPromptOptions } from './system-prompt.js';
import { checkRateLimit } from './rate-limiter.js';
import {
  KAPRUKA_VOICE_TOOL_NAMES,
  type KaprukaVoiceToolName,
} from '../voice/voice.constants.js';
import type {
  VoiceToolCallInput,
  VoiceToolCallResult,
} from '../voice/voice.types.js';
import {
  getAvailableModels,
  markModelFailed,
  getModelInstance,
  isFallbackModel,
  classifyRateLimitError,
  logExecutionCycle,
  clearCooldowns,
} from './model-provider.js';

const MAX_CHAT_MESSAGE_LENGTH = 1000;
const MAX_CHAT_HISTORY_MESSAGES = 200;

const SINGLISH_WORDS = new Set([
  // Greetings & Common Polite Words
  'kohomada',
  'subha',
  'dawasak',
  'ayubowan',
  'halow',
  'isthuthi',
  'sthuthi',
  'karunakarala',

  // Pronouns & People
  'oyata',
  'mata',
  'eyata',
  'oyala',
  'mam',
  'mama',
  'oya',
  'eya',
  'meya',
  'thama',
  'ogolla',
  'machan',
  'malli',
  'nangi',
  'aiya',
  'akka',
  'amma',
  'thaththa',
  'yaluwa',
  'mithraya',
  'thambi',

  // Verbs & Action Words (Common colloquial forms)
  'karanne',
  'karanna',
  'karapan',
  'yanne',
  'yanna',
  'yapan',
  'enna',
  'enawa',
  'yanawa',
  'innawa',
  'inna',
  'innada',
  'kanawa',
  'kanne',
  'kanna',
  'bonawa',
  'bonne',
  'bonna',
  'kiyanna',
  'kiyapan',
  'hadanna',
  'hadanawa',
  'puluwan',
  'puluwanda',
  'baha',
  'nathnam',
  'awilla',
  'gihin',
  'balanna',
  'balanawa',
  'danna',
  'dananawa',
  'dapan',
  'damma',
  'ganna',
  'gannawa',

  // Interrogatives (Questions)
  'mokada',
  'monada',
  'kauda',
  'mokatada',
  'koheda',
  'kohomad',
  'mokakda',
  'ai',
  'moko',

  // Adjectives & Particles & Conversational Fillers
  'hari',
  'naha',
  'neda',
  'ane',
  'anei',
  'mey',
  'mokut',
  'monawahari',
  'dan',
  'wela',
  'velawa',
  'heta',
  'ada',
  'iyye',
  'thawa',
  'ithiri',
  'godak',
  'chuttak',
  'poddak',
  'ela',
  'patta',
  'supiri',
  'maru',
  'nikan',
  'awlak',
  'aulak',
  'niyamai',
  'sira',
  'sirawatama',
]);

const TANGLISH_WORDS = new Set([
  // Greetings & Polite expressions
  'vanakkam',
  'nandri',
  'varuga',
  'saranam',

  // Pronouns & People
  'enaku',
  'unaku',
  'avan',
  'ava',
  'naan',
  'enga',
  'nanga',
  'avanga',
  'ivanga',
  'ungaluku',
  'macha',
  'machi',
  'thambi',
  'anna',
  'akka',
  'thala',
  'nanba',
  'nanbi',
  'maama',
  'mami',
  'muttal',

  // Verbs & Common Actions
  'irukenga',
  'irukinga',
  'irukira',
  'iruku',
  'irukan',
  'poda',
  'ponga',
  'vanga',
  'saptiya',
  'sapadu',
  'sollu',
  'sollunga',
  'panrenga',
  'panringa',
  'varatuma',
  'varum',
  'illai',
  'ama',
  'irukku',
  'poidu',
  'seyya',
  'panni',
  'kelu',
  'ketingala',

  // Interrogatives
  'epdi',
  'yaaru',
  'yenna',
  'yean',
  'eppo',
  'enga',
  'edhu',
  'eppadi',
  'ethana',

  // Conversational Modifiers & Slang
  'semma',
  'romba',
  'nalla',
  'kuda',
  'vada',
  'seri',
  'apdiya',
  'paravala',
  'konjam',
  'miga',
  'vegam',
  'pathu',
  'theriyum',
  'theriyathu',
]);

/**
 * Converts a mixed array of UIMessages (parts[]) and ModelMessages (content[])
 * stored in the DB into a clean ModelMessage[] array that `streamText` accepts.
 *
 * UIMessage format  — produced by the frontend / @ai-sdk/react
 *   { role: "user"|"assistant", parts: [...] }
 *
 * ModelMessage format — produced by onFinish → response.messages
 *   { role: "user"|"assistant"|"tool", content: string | [...] }
 */

/**
 * Trims a search result payload to keep only essential fields for context.
 * Strips heavy fields (image URLs, long HTML descriptions, etc.) that bloat
 * the model context without aiding decision-making.
 * Critically preserves `next_cursor` for pagination.
 */
function trimSearchResult(result: any): any {
  if (!result || typeof result !== 'object') return result;

  // If it's a search result with a results array, trim each product
  if (Array.isArray(result.results)) {
    const trimmed: any = {
      total: result.total,
      next_cursor: result.next_cursor || null,
      results: result.results.map((p: any) => ({
        product_id: p.product_id,
        name: p.name,
        price: p.price,
        in_stock: p.in_stock,
        category: p.category,
        // Strip: image_url, description, html_description, browse_url, etc.
      })),
    };

    if (result.totalResults !== undefined)
      trimmed.totalResults = result.totalResults;
    if (result.currentPage !== undefined)
      trimmed.currentPage = result.currentPage;
    if (result.hasNextPage !== undefined)
      trimmed.hasNextPage = result.hasNextPage;

    return trimmed;
  }

  // If it has a 'value' wrapper (DB-stored format)
  if (result.value && typeof result.value === 'object') {
    return { ...result, value: trimSearchResult(result.value) };
  }

  return result;
}

const PURCHASE_INTENT_PATTERNS = [
  /\bgive (them|those|me those|me them|me all|them all)\b/i,
  /\bi('ll| will) take (them|those|all|it)\b/i,
  /\bi want (them|those|all of them|all of those|to (buy|order|purchase) (them|those))\b/i,
  /\bi('ll| will) have (them|those|all)\b/i,
  /\bi('ll| will) go with (those|them|that)\b/i,
  /\border (them|those|now|all)\b/i,
  /\bplace (the )?order\b/i,
  /\bbook (them|those|all)\b/i,
  /\b(proceed|go ahead|let'?s (do it|go|order|buy|get them))\b/i,
  /\b(yes,? ?I want (those|them|these|all))\b/i,
  /\bthose ones please\b/i,
  /\bhow (do|can) I (buy|order|get|purchase) (them|those|these)\b/i,
  /\bready to (order|buy|checkout|check ?out|purchase)\b/i,
  /\bwant to (buy|order|purchase) (them|those|these|all)\b/i,
];

/** Returns true when the user message clearly signals purchase/checkout intent. */
function hasPurchaseIntent(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return PURCHASE_INTENT_PATTERNS.some((re) => re.test(lower));
}

/**
 * Scans user messages in the conversation for temporal delivery-date references.
 * Returns a human-readable date string if found (e.g. "2026-06-30 (tomorrow)"),
 * so the system prompt can tell the AI not to ask for the date again.
 */
function extractKnownDeliveryDate(messages: any[]): string | null {
  const now = new Date();
  const sriLankaOffset = 5.5 * 60 * 60 * 1000; // UTC+5:30
  const slNow = new Date(now.getTime() + sriLankaOffset);

  const toISO = (d: Date) => d.toISOString().slice(0, 10);
  const fmt = (d: Date, label: string) => `${toISO(d)} (${label})`;

  const DAY_NAMES = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];

  let foundDate: string | null = null;

  // Only scan user-role messages
  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.parts)) {
      text = msg.parts
        .filter((p: any) => p?.type === 'text')
        .map((p: any) => p.text)
        .join(' ');
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((p: any) => p?.type === 'text')
        .map((p: any) => p.text)
        .join(' ');
    }
    if (!text) continue;

    const lower = text.toLowerCase();

    // Skip structured form-submitted messages — they already contain resolved dates
    if (
      /^(city:|product:|delivery date:|recipient name:|phone:)/im.test(text)
    ) {
      // Extract the resolved date from a form submission
      const dateMatch = /delivery date:\s*(.+)/im.exec(text);
      if (dateMatch) {
        foundDate = dateMatch[1].trim();
      }
      continue;
    }

    if (/\btomorrow\b/i.test(lower)) {
      const d = new Date(slNow);
      d.setUTCDate(d.getUTCDate() + 1);
      foundDate = fmt(d, 'tomorrow');
    } else if (/\btoday\b/i.test(lower)) {
      foundDate = fmt(slNow, 'today');
    } else if (/\bthis weekend\b/i.test(lower)) {
      const d = new Date(slNow);
      const dow = d.getUTCDay(); // 0=Sun
      const daysToSat = (6 - dow + 7) % 7 || 7;
      d.setUTCDate(d.getUTCDate() + daysToSat);
      foundDate = fmt(d, 'this Saturday');
    } else {
      // Named day: "this Saturday", "next Monday", "on Friday" etc.
      const dayMatch =
        /\b(?:this |next |on )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(
          lower,
        );
      if (dayMatch) {
        const targetDay = DAY_NAMES.indexOf(dayMatch[1].toLowerCase());
        const d = new Date(slNow);
        const currentDay = d.getUTCDay();
        const diff = (targetDay - currentDay + 7) % 7 || 7;
        d.setUTCDate(d.getUTCDate() + diff);
        foundDate = fmt(d, dayMatch[0].trim());
      }

      // ISO date literal
      const isoMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
      if (isoMatch) {
        foundDate = isoMatch[1];
      }

      // Verbal date: "June 30", "30th June" etc.
      const MONTHS: Record<string, number> = {
        jan: 0,
        january: 0,
        feb: 1,
        february: 1,
        mar: 2,
        march: 2,
        apr: 3,
        april: 3,
        may: 4,
        jun: 5,
        june: 5,
        jul: 6,
        july: 6,
        aug: 7,
        august: 7,
        sep: 8,
        september: 8,
        oct: 9,
        october: 9,
        nov: 10,
        november: 10,
        dec: 11,
        december: 11,
      };
      const verbalMatch =
        /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.exec(
          lower,
        ) ||
        /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(
          lower,
        );

      if (verbalMatch) {
        const isMonthFirst = isNaN(Number(verbalMatch[1]));
        const day = parseInt(
          isMonthFirst ? verbalMatch[2] : verbalMatch[1],
          10,
        );
        const monthKey = (isMonthFirst ? verbalMatch[1] : verbalMatch[2])
          .replace(/\./g, '')
          .toLowerCase()
          .slice(0, 3);
        const month = MONTHS[monthKey] ?? MONTHS[monthKey.slice(0, 3)];
        if (month !== undefined && day >= 1 && day <= 31) {
          const d = new Date(slNow);
          d.setUTCMonth(month, day);
          if (d < slNow) d.setUTCFullYear(d.getUTCFullYear() + 1); // next year if past
          foundDate = toISO(d);
        }
      }
    }
  }

  return foundDate;
}

/**
 * Scans the converted model messages to extract:
 *  - All product IDs that have been shown in previous search tool results
 *  - The `next_cursor` from the most recent search for a given query
 * This allows the tool execute to auto-paginate on repeated identical queries.
 */
function extractSearchContext(messages: any[]): {
  shownProductIds: Set<string>;
  lastCursorsByQuery: Map<string, string>;
} {
  const shownProductIds = new Set<string>();
  const lastCursorsByQuery = new Map<string, string>();

  // Track which tool-call IDs map to which query strings
  const toolCallQueries = new Map<string, string>();

  for (const msg of messages) {
    // Scan assistant messages for tool-call args to get the query
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          part.type === 'tool-call' &&
          part.toolName === 'kapruka_search_products'
        ) {
          const args = part.input ?? part.args ?? {};
          const q = (args.q || '').toLowerCase().trim();
          if (q && part.toolCallId) {
            toolCallQueries.set(part.toolCallId, q);
          }
        }
      }
    }

    // Scan tool results for product IDs and cursors
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue;

        const resultData = part.result ?? part.output?.value ?? part.output;
        if (!resultData || typeof resultData !== 'object') continue;

        // Extract product IDs
        const results = resultData.results || resultData.value?.results;
        if (Array.isArray(results)) {
          for (const p of results) {
            if (p.product_id) shownProductIds.add(p.product_id);
          }
        }

        // Extract next_cursor for this query
        const cursor = resultData.next_cursor || resultData.value?.next_cursor;
        const query = toolCallQueries.get(part.toolCallId);
        if (cursor && query) {
          lastCursorsByQuery.set(query, cursor);
        }
      }
    }
  }

  return { shownProductIds, lastCursorsByQuery };
}

function toModelMessages(messages: any[]): any[] {
  const result: any[] = [];

  for (const msg of messages) {
    const role: string = msg?.role;
    if (!role || role === 'system') continue;

    // ── User ──────────────────────────────────────────────────────────────────
    if (role === 'user') {
      let text = '';
      if (msg.metadata?.englishText) {
        text = msg.metadata.englishText;
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text ?? '')
          .join('');
      } else if (Array.isArray(msg.parts)) {
        text = msg.parts
          .filter((p: any) => p?.type === 'text')
          .map((p: any) => p.text ?? '')
          .join('');
      }
      const trimmed = text.trim();
      if (trimmed) {
        result.push({ role: 'user', content: trimmed });
      }
      continue;
    }

    // ── Assistant ─────────────────────────────────────────────────────────────
    if (role === 'assistant') {
      let source: any[] = [];
      if (Array.isArray(msg.parts)) {
        source = msg.parts;
      } else if (Array.isArray(msg.content)) {
        source = msg.content;
      } else {
        if (typeof msg.content === 'string' && msg.content.trim()) {
          source.push({
            type: 'text',
            text: msg.content,
            metadata: msg.metadata,
          });
        }
        if (Array.isArray(msg.toolInvocations)) {
          for (const inv of msg.toolInvocations) {
            source.push({
              type: 'tool-invocation',
              ...inv,
            });
          }
        }
      }

      const assistantContent: any[] = [];
      const pendingToolResults: any[] = [];

      for (const part of source) {
        if (!part?.type) continue;

        // Plain text
        if (part.type === 'text') {
          const t = (
            part.metadata?.englishText ??
            msg.metadata?.englishText ??
            part.text ??
            ''
          ).trim();
          if (t) assistantContent.push({ type: 'text', text: t });
          continue;
        }

        // ModelMessage tool-call (from response.messages)
        if (part.type === 'tool-call' && part.toolCallId) {
          assistantContent.push({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName ?? '',
            args: part.input ?? part.args ?? {},
            input: part.input ?? part.args ?? {},
            // providerExecuted must be boolean or absent — never null
            ...(typeof part.providerExecuted === 'boolean'
              ? { providerExecuted: part.providerExecuted }
              : {}),
            ...(part.providerOptions
              ? { providerOptions: part.providerOptions }
              : {}),
          });
          continue;
        }

        // UIMessage tool-invocation (from frontend)
        if (part.type === 'tool-invocation' && part.toolCallId) {
          assistantContent.push({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName ?? '',
            args: part.args ?? part.input ?? {},
            input: part.args ?? part.input ?? {},
            ...(part.providerOptions
              ? { providerOptions: part.providerOptions }
              : {}),
          });
          // If the invocation carries the result, collect it for a tool role message
          if (part.state === 'result' && part.result !== undefined) {
            const trimmedResult =
              part.toolName === 'kapruka_search_products'
                ? trimSearchResult(part.result)
                : part.result;
            pendingToolResults.push({
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName ?? '',
              result: trimmedResult,
              output: { type: 'json', value: trimmedResult },
            });
          }
          continue;
        }

        // Reasoning part (some models emit these)
        if (part.type === 'reasoning' && typeof part.text === 'string') {
          assistantContent.push({ type: 'reasoning', text: part.text });
          continue;
        }

        // Skip: step-start, source, tool-approval-request, etc.
      }

      if (assistantContent.length > 0) {
        result.push({ role: 'assistant', content: assistantContent });
        if (pendingToolResults.length > 0) {
          result.push({ role: 'tool', content: pendingToolResults });
        }
      }
      continue;
    }

    // ── Tool (ModelMessage format, from response.messages) ───────────────────
    if (role === 'tool') {
      if (!Array.isArray(msg.content)) continue;

      const toolResults: any[] = [];
      for (const part of msg.content) {
        if (part?.type !== 'tool-result' || !part.toolCallId) continue;

        const rawOutput = part.output ?? part.result;
        let output: any;
        if (
          rawOutput &&
          typeof rawOutput === 'object' &&
          typeof rawOutput.type === 'string'
        ) {
          // Already in { type, value } format — keep as-is
          output = rawOutput;
        } else {
          output = { type: 'json', value: rawOutput ?? null };
        }

        // Trim search results to keep context lean (strip images, HTML, etc.)
        const isTrimCandidate = part.toolName === 'kapruka_search_products';
        const trimmedOutput = isTrimCandidate
          ? trimSearchResult(output)
          : output;
        const trimmedResult = isTrimCandidate
          ? trimSearchResult(output?.value ?? output)
          : (output?.value ?? output);

        toolResults.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? '',
          result: trimmedResult,
          output: trimmedOutput,
        });
      }
      if (toolResults.length > 0) {
        result.push({ role: 'tool', content: toolResults });
      }
      continue;
    }
  }

  return result;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger('ChatService');

  constructor(
    @InjectRepository(AgentSessionEntity)
    private readonly sessionRepo: Repository<AgentSessionEntity>,
    @InjectRepository(AgentTurnEntity)
    private readonly turnRepo: Repository<AgentTurnEntity>,
    @InjectRepository(StepTraceEntity)
    private readonly stepTraceRepo: Repository<StepTraceEntity>,
    private readonly analyticsService: AnalyticsService,
  ) {}

  private toUIMessages(messages: any[]): any[] {
    const uiMessages: any[] = [];
    const toolResultsMap = new Map<string, any>();

    // Collect all tool results first
    for (const msg of messages) {
      if (msg && msg.role === 'tool') {
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part && part.type === 'tool-result' && part.toolCallId) {
              const rawOutput = part.output ?? part.result;
              let outputValue: any = null;
              if (rawOutput && typeof rawOutput === 'object') {
                outputValue =
                  rawOutput.type === 'json' ? rawOutput.value : rawOutput;
              } else {
                outputValue = rawOutput;
              }
              toolResultsMap.set(part.toolCallId, outputValue);
            }
          }
        }
      }
    }

    // Process user and assistant messages
    for (const msg of messages) {
      if (!msg || msg.role === 'system' || msg.role === 'tool') {
        continue;
      }

      const id =
        msg.id ||
        msg._id?.toString() ||
        `msg-${Math.random().toString(36).substring(2, 9)}`;
      const role = msg.role;
      const metadata = msg.metadata;

      if (role === 'user') {
        let content = '';
        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          content = msg.content
            .filter((c: any) => c?.type === 'text')
            .map((c: any) => c.text ?? '')
            .join('');
        } else if (Array.isArray(msg.parts)) {
          content = msg.parts
            .filter((p: any) => p?.type === 'text')
            .map((p: any) => p.text ?? '')
            .join('');
        }

        uiMessages.push({
          id,
          role: 'user',
          content,
          parts: [{ type: 'text', text: content }],
          metadata,
        });
        continue;
      }

      if (role === 'assistant') {
        let content = '';
        const toolInvocations: any[] = [];
        const uiParts: any[] = [];

        const parts = Array.isArray(msg.parts)
          ? msg.parts
          : Array.isArray(msg.content)
            ? msg.content
            : typeof msg.content === 'string'
              ? [{ type: 'text', text: msg.content }]
              : [];

        for (const part of parts) {
          if (!part) continue;

          if (typeof part === 'string') {
            content += part;
            uiParts.push({ type: 'text', text: part });
          } else if (part.type === 'text') {
            content += part.text ?? '';
            uiParts.push({ type: 'text', text: part.text ?? '' });
          } else if (part.type === 'tool-call') {
            const toolCallId = part.toolCallId;
            const toolName = part.toolName ?? '';
            const args = part.input ?? part.args ?? {};

            const hasResult = toolResultsMap.has(toolCallId);
            const resultVal = toolResultsMap.get(toolCallId);

            toolInvocations.push({
              state: hasResult ? 'result' : 'calling',
              toolCallId,
              toolName,
              args,
              ...(hasResult ? { result: resultVal } : {}),
            });

            // Also add as a tool-invocation part for SDK v6+ rendering
            uiParts.push({
              type: 'tool-invocation',
              toolCallId,
              toolName,
              args,
              state: hasResult ? 'result' : 'calling',
              ...(hasResult ? { result: resultVal } : {}),
            });
          } else if (part.type === 'tool-invocation') {
            toolInvocations.push(part);
            uiParts.push(part);
          }
        }

        if (Array.isArray(msg.toolInvocations)) {
          for (const inv of msg.toolInvocations) {
            if (!toolInvocations.some((t) => t.toolCallId === inv.toolCallId)) {
              toolInvocations.push(inv);
              uiParts.push({
                type: 'tool-invocation',
                ...inv,
              });
            }
          }
        }

        uiMessages.push({
          id,
          role: 'assistant',
          content,
          parts:
            uiParts.length > 0 ? uiParts : [{ type: 'text', text: content }],
          toolInvocations:
            toolInvocations.length > 0 ? toolInvocations : undefined,
          metadata,
        });
      }
    }

    return uiMessages;
  }

  async getHistory(sessionId: string | null, userId?: string): Promise<any[]> {
    let turns: AgentTurnEntity[] = [];

    if (userId) {
      if (sessionId) {
        const session = await this.sessionRepo.findOne({
          where: { id: sessionId },
        });
        if (session && !session.externalUserId) {
          this.logger.log(
            `Migrating anonymous session ${sessionId} to user ${userId}`,
          );
          session.externalUserId = userId;
          await this.sessionRepo.save(session);
          // Trigger background analytics migration
          this.analyticsService
            .migrateSession(sessionId, userId)
            .catch(() => {});
        }
      }

      const queryWhere: any = {
        session: {
          externalUserId: userId,
        },
      };
      if (sessionId) {
        queryWhere.sessionId = sessionId;
      }

      turns = await this.turnRepo.find({
        where: queryWhere,
        relations: {
          traces: true,
        },
        order: {
          createdAt: 'ASC',
        },
      });
    } else if (sessionId) {
      const session = await this.sessionRepo.findOne({
        where: { id: sessionId },
        relations: {
          turns: {
            traces: true,
          },
        },
      });
      if (session) {
        turns = session.turns.sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
      }
    }

    if (turns.length === 0) {
      return [];
    }

    const flatMessages: any[] = [];
    for (const turn of turns) {
      // 1. Reconstruct User Message
      flatMessages.push({
        id: `${turn.id}-user`,
        role: 'user',
        content: turn.userPrompt,
        metadata: turn.metadata,
      });

      // 2. Reconstruct Tool Calls & Results (if any)
      const toolCalls: any[] = [];
      const toolResults: any[] = [];

      // Sort traces by createdAt
      const traces =
        turn.traces?.sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        ) || [];

      for (const trace of traces) {
        if (trace.stepType === StepType.MCP_TOOL_CALL) {
          const { providerOptions, ...cleanArgs } = trace.inputPayload || {};
          const toolCallId = cleanArgs.toolCallId || trace.id;
          toolCalls.push({
            type: 'tool-call',
            toolCallId,
            toolName: trace.nodeName,
            args: cleanArgs,
            ...(providerOptions ? { providerOptions } : {}),
          });

          toolResults.push({
            type: 'tool-result',
            toolCallId,
            toolName: trace.nodeName,
            result:
              trace.outputPayload?.value !== undefined
                ? trace.outputPayload.value
                : (trace.outputPayload ?? null),
          });
        }
      }

      if (toolCalls.length > 0) {
        flatMessages.push({
          id: `${turn.id}-tool-calls`,
          role: 'assistant',
          content: toolCalls,
        });
        flatMessages.push({
          id: `${turn.id}-tool-results`,
          role: 'tool',
          content: toolResults,
        });
      }

      // 3. Reconstruct Assistant Message
      if (turn.finalAgentResponse) {
        flatMessages.push({
          id: `${turn.id}-assistant`,
          role: 'assistant',
          content: turn.finalAgentResponse,
          metadata: {
            englishText:
              turn.metadata?.assistantEnglishText ?? turn.finalAgentResponse,
            originalText: turn.finalAgentResponse,
          },
        });
      }
    }

    return this.toUIMessages(flatMessages);
  }

  async getSessions(userId: string): Promise<any[]> {
    const sessions = await this.sessionRepo.find({
      where: { externalUserId: userId },
      relations: {
        turns: true,
      },
      order: {
        updatedAt: 'DESC',
      },
    });

    return sessions.map((session) => {
      const turns = [...session.turns].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const firstRealTurn = turns.find(
        (t) => t.userPrompt && t.userPrompt !== '[voice session]',
      );
      const displayTitle = firstRealTurn?.userPrompt || 'New Conversation';

      return {
        sessionId: session.id,
        displayTitle,
        updatedAt: session.updatedAt,
      };
    });
  }

  async verifySessionOwner(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
    });
    if (!session) return true;
    return session.externalUserId === null || session.externalUserId === userId;
  }

  async findOrCreateSession(
    sessionId: string,
    userId?: string,
  ): Promise<AgentSessionEntity> {
    let session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      session = this.sessionRepo.create({
        id: sessionId,
        externalUserId: userId || null,
        currentStatus: SessionStatus.ACTIVE,
      });
      session = await this.sessionRepo.save(session);
    }
    return session;
  }

  async saveInitialTurn(
    sessionId: string,
    userPrompt: string,
    metadata: any,
  ): Promise<AgentTurnEntity> {
    if (metadata?.channel !== 'voice') {
      const existing = await this.turnRepo.findOne({
        where: { sessionId, userPrompt, finalAgentResponse: IsNull() },
        order: { createdAt: 'DESC' },
      });
      if (existing) return existing;
    }

    const turn = this.turnRepo.create({
      sessionId,
      userPrompt,
      metadata,
    });
    const savedTurn = await this.turnRepo.save(turn);
    try {
      await this.sessionRepo.update(sessionId, { updatedAt: new Date() });
    } catch (err) {
      this.logger.warn(
        `Failed to update session updatedAt for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return savedTurn;
  }

  async saveStepTraces(
    turnId: string,
    traces: Partial<StepTraceEntity>[],
  ): Promise<void> {
    const entities = traces.map((t) =>
      this.stepTraceRepo.create({ ...t, turnId }),
    );
    await this.stepTraceRepo.save(entities);
  }

  async executeVoiceToolCall(
    input: VoiceToolCallInput,
  ): Promise<VoiceToolCallResult> {
    const startedAt = Date.now();
    let traceInputPayload: Record<string, any> = {
      ...input.args,
      toolCallId: input.toolCallId,
    };

    try {
      if (!this.isVoiceToolName(input.toolName)) {
        throw new Error(`Unsupported voice tool: ${input.toolName}`);
      }

      const toolArgs = this.normalizeVoiceToolArgs(input.toolName, input.args);
      traceInputPayload = {
        ...toolArgs,
        toolCallId: input.toolCallId,
      };

      const result = await callMcpTool(input.toolName, toolArgs);
      await this.saveStepTraces(input.turnId, [
        {
          stepType: StepType.MCP_TOOL_CALL,
          nodeName: input.toolName,
          inputPayload: traceInputPayload,
          outputPayload: this.toTracePayload(result),
          executionDurationMs: Date.now() - startedAt,
          isError: false,
        },
      ]);

      return { ok: true, result };
    } catch (error) {
      const message = this.errorMessage(error);
      await this.saveStepTraces(input.turnId, [
        {
          stepType: StepType.MCP_TOOL_CALL,
          nodeName: input.toolName || 'unknown',
          inputPayload: traceInputPayload,
          outputPayload: null,
          executionDurationMs: Date.now() - startedAt,
          isError: true,
          errorMessage: message,
        },
      ]).catch((traceError) => {
        this.logger.warn(
          `Failed to save voice tool trace: ${this.errorMessage(traceError)}`,
        );
      });

      return { ok: false, error: message };
    }
  }

  async deleteByUserId(userId: string): Promise<any> {
    return this.sessionRepo.delete({ externalUserId: userId });
  }

  private isVoiceToolName(toolName: string): toolName is KaprukaVoiceToolName {
    return (KAPRUKA_VOICE_TOOL_NAMES as readonly string[]).includes(toolName);
  }

  private normalizeVoiceToolArgs(
    _toolName: KaprukaVoiceToolName,
    args: Record<string, unknown>,
  ): Record<string, any> {
    if (this.isRecord(args.params)) {
      return args as Record<string, any>;
    }

    return {
      params: {
        response_format: 'json',
        ...args,
      },
    };
  }

  private toTracePayload(value: unknown): Record<string, any> {
    return this.isRecord(value) ? (value as Record<string, any>) : { value };
  }

  private errorMessage(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private sanitizeIdentity(text: string): string {
    if (!text) return text;
    return text
      .replace(/\bGoogle\s+Gemini\b/gi, 'Thisari')
      .replace(/\bLlama\b/gi, 'Thisari')
      .replace(/\bGroq\b/gi, 'Kapruka')
      .replace(/\bGemini\b/gi, 'Thisari')
      .replace(/\bOpenAI\b/gi, 'Kapruka')
      .replace(/\bChatGPT\b/gi, 'Thisari')
      .replace(/\bClaude\b/gi, 'Thisari');
  }

  private getTranslationModelName(): string {
    const available = getAvailableModels();
    return available[0] || 'gemini-3.5-flash';
  }

  private estimateTokenCount(messages: any[], systemPrompt: string): number {
    let text = systemPrompt || '';
    for (const m of messages) {
      if (m.content) {
        if (typeof m.content === 'string') {
          text += m.content;
        } else if (Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p.type === 'text' && p.text) {
              text += p.text;
            }
          }
        }
      } else if (m.parts) {
        for (const p of m.parts) {
          if (p.text) {
            text += p.text;
          }
        }
      }
    }
    return Math.ceil(text.length / 4);
  }

  private detectLanguageLocally(
    text: string,
  ): 'sinhala' | 'singlish' | 'tanglish' | 'english' {
    if (!text || !text.trim()) {
      return 'english';
    }

    // 1. Inspect Native Scripts via Unicode Ranges
    // Sinhala Unicode range: U+0D80 to U+0DFF
    const hasSinhalaUnicode = /[\u0D80-\u0DFF]/.test(text);
    // Tamil Unicode range: U+0B80 to U+0BFF
    const hasTamilUnicode = /[\u0B80-\u0BFF]/.test(text);

    if (hasSinhalaUnicode) {
      return 'sinhala';
    }
    if (hasTamilUnicode) {
      return 'tanglish';
    }

    // 2. Parse, Clean and Tokenize English Text
    const cleanText = text.toLowerCase().replace(/[^\w\s]/g, '');
    const tokens = cleanText.split(/\s+/).filter(Boolean);

    // 3. Match against lists
    let matchedSinglishCount = 0;
    let matchedTanglishCount = 0;

    for (const token of tokens) {
      if (SINGLISH_WORDS.has(token)) {
        matchedSinglishCount++;
      }
      if (TANGLISH_WORDS.has(token)) {
        matchedTanglishCount++;
      }
    }

    // 4. Apply strict classification priority rules
    if (
      matchedSinglishCount > matchedTanglishCount &&
      matchedSinglishCount > 0
    ) {
      return 'singlish';
    }
    if (matchedTanglishCount > 0) {
      return 'tanglish';
    }

    return 'english';
  }

  private async translateInput(text: string): Promise<{
    translatedText: string;
    detectedLanguage: 'sinhala' | 'singlish' | 'tanglish' | 'english';
  }> {
    const detectedLanguage = this.detectLanguageLocally(text);

    if (detectedLanguage === 'english') {
      return { translatedText: text, detectedLanguage: 'english' };
    }

    const modelName = this.getTranslationModelName();
    try {
      this.logger.log(
        `Translating input message (${detectedLanguage}) using ${modelName}...`,
      );

      let sourceLangName = '';
      let examples = '';

      if (detectedLanguage === 'sinhala') {
        sourceLangName = 'Sinhala (සිංහල script)';
        examples = `User query: "ලස්සන මල් කළඹක් තෝරලා දෙන්න"
Translation: Select a beautiful flower bouquet for me.

User query: "උපන්දින කේක් වර්ග මොනවාද තියෙන්නේ"
Translation: What kinds of birthday cakes do you have?`;
      } else if (detectedLanguage === 'singlish') {
        sourceLangName = 'Singlish (Sinhala transliterated in English script)';
        examples = `User query: "cake monada thiyenne"
Translation: What cakes do you have?

User query: "oyala colombo walata delivery karanawada"
Translation: Do you deliver to Colombo?

User query: "oyage nama mokakda"
Translation: What is your name?

User query: "machan"
Translation: friend`;
      } else if (detectedLanguage === 'tanglish') {
        sourceLangName =
          'Tanglish (Tamil transliterated in English script or Native Tamil)';
        examples = `User query: "enaku chocolate cake venum"
Translation: I want a chocolate cake.

User query: "delivery iruka"
Translation: Is delivery available?

User query: "nalla cake sollunga"
Translation: Suggest a good cake.

User query: "macha"
Translation: friend`;
      }

      const response = await generateText({
        model: getModelInstance(modelName),
        prompt: `Translate the following user query from ${sourceLangName} into standard English for e-commerce search.

Here are some examples:
${examples}

Now translate the following query. Respond ONLY with the English translation. Do not add any explanation, prefix, or other text.

Query: "${text}"`,
        maxRetries: 1,
      });

      return {
        translatedText: response.text.trim(),
        detectedLanguage,
      };
    } catch (err: any) {
      this.logger.warn(
        `Translation input failed on model "${modelName}": ${err.message || err}`,
      );
      markModelFailed(modelName);
      return { translatedText: text, detectedLanguage };
    }
  }

  private async translateOutput(
    text: string,
    targetLang: 'sinhala' | 'singlish' | 'tanglish',
  ): Promise<string> {
    if (!text || !text.trim()) return text;
    const modelName = this.getTranslationModelName();
    try {
      this.logger.log(
        `Translating assistant output to ${targetLang} using ${modelName}...`,
      );

      let prompt = '';
      if (targetLang === 'sinhala') {
        prompt = `Translate the following English e-commerce assistant text into warm, friendly, natural Sinhala (සිංහල). Keep product names, prices (e.g. Rs. 3,500), and product IDs in English.

Here are some examples of how to translate:
English Text: "Hello! I am Thisari, your Kapruka shopping assistant. How can I help you today?"
Translation: "ආයුබෝවන්! මම තිසරි, ඔබේ කප්රුක සාප්පු සහායිකාව. අද මම ඔබට උදව් කරන්නේ කෙසේද?"

English Text: "We have some delicious chocolate cakes under Rs. 10,000. Here is a list of items:"
Translation: "අප සතුව රු. 10,000ට අඩු රසවත් චොකලට් කේක් කිහිපයක් තිබේ. මෙන්න අයිතම ලැයිස්තුව:"

English Text: "Would you like to place an order?"
Translation: "ඔබ ඇණවුමක් කිරීමට කැමතිද?"

English Text: "Your order has been placed successfully! The payment link is: https://example.com"
Translation: "ඔබේ ඇණවුම සාර්ථකව සිදු කරන ලදී! ගෙවීම් සබැඳිය: https://example.com"

English Text: "What is the delivery address and contact phone number?"
Translation: "භාර දිය යුතු ලිපිනය සහ සම්බන්ධ කර ගත හැකි දුරකථන අංකය කුමක්ද?"

Now translate the following text. Return ONLY the translated Sinhala text. Do not add any introduction, explanations, or notes.

Text: "${text}"`;
      } else if (targetLang === 'singlish') {
        prompt = `Translate the following English e-commerce assistant text into warm, friendly, natural Singlish (Sinhala written in English characters/Romanized Sinhala, e.g., "oya" instead of "you", "thiyenne" instead of "available", "oyata" instead of "for you"). Keep product names, prices (e.g. Rs. 3,500), and product IDs in English.

Here are some examples of how to translate:
English Text: "Hello! I am Thisari, your Kapruka shopping assistant. How can I help you today?"
Translation: "Hello! Mama Thisari, oyage Kapruka shopping assistant. Ada mama oyata kohomada udau karanne?"

English Text: "We have some delicious chocolate cakes under Rs. 10,000. Here is a list of items:"
Translation: "Apiga gawa Rs. 10,000 adu rasama rasa chocolate cakes thiyenawa. Menna items list eka:"

English Text: "Would you like to place an order?"
Translation: "Oyata order ekak danna oneda?"

English Text: "Your order has been placed successfully! The payment link is: https://example.com"
Translation: "Oyage order eka successfully place kala! Payment link eka: https://example.com"

English Text: "What is the delivery address and contact phone number?"
Translation: "Delivery address eka saha contact phone number eka mokakda?"

Now translate the following text. Return ONLY the translated transliterated Singlish text. Do not add any introduction, explanations, or notes.

Text: "${text}"`;
      } else if (targetLang === 'tanglish') {
        prompt = `Translate the following English e-commerce assistant text into warm, friendly, natural Tanglish (Tamil written in English characters/Romanized Tamil, e.g., "unaku" instead of "for you", "irukku" instead of "available", "vaanga" instead of "come"). Keep product names, prices (e.g. Rs. 3,500), and product IDs in English.

Here are some examples of how to translate:
English Text: "Hello! I am Thisari, your Kapruka shopping assistant. How can I help you today?"
Translation: "Vanakkam! Naan Thisari, ungaloda Kapruka shopping assistant. Iniku naan ungaluku eppadi help panna mudiyum?"

English Text: "We have some delicious chocolate cakes under Rs. 10,000. Here is a list of items:"
Translation: "Engakitta Rs. 10,000 kulla nalla chocolate cakes irukku. Idho items list:"

English Text: "Would you like to place an order?"
Translation: "Neenga order panna virumbureengala?"

English Text: "Your order has been placed successfully! The payment link is: https://example.com"
Translation: "Unga order successfully place aairuchu! Payment link: https://example.com"

English Text: "What is the delivery address and contact phone number?"
Translation: "Delivery address matrum contact phone number enna?"

Now translate the following text. Return ONLY the translated transliterated Tanglish text. Do not add any introduction, explanations, or notes.

Text: "${text}"`;
      }

      const response = await generateText({
        model: getModelInstance(modelName),
        prompt,
        maxRetries: 1,
      });

      return response.text.trim();
    } catch (err: any) {
      this.logger.warn(
        `Translation output to ${targetLang} failed on model "${modelName}": ${err.message || err}`,
      );
      markModelFailed(modelName);
      return text;
    }
  }

  private processResponseStream(
    inputStream: ReadableStream<Uint8Array>,
    targetLang: 'sinhala' | 'singlish' | 'tanglish' | 'english',
    modelName: string,
  ): ReadableStream<Uint8Array> {
    const reader = inputStream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let sentenceBuffer = '';

    const processText = async (englishText: string): Promise<string> => {
      let resultText = englishText;
      resultText = this.sanitizeIdentity(resultText);
      if (
        targetLang === 'sinhala' ||
        targetLang === 'singlish' ||
        targetLang === 'tanglish'
      ) {
        this.logger.log(
          `Stream translation start: "${englishText.substring(0, 40).replace(/\n/g, ' ')}..."`,
        );
        resultText = await this.translateOutput(resultText, targetLang);
        this.logger.log(
          `Stream translation end: "${resultText.substring(0, 40).replace(/\n/g, ' ')}..."`,
        );
        resultText = this.sanitizeIdentity(resultText);
      }
      return resultText;
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (true) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              if (sentenceBuffer.trim()) {
                const processed = await processText(sentenceBuffer);
                controller.enqueue(
                  encoder.encode(`0:${JSON.stringify(processed)}\n`),
                );
              }
              controller.close();
              reader.releaseLock();
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('0:')) {
                try {
                  const textChunk = JSON.parse(line.substring(2));

                  if (
                    targetLang === 'sinhala' ||
                    targetLang === 'singlish' ||
                    targetLang === 'tanglish'
                  ) {
                    sentenceBuffer += textChunk;
                    if (/[.!?\n]/.test(textChunk)) {
                      const toProcess = sentenceBuffer;
                      sentenceBuffer = '';
                      const processed = await processText(toProcess);
                      controller.enqueue(
                        encoder.encode(`0:${JSON.stringify(processed)}\n`),
                      );
                    }
                  } else {
                    const processed = await processText(textChunk);
                    controller.enqueue(
                      encoder.encode(`0:${JSON.stringify(processed)}\n`),
                    );
                  }
                } catch {
                  controller.enqueue(encoder.encode(line + '\n'));
                }
              } else {
                controller.enqueue(encoder.encode(line + '\n'));
              }
            }

            if (lines.length > 0) {
              break;
            }
          } catch (err) {
            const errorType = classifyRateLimitError(err);
            if (errorType === 'RPD') {
              logExecutionCycle(
                modelName,
                'FALLBACK_TRIGGERED',
                'RPD_LIMIT',
                'SWAPPED_MODEL',
              );
              markModelFailed(modelName, 24 * 60 * 60 * 1000);
            } else if (errorType === 'RPM') {
              logExecutionCycle(
                modelName,
                'FALLBACK_TRIGGERED',
                'RPM_LIMIT',
                'SWAPPED_MODEL',
              );
              markModelFailed(modelName, 60000);
            } else if (errorType === 'TPM') {
              logExecutionCycle(
                modelName,
                'FALLBACK_TRIGGERED',
                'TPM_LIMIT',
                'SLEEP_60S',
              );
              markModelFailed(modelName, 60000);
            } else {
              markModelFailed(modelName, 60000);
            }
            controller.error(err);
            reader.releaseLock();
            break;
          }
        }
      },
      cancel() {
        void reader.cancel();
        reader.releaseLock();
      },
    });
  }

  async handleChat(
    body: {
      messages: any[];
      sessionId: string;
      cartItems?: { name: string; qty: number; price?: number }[];
    },
    ipAddress: string,
    userId?: string,
  ): Promise<any> {
    const { messages, sessionId, cartItems } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new BadRequestException('Messages are required');
    }

    // Load existing history from DB to get authoritative metadata
    const dbHistory = sessionId ? await this.getHistory(sessionId, userId) : [];

    // Merge metadata from DB history back into the frontend messages to preserve translations
    for (const msg of messages) {
      const dbMsg = dbHistory.find(
        (h: any) =>
          h.id === msg.id || (h._id && String(h._id) === String(msg._id)),
      );
      if (dbMsg) {
        if (dbMsg.metadata) {
          msg.metadata = dbMsg.metadata;
        }
        if (Array.isArray(dbMsg.parts) && Array.isArray(msg.parts)) {
          for (const part of msg.parts) {
            if (part && part.toolCallId) {
              const dbPart = dbMsg.parts.find(
                (dp: any) => dp && dp.toolCallId === part.toolCallId,
              );
              if (dbPart) {
                if (dbPart.metadata) part.metadata = dbPart.metadata;
                if (dbPart.providerOptions)
                  part.providerOptions = dbPart.providerOptions;
              }
            } else if (part && part.type === 'text') {
              const dbPart = dbMsg.parts.find(
                (dp: any) => dp && dp.type === 'text',
              );
              if (dbPart && dbPart.metadata) {
                part.metadata = dbPart.metadata;
              }
            }
          }
        }
        if (Array.isArray(dbMsg.content) && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && part.toolCallId) {
              const dbPart = dbMsg.content.find(
                (dp: any) => dp && dp.toolCallId === part.toolCallId,
              );
              if (dbPart) {
                if (dbPart.metadata) part.metadata = dbPart.metadata;
                if (dbPart.providerOptions)
                  part.providerOptions = dbPart.providerOptions;
              }
            } else if (part && part.type === 'text') {
              const dbPart = dbMsg.content.find(
                (dp: any) => dp && dp.type === 'text',
              );
              if (dbPart && dbPart.metadata) {
                part.metadata = dbPart.metadata;
              }
            }
          }
        }
        if (
          Array.isArray(dbMsg.toolInvocations) &&
          Array.isArray(msg.toolInvocations)
        ) {
          for (const inv of msg.toolInvocations) {
            if (inv && inv.toolCallId) {
              const dbInv = dbMsg.toolInvocations.find(
                (di: any) => di && di.toolCallId === inv.toolCallId,
              );
              if (dbInv && dbInv.providerOptions) {
                inv.providerOptions = dbInv.providerOptions;
              }
            }
          }
        }
      }
    }

    // Input validation
    const lastUserMsg = messages[messages.length - 1];
    if (!lastUserMsg) {
      throw new BadRequestException('Invalid message format');
    }

    let userMessageContent = '';
    if (typeof lastUserMsg.content === 'string') {
      userMessageContent = lastUserMsg.content;
    } else if (Array.isArray(lastUserMsg.parts)) {
      userMessageContent = lastUserMsg.parts
        .filter(
          (p: any) => p && p.type === 'text' && typeof p.text === 'string',
        )
        .map((p: any) => p.text)
        .join('');
    } else {
      throw new BadRequestException('Invalid message format');
    }

    const contentTrimmed = userMessageContent.trim();
    if (contentTrimmed.length === 0) {
      throw new BadRequestException('Message content cannot be empty');
    }

    if (contentTrimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
      throw new BadRequestException(
        `Message is too long (maximum ${MAX_CHAT_MESSAGE_LENGTH} characters)`,
      );
    }

    // Sanitize user message content
    const sanitizedContent = contentTrimmed
      .replace(/<script[^>]*>([\S\s]*?)<\/script>/gi, '')
      .replace(/<\/?[^>]+(>|$)/g, '');

    if (typeof lastUserMsg.content === 'string') {
      lastUserMsg.content = sanitizedContent;
    } else if (Array.isArray(lastUserMsg.parts)) {
      const textPartIndex = lastUserMsg.parts.findIndex(
        (p: any) => p && p.type === 'text',
      );
      if (textPartIndex !== -1) {
        lastUserMsg.parts[textPartIndex].text = sanitizedContent;
      } else {
        lastUserMsg.parts.push({ type: 'text', text: sanitizedContent });
      }
    }

    if (messages.length > MAX_CHAT_HISTORY_MESSAGES) {
      throw new BadRequestException(
        `Conversation message limit reached (maximum ${MAX_CHAT_HISTORY_MESSAGES} messages).`,
      );
    }

    // Rate Limiting
    const rateLimitKey = userId ? `user:${userId}` : `ip:${ipAddress}`;
    const limitCount = userId ? 50 : 15;

    // Check rapid fire (min 1s between sends)
    const rapidKey = `rapid:${rateLimitKey}`;
    const rapidCheck = checkRateLimit(rapidKey, 1, 1000);
    if (!rapidCheck.allowed) {
      throw new HttpException(
        'Please wait a moment before sending another message.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Check hourly limit
    const limitCheck = checkRateLimit(rateLimitKey, limitCount);
    if (!limitCheck.allowed) {
      const friendlyMsg = userId
        ? 'Rate limit reached. Please wait a moment and try again later! ⏳'
        : "You've reached the message limit for public sessions. Please register or log in to get higher limits and unlocked features! 🔑";

      throw new HttpException(
        {
          error: friendlyMsg,
          rateLimited: true,
          resetAt: limitCheck.resetAt,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Log message event
    if (sessionId) {
      this.analyticsService
        .logEvent({
          sessionId,
          userId,
          ipAddress,
          eventName: 'send_message',
          metadata: { messageLength: userMessageContent.length },
        })
        .catch(() => {});
    }

    // Detect and translate Sinhala/Singlish/Tanglish using Gemini
    const translationResult = await this.translateInput(sanitizedContent);
    const targetLang = translationResult.detectedLanguage; // 'sinhala' | 'singlish' | 'tanglish' | 'english'
    const translatedText = translationResult.translatedText;

    // Attach translation metadata to the user's message
    lastUserMsg.metadata = {
      originalText: sanitizedContent,
      englishText: translatedText,
      detectedLanguage: targetLang,
    };

    // ── Convert the mixed message history to clean ModelMessages ──────────────
    // The DB stores a mix of:
    //   • UIMessages  (role user/assistant with `parts[]` — sent by the frontend)
    //   • ModelMessages (role assistant/tool with `content[]` — saved from response.messages in onFinish)
    // `convertToModelMessages` only accepts UIMessages, so we build ModelMessages ourselves.
    const converted = toModelMessages(messages);

    // ── Extract search context for anti-duplication ──────────────────────────
    // Scan the conversation history for previously shown product IDs and
    // the last pagination cursor for each query string.
    const searchContext = extractSearchContext(converted);

    // ── Build dynamic system prompt options ─────────────────────────────────
    const promptOptions: SystemPromptOptions = {};

    // 1. Cart context — inject if frontend sent non-empty cartItems
    if (Array.isArray(cartItems) && cartItems.length > 0) {
      const cartLines = cartItems
        .map((item) => {
          const price = item.price
            ? ` (Rs. ${item.price.toLocaleString()})`
            : '';
          return `- ${item.qty}x ${item.name}${price}`;
        })
        .join('\n');
      promptOptions.cartContext = cartLines;
    }

    // 2. Known delivery date — scan all user messages for temporal references
    const knownDate = extractKnownDeliveryDate(messages);
    if (knownDate) {
      promptOptions.knownDate = knownDate;
    }

    // 3. Purchase-intent detection — if user is saying "give them to me" etc.,
    //    log it so the AI gets the enriched system prompt context
    const purchaseIntentDetected = hasPurchaseIntent(sanitizedContent);
    if (purchaseIntentDetected) {
      this.logger.log(
        `[Intent] Purchase intent detected in: "${sanitizedContent.slice(0, 80)}"`,
      );
    }

    // Save initial message history
    if (sessionId) {
      await this.findOrCreateSession(sessionId, userId);
      await this.saveInitialTurn(
        sessionId,
        sanitizedContent,
        lastUserMsg.metadata,
      ).catch(() => {});
    }

    const systemPrompt = getSystemPrompt(promptOptions);
    const tokenCount = this.estimateTokenCount(converted, systemPrompt);
    const groqModel =
      tokenCount > 12000 ? 'llama-3.1-8b-instant' : 'llama-3.3-70b-versatile';

    const available = getAvailableModels();
    const modelsPool: string[] = [];
    if (available.includes('gemini-3.5-flash'))
      modelsPool.push('gemini-3.5-flash');
    if (available.includes('gemini-3.1-flash-lite'))
      modelsPool.push('gemini-3.1-flash-lite');
    modelsPool.push(groqModel);

    let streamResult: any = null;
    let successfulModel = '';
    let lastError: any = null;
    let modelIndex = 0;

    let failedOnGemini = false;
    let failedOnGroq = false;

    // Call models in chain until one succeeds or all fail
    while (modelIndex < modelsPool.length) {
      const modelName = modelsPool[modelIndex];
      try {
        this.logger.log(
          `Attempting generation with "${modelName}" (estimated tokens: ${tokenCount})...`,
        );
        const result = streamText({
          model: getModelInstance(modelName),
          system: systemPrompt,
          messages: converted,
          temperature: 0,
          maxRetries: isFallbackModel(modelName) ? 1 : 2,
          tools: {
            // ─── Search Products ──────────────────────────────
            kapruka_search_products: tool({
              description:
                'Search for products on Kapruka.com. Use the "q" parameter for the search query. Returns product cards with prices and images.',
              parameters: z.object({
                q: z
                  .string()
                  .min(3)
                  .describe(
                    "Search query string (e.g. 'chocolate', 'gift basket', 'flowers')",
                  ),
                category: z
                  .string()
                  .optional()
                  .describe(
                    "Category filter (e.g. 'Birthday', 'Cakes', 'Flowers')",
                  ),
                limit: z
                  .number()
                  .min(1)
                  .max(50)
                  .optional()
                  .describe('Results per page, default 10'),
                cursor: z
                  .string()
                  .optional()
                  .describe('Pagination cursor from previous response'),
                min_price: z.number().optional().describe('Min price in LKR'),
                max_price: z.number().optional().describe('Max price in LKR'),
                in_stock_only: z
                  .boolean()
                  .optional()
                  .describe('Only show in-stock items'),
                sort: z
                  .string()
                  .optional()
                  .describe(
                    "Sort order: 'relevance', 'price_asc', 'price_desc', 'newest', 'bestseller'",
                  ),
                page: z
                  .number()
                  .optional()
                  .describe(
                    "The page number of product results to fetch. Defaults to 1. Increment this value by 1 when the user explicitly requests more alternatives, says 'next page', 'show me other options', or implies they want to see more items than what was previously shown.",
                  ),
              }),
              execute: async (args: any) => {
                // Log raw args to debug what the LLM is actually sending
                this.logger.log(
                  `[Tool] kapruka_search_products raw args: ${JSON.stringify(args)}`,
                );

                const toolArgs =
                  args?.params && typeof args.params === 'object'
                    ? { ...args.params, ...args }
                    : args;

                // Try known parameter names first
                let q = (toolArgs.q ||
                  toolArgs.keywords ||
                  toolArgs.query ||
                  toolArgs.keyword ||
                  toolArgs.search ||
                  toolArgs.search_query ||
                  toolArgs.term ||
                  toolArgs.text ||
                  '') as string;

                // Fallback: if q is still empty, scan all string values in args for a usable query
                if (!q.trim()) {
                  for (const [key, val] of Object.entries(toolArgs)) {
                    if (
                      typeof val === 'string' &&
                      val.trim().length >= 3 &&
                      key !== 'category' &&
                      key !== 'sort' &&
                      key !== 'cursor' &&
                      key !== 'response_format' &&
                      key !== 'toolCallId'
                    ) {
                      this.logger.log(
                        `[Tool] Using fallback param "${key}" = "${val}" as search query`,
                      );
                      q = val.trim();
                      break;
                    }
                  }
                }

                // Guard: don't call MCP with empty query — it returns nothing and wastes steps
                if (!q.trim()) {
                  this.logger.warn(
                    `[Tool] kapruka_search_products called with empty query. Args: ${JSON.stringify(args)}`,
                  );
                  return {
                    error: 'empty_query',
                    message:
                      'Search query cannot be empty. Please provide a search term (e.g. "flowers", "chocolate", "birthday cake"). Use the "q" parameter.',
                    results: [],
                  };
                }

                const params: Record<string, any> = {
                  q: q.trim(),
                  response_format: 'json',
                };
                if (toolArgs.category) params.category = toolArgs.category;
                if (toolArgs.limit) params.limit = toolArgs.limit;
                if (toolArgs.min_price !== undefined)
                  params.min_price = toolArgs.min_price;
                if (toolArgs.max_price !== undefined)
                  params.max_price = toolArgs.max_price;
                if (toolArgs.in_stock_only !== undefined)
                  params.in_stock_only = toolArgs.in_stock_only;
                if (toolArgs.sort) params.sort = toolArgs.sort;

                // ── Auto-pagination: inject cursor for repeated queries ──
                // If the model searched for the same query before and didn't
                // pass a cursor, auto-inject the last cursor to get next page
                if (toolArgs.cursor) {
                  params.cursor = toolArgs.cursor;
                } else if (toolArgs.page !== undefined && toolArgs.page > 1) {
                  const limit = toolArgs.limit || 10;
                  const offset = limit * (toolArgs.page - 1);
                  const offsetBase64 = Buffer.from(String(offset)).toString(
                    'base64',
                  );
                  const generatedCursor = Buffer.from(
                    JSON.stringify({
                      u: offsetBase64,
                      p: toolArgs.page,
                    }),
                  ).toString('base64');
                  this.logger.log(
                    `[Tool] Generating cursor for page ${toolArgs.page}: ${generatedCursor}`,
                  );
                  params.cursor = generatedCursor;
                } else {
                  const queryKey = q.trim().toLowerCase();
                  const savedCursor =
                    searchContext.lastCursorsByQuery.get(queryKey);
                  if (savedCursor) {
                    this.logger.log(
                      `[Tool] Auto-injecting pagination cursor for repeated query "${queryKey}": ${savedCursor}`,
                    );
                    params.cursor = savedCursor;
                  }
                }

                this.logger.log(
                  `[Tool] kapruka_search_products: q="${q.trim()}", category=${toolArgs.category || 'none'}, cursor=${params.cursor || 'none'}`,
                );
                const result = await callMcpTool('kapruka_search_products', {
                  params,
                });
                this.logger.log(
                  `[Tool] kapruka_search_products returned ${result?.results?.length || 0} results, next_cursor=${result?.next_cursor || 'none'}`,
                );

                const currentPage = args.page || 1;
                const limit = args.limit || 10;
                const enrichedResult = {
                  ...result,
                  currentPage,
                  totalResults: result?.results?.length
                    ? result.results.length < limit && currentPage === 1
                      ? result.results.length
                      : undefined
                    : 0,
                  hasNextPage: !!result?.next_cursor,
                };

                // ── Update search context for subsequent tool calls in the same turn ──
                if (result?.next_cursor) {
                  searchContext.lastCursorsByQuery.set(
                    q.trim().toLowerCase(),
                    result.next_cursor,
                  );
                }
                if (Array.isArray(result?.results)) {
                  for (const p of result.results) {
                    if (p.product_id)
                      searchContext.shownProductIds.add(p.product_id);
                  }
                }

                if (sessionId) {
                  this.analyticsService
                    .logEvent({
                      sessionId,
                      userId,
                      ipAddress,
                      eventName: 'product_search',
                      metadata: {
                        query: q.trim(),
                        category: args.category,
                        resultsCount: result?.results?.length || 0,
                        cursor: params.cursor || null,
                        nextCursor: result?.next_cursor || null,
                        currentPage,
                        totalResults: enrichedResult.totalResults || null,
                        hasNextPage: enrichedResult.hasNextPage,
                      },
                    })
                    .catch(() => {});
                }

                return enrichedResult;
              },
            } as any),

            // ─── Get Product Details ──────────────────────────
            kapruka_get_product: tool({
              description:
                'Get full details for a single Kapruka product by its product ID.',
              parameters: z.object({
                product_id: z
                  .string()
                  .describe("Kapruka product ID (e.g. 'cake00ka002034')"),
              }),
              execute: async (args: any) => {
                const productId = (args.product_id ||
                  args.productId ||
                  '') as string;
                const params: Record<string, any> = {
                  product_id: productId,
                  response_format: 'json',
                };
                if (args.currency) params.currency = args.currency;
                if (args.type) params.type = args.type;

                this.logger.log(
                  `[Tool] kapruka_get_product: id="${productId}"`,
                );
                const result = await callMcpTool('kapruka_get_product', {
                  params,
                });

                if (sessionId && result) {
                  this.analyticsService
                    .logProductView({
                      sessionId,
                      userId,
                      productId,
                      productName: result.name || 'Unknown Product',
                      price: result.price?.amount || 0,
                      imageUrl: result.image_url || undefined,
                    })
                    .catch(() => {});
                }

                return result
                  ? {
                      ...result,
                      cart: args.cart,
                      recipient: args.recipient,
                      delivery: args.delivery,
                      sender: args.sender,
                      gift_message: args.gift_message,
                    }
                  : result;
              },
            } as any),

            // ─── List Categories ──────────────────────────────
            kapruka_list_categories: tool({
              description:
                'List top-level Kapruka product categories with browse URLs.',
              parameters: z.object({
                depth: z
                  .number()
                  .min(1)
                  .max(2)
                  .optional()
                  .describe('Sub-category levels (1 or 2), default 1'),
              }),
              execute: async (args: any) => {
                const params: Record<string, any> = { response_format: 'json' };
                if (args.depth !== undefined) params.depth = args.depth;

                this.logger.log(
                  `[Tool] kapruka_list_categories: depth=${args.depth || 1}`,
                );
                const result = await callMcpTool('kapruka_list_categories', {
                  params,
                });

                if (sessionId) {
                  this.analyticsService
                    .logEvent({
                      sessionId,
                      userId,
                      ipAddress,
                      eventName: 'list_categories',
                      metadata: { depth: args.depth },
                    })
                    .catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── List Delivery Cities ─────────────────────────
            kapruka_list_delivery_cities: tool({
              description:
                'Search Sri Lankan cities Kapruka delivers to. Use to validate city names before checking delivery.',
              parameters: z.object({
                query: z
                  .string()
                  .optional()
                  .describe("City name search (e.g. 'Colombo', 'Kandy')"),
                limit: z
                  .number()
                  .min(1)
                  .max(50)
                  .optional()
                  .describe('Max results, default 10'),
              }),
              execute: async (args: any) => {
                const query = (args.query ||
                  args.q ||
                  args.city ||
                  '') as string;
                const params: Record<string, any> = {
                  query,
                  response_format: 'json',
                };
                if (args.limit !== undefined) params.limit = args.limit;
                const result = await callMcpTool(
                  'kapruka_list_delivery_cities',
                  { params },
                );

                if (sessionId) {
                  this.analyticsService
                    .logEvent({
                      sessionId,
                      userId,
                      ipAddress,
                      eventName: 'list_cities',
                      metadata: { query, resultsCount: result?.length || 0 },
                    })
                    .catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── Check Delivery ───────────────────────────────
            kapruka_check_delivery: tool({
              description:
                'Check whether Kapruka can deliver to a city on a given date, and the delivery rate. Pass product_id for perishable warnings.',
              parameters: z.object({
                city: z
                  .string()
                  .describe("Canonical city name (e.g. 'Colombo 03', 'Kandy')"),
                delivery_date: z
                  .string()
                  .optional()
                  .describe('Delivery date (YYYY-MM-DD), defaults to today'),
                product_id: z
                  .string()
                  .optional()
                  .describe(
                    'Product ID — enables perishable warning for cakes/flowers',
                  ),
              }),
              execute: async (args: any) => {
                const city = (args.city || args.cityName || '') as string;
                const deliveryDate = (args.delivery_date ||
                  args.deliveryDate ||
                  '') as string;
                const productId = (args.product_id ||
                  args.productId ||
                  '') as string;
                const params: Record<string, any> = {
                  city,
                  response_format: 'json',
                };
                if (deliveryDate) params.delivery_date = deliveryDate;
                if (productId) params.product_id = productId;
                const result = await callMcpTool('kapruka_check_delivery', {
                  params,
                });

                if (sessionId && result) {
                  this.analyticsService
                    .logDeliveryCheck({
                      sessionId,
                      userId,
                      city: result.city,
                      date: result.checked_date,
                      productId: productId || undefined,
                      available: result.available,
                      rate: result.rate,
                      perishableWarning: !!result.perishable_warning,
                    })
                    .catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── Create Order ─────────────────────────────────
            kapruka_create_order: tool({
              description:
                'Create a guest-checkout order on Kapruka and get a payment link. Collect all details before calling.',
              parameters: z.object({
                cart: z.array(
                  z.object({
                    product_id: z.string(),
                    quantity: z
                      .number()
                      .optional()
                      .describe('Quantity, default 1'),
                    icing_text: z.string().optional(),
                  }),
                ),
                recipient: z.object({
                  name: z.string(),
                  phone: z.string(),
                }),
                delivery: z.object({
                  address: z.string(),
                  city: z.string(),
                  location_type: z
                    .string()
                    .optional()
                    .describe(
                      "Location type: 'house', 'apartment', 'office', 'other'. Default 'house'",
                    ),
                  date: z.string(),
                  instructions: z.string().optional(),
                }),
                sender: z.object({
                  name: z.string(),
                  anonymous: z.boolean().optional().describe('Default false'),
                }),
                gift_message: z.string().optional(),
              }),
              execute: async (args: any) => {
                if (!userId) {
                  return {
                    error: 'authentication_required',
                    message:
                      'The user is not signed in. You must ask the user to sign in or register using the Profile Menu in the top right of the page before they can create a checkout link.',
                  };
                }
                const params: Record<string, any> = { response_format: 'json' };
                for (const key of [
                  'cart',
                  'recipient',
                  'delivery',
                  'sender',
                  'gift_message',
                  'currency',
                ]) {
                  if (args[key] !== undefined) params[key] = args[key];
                }
                const result = await callMcpTool('kapruka_create_order', {
                  params,
                });

                if (sessionId && result?.order_ref && result?.checkout_url) {
                  this.analyticsService
                    .logOrder({
                      sessionId,
                      userId,
                      orderRef: result.order_ref,
                      checkoutUrl: result.checkout_url,
                      cart: args.cart,
                      recipient: args.recipient,
                      delivery: args.delivery,
                      sender: args.sender,
                      summary: {
                        subtotal: result.summary?.items_total || 0,
                        deliveryRate: result.summary?.delivery_fee || 0,
                        total: result.summary?.grand_total || 0,
                      },
                      status: 'created',
                    })
                    .catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── Track Order ──────────────────────────────────
            kapruka_track_order: tool({
              description:
                'Track a Kapruka order by order number (from confirmation email, not the checkout order_ref).',
              parameters: z.object({
                order_number: z
                  .string()
                  .describe('Order number from confirmation email'),
              }),
              execute: async (args: any) => {
                const orderNumber = (args.order_number ||
                  args.orderNumber ||
                  '') as string;
                const params: Record<string, any> = {
                  order_number: orderNumber,
                  response_format: 'json',
                };
                const result = await callMcpTool('kapruka_track_order', {
                  params,
                });

                if (sessionId) {
                  this.analyticsService
                    .logEvent({
                      sessionId,
                      userId,
                      ipAddress,
                      eventName: 'track_order',
                      metadata: { orderNumber, status: result?.status_display },
                    })
                    .catch(() => {});
                }

                return result;
              },
            } as any),
          },
          stopWhen: stepCountIs(10),
          onFinish: async ({ response, usage }) => {
            if (sessionId) {
              setImmediate(() => {
                void (async () => {
                  try {
                    const messagesToSave = JSON.parse(
                      JSON.stringify(response.messages),
                    );

                    let responseText = '';
                    let originalText = '';

                    for (const msg of messagesToSave) {
                      if (msg.role === 'assistant') {
                        if (typeof msg.content === 'string') {
                          const originalEnglish = msg.content;
                          let processedText =
                            this.sanitizeIdentity(originalEnglish);
                          if (
                            targetLang === 'sinhala' ||
                            targetLang === 'singlish' ||
                            targetLang === 'tanglish'
                          ) {
                            processedText = await this.translateOutput(
                              processedText,
                              targetLang,
                            );
                            processedText =
                              this.sanitizeIdentity(processedText);
                          }
                          msg.content = processedText;
                          msg.metadata = {
                            englishText: originalEnglish,
                            originalText: processedText,
                          };
                          responseText = processedText;
                          originalText = originalEnglish;
                        } else if (Array.isArray(msg.content)) {
                          for (const part of msg.content) {
                            if (
                              part.type === 'text' &&
                              typeof part.text === 'string'
                            ) {
                              const originalEnglish = part.text;
                              let processedText =
                                this.sanitizeIdentity(originalEnglish);
                              if (
                                targetLang === 'sinhala' ||
                                targetLang === 'singlish' ||
                                targetLang === 'tanglish'
                              ) {
                                processedText = await this.translateOutput(
                                  processedText,
                                  targetLang,
                                );
                                processedText =
                                  this.sanitizeIdentity(processedText);
                              }
                              part.text = processedText;
                              part.metadata = {
                                englishText: originalEnglish,
                                originalText: processedText,
                              };
                              responseText += processedText;
                              originalText += originalEnglish;
                            }
                          }
                        }
                      }
                    }

                    // Retrieve the latest turn for this session which has a null response
                    let turn = await this.turnRepo.findOne({
                      where: { sessionId, finalAgentResponse: IsNull() },
                      order: { createdAt: 'DESC' },
                    });

                    if (!turn) {
                      // Fallback: create a new turn if none exists
                      turn = this.turnRepo.create({
                        sessionId,
                        userPrompt: userMessageContent,
                        metadata: lastUserMsg.metadata,
                      });
                      await this.turnRepo.save(turn);
                    }

                    // Update the turn with final response and token usage
                    turn.finalAgentResponse = responseText;
                    if (turn.metadata) {
                      turn.metadata.assistantEnglishText = originalText;
                    } else {
                      turn.metadata = { assistantEnglishText: originalText };
                    }
                    turn.promptTokens = (usage as any)?.promptTokens || 0;
                    turn.completionTokens =
                      (usage as any)?.completionTokens || 0;
                    await this.turnRepo.save(turn);

                    // Parse and save tool call step traces in batch
                    const tracesToSave: Partial<StepTraceEntity>[] = [];
                    for (const msg of response.messages) {
                      if (
                        msg.role === 'assistant' &&
                        Array.isArray(msg.content)
                      ) {
                        for (const part of msg.content) {
                          if (part.type === 'tool-call') {
                            let outputPayload: any = null;
                            const toolMsg = response.messages.find(
                              (m: any) =>
                                m.role === 'tool' &&
                                Array.isArray(m.content) &&
                                m.content.some(
                                  (c: any) => c.toolCallId === part.toolCallId,
                                ),
                            );
                            if (toolMsg) {
                              const resultPart = (
                                toolMsg.content as any[]
                              ).find(
                                (c: any) => c.toolCallId === part.toolCallId,
                              );
                              outputPayload =
                                resultPart?.result ?? resultPart?.output;
                            }

                            tracesToSave.push({
                              stepType: StepType.MCP_TOOL_CALL,
                              nodeName: part.toolName,
                              inputPayload: {
                                ...(part as any).args,
                                toolCallId: part.toolCallId,
                                ...((part as any).providerOptions
                                  ? {
                                      providerOptions: (part as any)
                                        .providerOptions,
                                    }
                                  : {}),
                              },
                              outputPayload: outputPayload
                                ? typeof outputPayload === 'object'
                                  ? outputPayload
                                  : { value: outputPayload }
                                : null,
                            });
                          }
                        }
                      }
                    }

                    if (tracesToSave.length > 0) {
                      await this.saveStepTraces(turn.id, tracesToSave);
                    }
                  } catch (err) {
                    this.logger.error(
                      'Error saving turn/traces in onFinish:',
                      err,
                    );
                  }
                })();
              });
            }
          },
        });

        // 1. Generate the raw message stream response from AI SDK
        const response = result.toUIMessageStreamResponse();

        // 2. Probe the first few chunks of the stream to catch immediate errors (e.g. 503 high demand, 429 quota)
        if (response.body) {
          const reader = response.body.getReader();
          const probedChunks: Uint8Array[] = [];
          let streamFailed = false;
          let streamError: any = null;

          try {
            // Read up to 3 chunks to bypass initial dummy/protocol chunks and check for errors
            for (let i = 0; i < 3; i++) {
              const { done, value } = await reader.read();
              if (done) break;
              probedChunks.push(value);

              const text = new TextDecoder().decode(value);
              if (
                text.includes('"type":"error"') ||
                text.includes('"errorText"')
              ) {
                streamFailed = true;
                streamError = new Error(text);
                break;
              }
              // If we see actual text content (protocol '0:'), it's a success
              if (text.includes('0:')) {
                break;
              }
            }
          } catch (err) {
            streamFailed = true;
            streamError = err;
          }

          if (streamFailed) {
            reader.releaseLock();
            throw streamError; // This lets the catch block mark the model as failed and continue the loop!
          }

          // 3. Recreate the stream to include the chunks we read for probing
          const rawStream = new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const chunk of probedChunks) {
                controller.enqueue(chunk);
              }
            },
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  reader.releaseLock();
                } else {
                  controller.enqueue(value);
                }
              } catch (err: any) {
                const errorType = classifyRateLimitError(err);
                if (errorType === 'RPD') {
                  logExecutionCycle(
                    modelName,
                    'FALLBACK_TRIGGERED',
                    'RPD_LIMIT',
                    'SWAPPED_MODEL',
                  );
                  markModelFailed(modelName, 24 * 60 * 60 * 1000);
                } else if (errorType === 'RPM') {
                  logExecutionCycle(
                    modelName,
                    'FALLBACK_TRIGGERED',
                    'RPM_LIMIT',
                    'SWAPPED_MODEL',
                  );
                  markModelFailed(modelName, 60000);
                } else if (errorType === 'TPM') {
                  logExecutionCycle(
                    modelName,
                    'FALLBACK_TRIGGERED',
                    'TPM_LIMIT',
                    'SLEEP_60S',
                  );
                  markModelFailed(modelName, 60000);
                } else {
                  markModelFailed(modelName, 60000);
                }
                controller.error(err);
                reader.releaseLock();
              }
            },
            cancel() {
              void reader.cancel();
              reader.releaseLock();
            },
          });

          // Strip providerMetadata, thoughtSignature, toolCallId and blocked
          // event types before the stream reaches the public client.
          const filteredStream = filterResponseStream(rawStream);

          // Apply translation and identity sanitization to the stream
          const processedStream = this.processResponseStream(
            filteredStream,
            targetLang,
            modelName,
          );

          const headers = new Headers(response.headers);
          headers.set('x-model-used', modelName);

          streamResult = new Response(processedStream, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } else {
          streamResult = response;
        }

        successfulModel = modelName;
        logExecutionCycle(modelName, 'SUCCESS', 'NONE', 'PROCEEDED');
        break; // Success, stop trying other models!
      } catch (err: any) {
        const errorType = classifyRateLimitError(err);
        const isGemini = modelName.startsWith('gemini-');
        const isGroq = modelName.startsWith('llama-');

        if (isGemini) failedOnGemini = true;
        if (isGroq) failedOnGroq = true;

        this.logger.warn(
          `[Model Provider] Model "${modelName}" failed. Classification: ${errorType}. Error: ${err?.message || err}`,
        );

        // STEP 4: Hard backoff block (Sequential failure of both systems)
        if (failedOnGemini && failedOnGroq) {
          this.logger.warn(
            `Both Gemini and Groq failed sequentially. Triggering hard 60s backoff sleep...`,
          );
          logExecutionCycle(
            modelName,
            'FALLBACK_TRIGGERED',
            'NONE',
            'SLEEP_60S',
          );
          await new Promise((resolve) => setTimeout(resolve, 60000));

          clearCooldowns();
          failedOnGemini = false;
          failedOnGroq = false;
          modelIndex = 0;
          continue;
        }

        // STEP 2: Gemini TPM Exhausted -> Route directly to Groq immediately
        if (errorType === 'TPM' && isGemini) {
          logExecutionCycle(
            modelName,
            'FALLBACK_TRIGGERED',
            'TPM_LIMIT',
            'SWAPPED_MODEL',
          );
          this.logger.log(
            `[Model Provider] Gemini TPM limit hit. Bypassing Google ecosystem; swapping directly to Groq model: ${groqModel}`,
          );
          markModelFailed('gemini-3.5-flash', 60000);
          markModelFailed('gemini-3.1-flash-lite', 60000);

          modelIndex = modelsPool.indexOf(groqModel);
          continue;
        }

        lastError = err;

        if (errorType === 'RPD') {
          logExecutionCycle(
            modelName,
            'FALLBACK_TRIGGERED',
            'RPD_LIMIT',
            'SWAPPED_MODEL',
          );
          markModelFailed(modelName, 24 * 60 * 60 * 1000);

          // If both Gemini models are exhausted, failover directly to Groq
          if (
            isGemini &&
            (modelName === 'gemini-3.1-flash-lite' ||
              !available.includes('gemini-3.1-flash-lite'))
          ) {
            modelIndex = modelsPool.indexOf(groqModel);
          } else {
            modelIndex++;
          }
        } else if (errorType === 'RPM') {
          logExecutionCycle(
            modelName,
            'FALLBACK_TRIGGERED',
            'RPM_LIMIT',
            'SWAPPED_MODEL',
          );
          markModelFailed(modelName, 60000);

          // If gemini-3.1-flash-lite RPM is hit, cycle directly to Groq
          if (isGemini && modelName === 'gemini-3.1-flash-lite') {
            modelIndex = modelsPool.indexOf(groqModel);
          } else {
            modelIndex++;
          }
        } else {
          logExecutionCycle(
            modelName,
            'FALLBACK_TRIGGERED',
            'NONE',
            'SWAPPED_MODEL',
          );
          markModelFailed(modelName, 60000);
          modelIndex++;
        }
      }
    }

    if (!streamResult) {
      throw (
        lastError || new Error('All AI models in the fallback chain failed.')
      );
    }

    this.logger.log(
      `Successfully streaming response using model: ${successfulModel}`,
    );
    return streamResult;
  }

  async listDeliveryCities(query?: string, limit = 20): Promise<string[]> {
    const params: Record<string, any> = { response_format: 'json', limit };
    if (query) params.query = query;
    const result = await callMcpTool('kapruka_list_delivery_cities', {
      params,
    });
    if (result && result.cities && Array.isArray(result.cities)) {
      return result.cities.map((c: any) => c.name);
    }
    if (Array.isArray(result)) {
      return result.map((c: any) => (typeof c === 'string' ? c : c.name || ''));
    }
    return [];
  }

  async createQuickOrder(
    body: {
      cart: { product_id: string; quantity: number; icing_text?: string }[];
      recipient: { name: string; phone: string };
      delivery: {
        address: string;
        city: string;
        location_type: string;
        date: string;
        instructions?: string;
      };
      sender: { name: string; anonymous: boolean };
      gift_message?: string;
    },
    sessionId: string | undefined,
    userId: string | undefined,
    ipAddress: string,
  ): Promise<any> {
    const params: Record<string, any> = { response_format: 'json', ...body };
    const result = await callMcpTool('kapruka_create_order', { params });

    if (typeof result === 'string') {
      if (result.startsWith('Error')) {
        throw new BadRequestException(result);
      }
      throw new BadRequestException(`Order creation failed: ${result}`);
    }

    if (!result || !result.checkout_url) {
      throw new BadRequestException(
        'Order creation failed: No checkout URL returned',
      );
    }

    if (result.order_ref && result.checkout_url) {
      // Persist a synthetic confirmation message into conversation history
      if (sessionId) {
        await this.findOrCreateSession(sessionId, userId);

        const turn = this.turnRepo.create({
          sessionId,
          userPrompt: `Quick order placed for product ${body.cart[0]?.product_id}`,
          finalAgentResponse: `Your order has been placed! 🎉`,
          metadata: { isQuickOrder: true },
        });
        await this.turnRepo.save(turn);

        const toolCallId = `quick-order-${Date.now()}`;
        await this.saveStepTraces(turn.id, [
          {
            stepType: StepType.MCP_TOOL_CALL,
            nodeName: 'kapruka_create_order',
            inputPayload: { ...body, toolCallId },
            outputPayload: result,
          },
        ]).catch(() => {});

        this.analyticsService
          .logOrder({
            sessionId,
            userId,
            orderRef: result.order_ref,
            checkoutUrl: result.checkout_url,
            cart: body.cart,
            recipient: body.recipient,
            delivery: body.delivery,
            sender: body.sender,
            summary: {
              subtotal: result.summary?.items_total || 0,
              deliveryRate: result.summary?.delivery_fee || 0,
              total: result.summary?.grand_total || 0,
            },
            status: 'created',
          })
          .catch(() => {});

        this.analyticsService
          .logEvent({
            sessionId,
            userId,
            ipAddress,
            eventName: 'quick_order',
            metadata: {
              orderRef: result.order_ref,
              productId: body.cart[0]?.product_id,
            },
          })
          .catch(() => {});
      }
    }

    return result;
  }

  async cancelOrder(orderRef: string): Promise<void> {
    await this.analyticsService.cancelOrder(orderRef);
  }

  async restoreOrder(orderRef: string): Promise<void> {
    await this.analyticsService.restoreOrder(orderRef);
  }
}

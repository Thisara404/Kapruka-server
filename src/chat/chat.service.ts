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
import { getSystemPrompt } from './system-prompt.js';
import { checkRateLimit } from './rate-limiter.js';
import {
  getAvailableModels,
  markModelFailed,
  getModelInstance,
  isFallbackModel,
} from './model-provider.js';

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
          const t = (part.metadata?.englishText ?? part.text ?? '').trim();
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
            pendingToolResults.push({
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName ?? '',
              result: part.result,
              output: { type: 'json', value: part.result },
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

        toolResults.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? '',
          result: output?.value ?? output,
          output,
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

  async getHistory(sessionId: string, userId?: string): Promise<any[]> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      relations: {
        turns: {
          traces: true,
        },
      },
    });

    if (!session) {
      return [];
    }

    if (userId && !session.externalUserId) {
      this.logger.log(
        `Migrating anonymous session ${sessionId} to user ${userId}`,
      );
      session.externalUserId = userId;
      await this.sessionRepo.save(session);
      // Trigger background analytics migration
      this.analyticsService.migrateSession(sessionId, userId).catch(() => {});
    }

    // Sort turns by createdAt to reconstruct messages in correct chronological order
    const turns = session.turns.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

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
    const existing = await this.turnRepo.findOne({
      where: { sessionId, userPrompt, finalAgentResponse: IsNull() },
      order: { createdAt: 'DESC' },
    });
    if (existing) return existing;

    const turn = this.turnRepo.create({
      sessionId,
      userPrompt,
      metadata,
    });
    return this.turnRepo.save(turn);
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

  async deleteByUserId(userId: string): Promise<any> {
    return this.sessionRepo.delete({ externalUserId: userId });
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

  private async translateInput(text: string): Promise<{
    translatedText: string;
    detectedLanguage: 'sinhala' | 'tanglish' | 'english';
  }> {
    try {
      this.logger.log(`Translating input message using Gemini...`);
      const response = await generateText({
        model: getModelInstance('gemini-3.5-flash'),
        prompt: `Analyze the language of the following user query for Kapruka shopping.
If it is in Sinhala script (සිංහල), translate it to standard English and respond in this exact format: "sinhala: [English translation]".
If it is in Singlish/Tanglish (Sinhala/Tamil transliterated in English script, e.g. "cake monada thiyenne", "oyala delivery karanawada"), translate it to standard English and respond in this exact format: "tanglish: [English translation]".
If it is already in English, return it exactly as-is and respond in this exact format: "english: [Original query]".

Respond ONLY in the format "language: translation". Do not add any explanation or other text.

Query: "${text}"`,
        maxRetries: 1,
      });

      const responseText = response.text.trim();
      const firstColon = responseText.indexOf(':');
      if (firstColon !== -1) {
        const language = responseText
          .substring(0, firstColon)
          .trim()
          .toLowerCase();
        const translation = responseText.substring(firstColon + 1).trim();
        if (
          language === 'sinhala' ||
          language === 'tanglish' ||
          language === 'english'
        ) {
          return {
            translatedText: translation,
            detectedLanguage: language,
          };
        }
      }
      return { translatedText: text, detectedLanguage: 'english' };
    } catch (err: any) {
      this.logger.warn(
        `Gemini input translation failed (falling back to raw text): ${err.message || err}`,
      );
      return { translatedText: text, detectedLanguage: 'english' };
    }
  }

  private async translateOutput(
    text: string,
    targetLang: 'sinhala' | 'tanglish',
  ): Promise<string> {
    if (!text || !text.trim()) return text;
    try {
      this.logger.log(
        `Translating assistant output to ${targetLang} using Gemini...`,
      );
      const prompt =
        targetLang === 'sinhala'
          ? `Translate the following English e-commerce assistant text into warm, friendly, natural Sinhala (සිංහල). Keep product names, prices (e.g. Rs. 3,500), and product IDs in English. Return ONLY the translated Sinhala text. Do not add any introduction, explanations, or note.
Text: "${text}"`
          : `Translate the following English e-commerce assistant text into warm, friendly, natural Singlish/Tanglish (Sinhala/Tamil written in English characters, e.g., "oya" instead of "you", "thiyenne" instead of "available"). Keep product names, prices, and IDs in English. Return ONLY the translated transliterated text. Do not add any introduction, explanations, or note.
Text: "${text}"`;

      const response = await generateText({
        model: getModelInstance('gemini-3.5-flash'),
        prompt,
        maxRetries: 1,
      });

      return response.text.trim();
    } catch (err: any) {
      this.logger.warn(
        `Gemini output translation to ${targetLang} failed (falling back to raw English): ${err.message || err}`,
      );
      return text;
    }
  }

  private processResponseStream(
    inputStream: ReadableStream<Uint8Array>,
    targetLang: 'sinhala' | 'tanglish' | 'english',
  ): ReadableStream<Uint8Array> {
    const reader = inputStream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let sentenceBuffer = '';

    const processText = async (englishText: string): Promise<string> => {
      let resultText = englishText;
      resultText = this.sanitizeIdentity(resultText);
      if (targetLang === 'sinhala' || targetLang === 'tanglish') {
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

                  if (targetLang === 'sinhala' || targetLang === 'tanglish') {
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
    body: { messages: any[]; sessionId: string },
    ipAddress: string,
    userId?: string,
  ): Promise<any> {
    const { messages, sessionId } = body;

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
      if (dbMsg && dbMsg.metadata) {
        msg.metadata = dbMsg.metadata;
      }
      if (dbMsg && Array.isArray(dbMsg.parts) && Array.isArray(msg.parts)) {
        for (let i = 0; i < msg.parts.length; i++) {
          if (dbMsg.parts[i] && dbMsg.parts[i].metadata) {
            msg.parts[i].metadata = dbMsg.parts[i].metadata;
          }
        }
      }
      if (dbMsg && Array.isArray(dbMsg.content) && Array.isArray(msg.content)) {
        for (let i = 0; i < msg.content.length; i++) {
          if (dbMsg.content[i] && dbMsg.content[i].metadata) {
            msg.content[i].metadata = dbMsg.content[i].metadata;
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

    if (contentTrimmed.length > 2000) {
      throw new BadRequestException(
        'Message is too long (maximum 2000 characters)',
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

    if (messages.length > 200) {
      throw new BadRequestException(
        'Conversation message limit reached (maximum 200 messages).',
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

    // Detect and translate Sinhala/Tanglish using Gemini
    const translationResult = await this.translateInput(sanitizedContent);
    const targetLang = translationResult.detectedLanguage; // 'sinhala' | 'tanglish' | 'english'
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

    // Save initial message history
    if (sessionId) {
      await this.findOrCreateSession(sessionId, userId);
      await this.saveInitialTurn(
        sessionId,
        sanitizedContent,
        lastUserMsg.metadata,
      ).catch(() => {});
    }

    const availableModels = getAvailableModels();
    let streamResult: any = null;
    let successfulModel = '';
    let lastError: any = null;

    // Call models in chain until one succeeds or all fail
    for (const modelName of availableModels) {
      try {
        this.logger.log(`Attempting generation with "${modelName}"...`);
        const result = streamText({
          model: getModelInstance(modelName),
          system: getSystemPrompt(),
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
              }),
              execute: async (args: any) => {
                // Log raw args to debug what the LLM is actually sending
                this.logger.log(
                  `[Tool] kapruka_search_products raw args: ${JSON.stringify(args)}`,
                );

                // Try known parameter names first
                let q = (args.q ||
                  args.keywords ||
                  args.query ||
                  args.keyword ||
                  args.search ||
                  args.search_query ||
                  args.term ||
                  args.text ||
                  '') as string;

                // Fallback: if q is still empty, scan all string values in args for a usable query
                if (!q.trim()) {
                  for (const [key, val] of Object.entries(args)) {
                    if (
                      typeof val === 'string' &&
                      val.trim().length >= 3 &&
                      key !== 'category' &&
                      key !== 'sort' &&
                      key !== 'cursor' &&
                      key !== 'response_format'
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
                if (args.category) params.category = args.category;
                if (args.limit) params.limit = args.limit;
                if (args.cursor) params.cursor = args.cursor;
                if (args.min_price !== undefined)
                  params.min_price = args.min_price;
                if (args.max_price !== undefined)
                  params.max_price = args.max_price;
                if (args.in_stock_only !== undefined)
                  params.in_stock_only = args.in_stock_only;
                if (args.sort) params.sort = args.sort;

                this.logger.log(
                  `[Tool] kapruka_search_products: q="${q.trim()}", category=${args.category || 'none'}`,
                );
                const result = await callMcpTool('kapruka_search_products', {
                  params,
                });
                this.logger.log(
                  `[Tool] kapruka_search_products returned ${result?.results?.length || 0} results`,
                );

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
                      },
                    })
                    .catch(() => {});
                }

                return result;
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

                return result;
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

                if (sessionId && result) {
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
          stopWhen: stepCountIs(5),
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

        // 2. Probe the first chunk of the stream to catch immediate errors (e.g. 503 high demand, 429 quota)
        if (response.body) {
          const reader = response.body.getReader();
          let firstChunk: Uint8Array | null = null;
          let streamFailed = false;
          let streamError: any = null;

          try {
            const { done, value } = await reader.read();
            if (!done) {
              firstChunk = value;
            }
          } catch (err) {
            streamFailed = true;
            streamError = err;
          }

          if (streamFailed) {
            reader.releaseLock();
            throw streamError; // This lets the catch block mark the model as failed and continue the loop!
          }

          // 3. Recreate the stream to include the first chunk we read for probing
          const rawStream = new ReadableStream<Uint8Array>({
            async start(controller) {
              if (firstChunk !== null) {
                controller.enqueue(firstChunk);
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
                const errMsg = String(err?.message || err || 'stream error');
                const isCapacityError =
                  errMsg.includes('high demand') ||
                  errMsg.includes('503') ||
                  errMsg.includes('UNAVAILABLE');
                if (isCapacityError) {
                  // Mark cooldown so the next request uses fallback model immediately
                  markModelFailed(modelName, 180000);
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

          // Apply translation and identity sanitization to the stream
          const processedStream = this.processResponseStream(
            rawStream,
            targetLang,
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
        break; // Success, stop trying other models!
      } catch (err: any) {
        this.logger.warn(
          `Model "${modelName}" failed during generation: ${err.message || err}`,
        );
        lastError = err;
        markModelFailed(modelName);
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

  async listDeliveryCities(query?: string, limit = 20): Promise<any[]> {
    const params: Record<string, any> = { response_format: 'json', limit };
    if (query) params.query = query;
    const result = await callMcpTool('kapruka_list_delivery_cities', {
      params,
    });
    return Array.isArray(result) ? result : [];
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

    if (result.checkout_url) {
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
}

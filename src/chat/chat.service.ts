import { Injectable, BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { streamText, tool, convertToModelMessages, stepCountIs } from 'ai';
import { z } from 'zod';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { AnalyticsService } from '../analytics/analytics.service';
import { callMcpTool } from './mcp-client';
import { getSystemPrompt } from './system-prompt';
import { checkRateLimit } from './rate-limiter';
import { getAvailableModels, markModelFailed, getModelInstance } from './model-provider';

@Injectable()
export class ChatService {
  private readonly logger = new Logger('ChatService');

  constructor(
    @InjectModel(Conversation.name) private readonly conversationModel: Model<ConversationDocument>,
    private readonly analyticsService: AnalyticsService,
  ) {}

  async getHistory(sessionId: string, userId?: string): Promise<any[]> {
    const doc = await this.conversationModel.findOne({ sessionId }).exec();
    if (doc) {
      if (userId && !doc.userId) {
        this.logger.log(`Migrating anonymous session ${sessionId} to user ${userId}`);
        await this.conversationModel.updateOne(
          { sessionId },
          { $set: { userId, type: 'user' } }
        ).exec();
        // Trigger background analytics migration
        this.analyticsService.migrateSession(sessionId, userId).catch(() => {});
      }
      return doc.messages || [];
    }
    return [];
  }

  async saveMessages(sessionId: string, messages: any[], userId?: string): Promise<any> {
    return this.conversationModel.updateOne(
      { sessionId },
      {
        $set: {
          messages,
          userId,
          type: userId ? 'user' : 'public',
        },
      },
      { upsert: true }
    ).exec();
  }

  async deleteByUserId(userId: string): Promise<any> {
    return this.conversationModel.deleteMany({ userId }).exec();
  }

  async handleChat(body: { messages: any[]; sessionId: string }, ipAddress: string, userId?: string): Promise<any> {
    const { messages, sessionId } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new BadRequestException('Messages are required');
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
        .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
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
      throw new BadRequestException('Message is too long (maximum 2000 characters)');
    }

    // Sanitize user message content
    const sanitizedContent = contentTrimmed
      .replace(/<script[^>]*>([\S\s]*?)<\/script>/gi, '')
      .replace(/<\/?[^>]+(>|$)/g, '');

    if (typeof lastUserMsg.content === 'string') {
      lastUserMsg.content = sanitizedContent;
    } else if (Array.isArray(lastUserMsg.parts)) {
      const textPartIndex = lastUserMsg.parts.findIndex((p: any) => p && p.type === 'text');
      if (textPartIndex !== -1) {
        lastUserMsg.parts[textPartIndex].text = sanitizedContent;
      } else {
        lastUserMsg.parts.push({ type: 'text', text: sanitizedContent });
      }
    }

    if (messages.length > 200) {
      throw new BadRequestException('Conversation message limit reached (maximum 200 messages).');
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
        HttpStatus.TOO_MANY_REQUESTS
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
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    // Log message event
    if (sessionId) {
      this.analyticsService.logEvent({
        sessionId,
        userId,
        ipAddress,
        eventName: 'send_message',
        metadata: { messageLength: userMessageContent.length },
      }).catch(() => {});
    }

    const converted = await convertToModelMessages(messages);

    // Save initial message history
    if (sessionId) {
      this.saveMessages(sessionId, messages, userId).catch(() => {});
    }

    const availableModels = getAvailableModels();
    let streamResult: any = null;
    let successfulModel = '';
    let lastError: any = null;

    // Call models in chain until one succeeds or all fail
    for (const modelName of availableModels) {
      try {
        this.logger.log(`Attempting generation with "${modelName}"...`);
        const result = await streamText({
          model: getModelInstance(modelName),
          system: getSystemPrompt(),
          messages: converted,
          tools: {
            // ─── Search Products ──────────────────────────────
            kapruka_search_products: tool({
              description:
                "Search for products on Kapruka.com by keyword, with optional category filter and pagination. Queries must be at least 3 characters.",
              parameters: z.object({
                q: z.string().min(3).describe("Search query (e.g. 'chocolate', 'gift basket')"),
                category: z.string().optional().describe("Category filter (e.g. 'Birthday', 'Cakes', 'Flowers')"),
                limit: z.number().min(1).max(50).default(10).describe("Results per page"),
                cursor: z.string().optional().describe("Pagination cursor from previous response"),
                min_price: z.number().optional().describe("Min price in LKR"),
                max_price: z.number().optional().describe("Max price in LKR"),
                in_stock_only: z.boolean().default(false).describe("Only show in-stock items"),
                sort: z.enum(["relevance", "price_asc", "price_desc", "newest", "bestseller"]).default("relevance").describe("Sort order"),
              }),
              execute: async (args: any) => {
                const q = (args.q || args.keywords || args.query || args.keyword || '') as string;
                const params: Record<string, any> = { q, response_format: 'json' };
                for (const key of ['category', 'limit', 'cursor', 'currency', 'min_price', 'max_price', 'in_stock_only', 'sort']) {
                  if (args[key] !== undefined) params[key] = args[key];
                }
                const result = await callMcpTool('kapruka_search_products', { params });

                if (sessionId) {
                  this.analyticsService.logEvent({
                    sessionId,
                    userId,
                    ipAddress,
                    eventName: 'product_search',
                    metadata: {
                      query: q,
                      category: args.category,
                      resultsCount: result?.results?.length || 0,
                    },
                  }).catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── Get Product Details ──────────────────────────
            kapruka_get_product: tool({
              description: "Get full details for a single Kapruka product by its product ID.",
              parameters: z.object({
                product_id: z.string().describe("Kapruka product ID (e.g. 'cake00ka002034')"),
              }),
              execute: async (args: any) => {
                const productId = (args.product_id || args.productId || '') as string;
                const params: Record<string, any> = { product_id: productId, response_format: 'json' };
                for (const key of ['currency', 'type']) {
                  if (args[key] !== undefined) params[key] = args[key];
                }
                const result = await callMcpTool('kapruka_get_product', { params });

                if (sessionId && result) {
                  this.analyticsService.logProductView({
                    sessionId,
                    userId,
                    productId,
                    productName: result.name || 'Unknown Product',
                    price: result.price?.amount || 0,
                    imageUrl: result.image_url || undefined,
                  }).catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── List Categories ──────────────────────────────
            kapruka_list_categories: tool({
              description: "List top-level Kapruka product categories with browse URLs.",
              parameters: z.object({
                depth: z.number().min(1).max(2).default(1).describe("Sub-category levels (1 or 2)"),
              }),
              execute: async (args: any) => {
                const params: Record<string, any> = { response_format: 'json' };
                if (args.depth !== undefined) params.depth = args.depth;
                const result = await callMcpTool('kapruka_list_categories', { params });

                if (sessionId) {
                  this.analyticsService.logEvent({
                    sessionId,
                    userId,
                    ipAddress,
                    eventName: 'list_categories',
                    metadata: { depth: args.depth },
                  }).catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── List Delivery Cities ─────────────────────────
            kapruka_list_delivery_cities: tool({
              description: "Search Sri Lankan cities Kapruka delivers to. Use to validate city names before checking delivery.",
              parameters: z.object({
                query: z.string().optional().describe("City name search (e.g. 'Colombo', 'Kandy')"),
                limit: z.number().min(1).max(50).default(10).describe("Max results"),
              }),
              execute: async (args: any) => {
                const query = (args.query || args.q || args.city || '') as string;
                const params: Record<string, any> = { query, response_format: 'json' };
                if (args.limit !== undefined) params.limit = args.limit;
                const result = await callMcpTool('kapruka_list_delivery_cities', { params });

                if (sessionId) {
                  this.analyticsService.logEvent({
                    sessionId,
                    userId,
                    ipAddress,
                    eventName: 'list_cities',
                    metadata: { query, resultsCount: result?.length || 0 },
                  }).catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── Check Delivery ───────────────────────────────
            kapruka_check_delivery: tool({
              description: "Check whether Kapruka can deliver to a city on a given date, and the delivery rate. Pass product_id for perishable warnings.",
              parameters: z.object({
                city: z.string().describe("Canonical city name (e.g. 'Colombo 03', 'Kandy')"),
                delivery_date: z.string().optional().describe("Delivery date (YYYY-MM-DD), defaults to today"),
                product_id: z.string().optional().describe("Product ID — enables perishable warning for cakes/flowers"),
              }),
              execute: async (args: any) => {
                const city = (args.city || args.cityName || '') as string;
                const deliveryDate = (args.delivery_date || args.deliveryDate || '') as string;
                const productId = (args.product_id || args.productId || '') as string;
                const params: Record<string, any> = { city, response_format: 'json' };
                if (deliveryDate) params.delivery_date = deliveryDate;
                if (productId) params.product_id = productId;
                const result = await callMcpTool('kapruka_check_delivery', { params });

                if (sessionId && result) {
                  this.analyticsService.logDeliveryCheck({
                    sessionId,
                    userId,
                    city: result.city,
                    date: result.checked_date,
                    productId: productId || undefined,
                    available: result.available,
                    rate: result.rate,
                    perishableWarning: !!result.perishable_warning,
                  }).catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── Create Order ─────────────────────────────────
            kapruka_create_order: tool({
              description: "Create a guest-checkout order on Kapruka and get a payment link. Collect all details before calling.",
              parameters: z.object({
                cart: z.array(
                  z.object({
                    product_id: z.string(),
                    quantity: z.number().default(1),
                    icing_text: z.string().optional(),
                  })
                ),
                recipient: z.object({
                  name: z.string(),
                  phone: z.string(),
                }),
                delivery: z.object({
                  address: z.string(),
                  city: z.string(),
                  location_type: z.enum(["house", "apartment", "office", "other"]).default("house"),
                  date: z.string(),
                  instructions: z.string().optional(),
                }),
                sender: z.object({
                  name: z.string(),
                  anonymous: z.boolean().default(false),
                }),
                gift_message: z.string().optional(),
              }),
              execute: async (args: any) => {
                const params: Record<string, any> = { response_format: 'json' };
                for (const key of ['cart', 'recipient', 'delivery', 'sender', 'gift_message', 'currency']) {
                  if (args[key] !== undefined) params[key] = args[key];
                }
                const result = await callMcpTool('kapruka_create_order', { params });

                if (sessionId && result) {
                  this.analyticsService.logOrder({
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
                  }).catch(() => {});
                }

                return result;
              },
            } as any),

            // ─── Track Order ──────────────────────────────────
            kapruka_track_order: tool({
              description: "Track a Kapruka order by order number (from confirmation email, not the checkout order_ref).",
              parameters: z.object({
                order_number: z.string().describe("Order number from confirmation email"),
              }),
              execute: async (args: any) => {
                const orderNumber = (args.order_number || args.orderNumber || '') as string;
                const params: Record<string, any> = { order_number: orderNumber, response_format: 'json' };
                const result = await callMcpTool('kapruka_track_order', { params });

                if (sessionId) {
                  this.analyticsService.logEvent({
                    sessionId,
                    userId,
                    ipAddress,
                    eventName: 'track_order',
                    metadata: { orderNumber, status: result?.status_display },
                  }).catch(() => {});
                }

                return result;
              },
            } as any),
          },
          stopWhen: stepCountIs(5),
          onFinish: async ({ response }) => {
            if (sessionId) {
              const finalMessages = [...messages, ...response.messages];
              this.saveMessages(sessionId, finalMessages, userId).catch(() => {});
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
          const customStream = new ReadableStream<Uint8Array>({
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
              } catch (err) {
                controller.error(err);
                reader.releaseLock();
              }
            },
            cancel() {
              reader.cancel();
              reader.releaseLock();
            }
          });

          const headers = new Headers(response.headers);
          headers.set('x-model-used', modelName);

          streamResult = new Response(customStream, {
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
        this.logger.warn(`Model "${modelName}" failed during generation: ${err.message || err}`);
        lastError = err;
        markModelFailed(modelName);
      }
    }

    if (!streamResult) {
      throw lastError || new Error('All AI models in the fallback chain failed.');
    }

    this.logger.log(`Successfully streaming response using model: ${successfulModel}`);
    return streamResult;
  }
}

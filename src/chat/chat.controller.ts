import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  Query,
  UseGuards,
  HttpStatus,
  HttpException,
  BadRequestException,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { Response } from 'express';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @UseGuards(OptionalJwtAuthGuard)
  async chat(
    @Body() body: { messages: any[]; sessionId: string },
    @Req() req: any,
    @Res() res: Response,
  ) {
    const rawIp =
      req.headers['x-client-ip'] ||
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress ||
      '127.0.0.1';
    const clientIp =
      typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';
    const userId = req.user?.id; // populated by OptionalJwtAuthGuard if authenticated

    try {
      const streamResponse = await this.chatService.handleChat(
        body,
        clientIp,
        userId,
      );

      // Copy headers to Express response
      streamResponse.headers.forEach((val: string, key: string) => {
        res.setHeader(key, val);
      });
      res.status(streamResponse.status);

      // Stream the body chunks
      const reader = streamResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err: any) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err.status || HttpStatus.INTERNAL_SERVER_ERROR;
      res.status(status).json({
        error: err.message || 'An error occurred during generation',
        ...(err.response || {}),
      });
    }
  }

  @Get('history')
  @UseGuards(JwtAuthGuard)
  async history(@Query('sessionId') sessionId: string | undefined, @Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in token');
    }
    if (sessionId) {
      const isOwner = await this.chatService.verifySessionOwner(sessionId, userId);
      if (!isOwner) {
        throw new HttpException('Forbidden session access', HttpStatus.FORBIDDEN);
      }
    }
    const messages = await this.chatService.getHistory(sessionId || null, userId);
    return { messages };
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async getSessions(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in token');
    }
    const sessions = await this.chatService.getSessions(userId);
    return { sessions };
  }

  @Get('cities')
  async cities(@Query('query') query?: string, @Query('limit') limit?: string) {
    const limitNum = limit ? Math.min(parseInt(limit, 10) || 20, 50) : 20;
    const results = await this.chatService.listDeliveryCities(query, limitNum);
    return results;
  }

  @Post('cancel-order')
  @UseGuards(OptionalJwtAuthGuard)
  async cancelOrder(@Body() body: { orderRef: string }) {
    if (!body.orderRef) {
      throw new BadRequestException('orderRef is required');
    }
    await this.chatService.cancelOrder(body.orderRef);
    return { success: true };
  }

  @Post('restore-order')
  @UseGuards(OptionalJwtAuthGuard)
  async restoreOrder(@Body() body: { orderRef: string }) {
    if (!body.orderRef) {
      throw new BadRequestException('orderRef is required');
    }
    await this.chatService.restoreOrder(body.orderRef);
    return { success: true };
  }

  @Post('quick-order')
  @UseGuards(JwtAuthGuard)
  async quickOrder(@Body() body: any, @Req() req: any) {
    const rawIp =
      req.headers['x-client-ip'] ||
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress ||
      '127.0.0.1';
    const clientIp =
      typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';
    const userId = req.user?.id;

    // Basic input validation
    if (!body?.cart || !Array.isArray(body.cart) || body.cart.length === 0) {
      throw new BadRequestException(
        'cart is required and must be a non-empty array',
      );
    }
    if (!body?.recipient?.name || !body?.recipient?.phone) {
      throw new BadRequestException(
        'recipient.name and recipient.phone are required',
      );
    }
    if (
      !body?.delivery?.address ||
      !body?.delivery?.city ||
      !body?.delivery?.date
    ) {
      throw new BadRequestException(
        'delivery.address, delivery.city, and delivery.date are required',
      );
    }
    if (!body?.sender?.name) {
      throw new BadRequestException('sender.name is required');
    }

    // Phone format validation
    const phone: string = String(body.recipient.phone).replace(/\s/g, '');
    if (!/^(\+94|0)[1-9]\d{8}$/.test(phone)) {
      throw new BadRequestException(
        'recipient.phone must be a valid Sri Lankan mobile number',
      );
    }

    // Date validation (must be at least tomorrow)
    const deliveryDate = new Date(body.delivery.date);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    if (isNaN(deliveryDate.getTime()) || deliveryDate < tomorrow) {
      throw new BadRequestException(
        'delivery.date must be at least tomorrow (YYYY-MM-DD)',
      );
    }

    const sessionId: string | undefined = body.sessionId;

    try {
      const result = await this.chatService.createQuickOrder(
        {
          cart: body.cart,
          recipient: { ...body.recipient, phone },
          delivery: body.delivery,
          sender: body.sender,
          gift_message: body.gift_message,
        },
        sessionId,
        userId,
        clientIp,
      );
      return result;
    } catch (err: any) {
      throw new HttpException(
        { error: err.message || 'Order creation failed' },
        err.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

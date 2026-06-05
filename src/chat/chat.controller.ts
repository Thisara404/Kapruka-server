import { Controller, Post, Get, Body, Req, Res, Query, UseGuards, HttpStatus } from '@nestjs/common';
import { ChatService } from './chat.service';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard';
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
    const rawIp = req.headers['x-client-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const clientIp = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';
    const userId = req.user?.id; // populated by OptionalJwtAuthGuard if authenticated

    try {
      const streamResponse = await this.chatService.handleChat(body, clientIp, userId);
      
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
      const status = err.status || HttpStatus.INTERNAL_SERVER_ERROR;
      res.status(status).json({
        error: err.message || 'An error occurred during generation',
        ...(err.response || {}),
      });
    }
  }

  @Get('history')
  @UseGuards(OptionalJwtAuthGuard)
  async history(
    @Query('sessionId') sessionId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    const messages = await this.chatService.getHistory(sessionId, userId);
    return { messages };
  }
}

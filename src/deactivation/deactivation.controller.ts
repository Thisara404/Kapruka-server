import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { DeactivationService } from './deactivation.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IsOptional, IsString } from 'class-validator';

class DeactivateUserDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

@Controller('user')
export class DeactivationController {
  constructor(private readonly deactivationService: DeactivationService) {}

  @Post('deactivate')
  @UseGuards(JwtAuthGuard)
  async deactivate(@Req() req: any, @Body() body: DeactivateUserDto) {
    const userId = req.user.id;
    return this.deactivationService.deactivateUser(userId, body.reason);
  }
}

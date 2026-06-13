import {
  Controller,
  Post,
  Body,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { IsEmail, IsNotEmpty, IsOptional, MinLength } from 'class-validator';

export class RegisterDto {
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  password?: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  password: string;
}

export class GoogleLoginDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  name: string;

  @IsOptional()
  image?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body.name, body.email, body.password);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto) {
    const user = await this.authService.validateUser(body.email, body.password);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.authService.login(user);
  }

  @Post('google-login')
  @HttpCode(HttpStatus.OK)
  async googleLogin(@Body() body: GoogleLoginDto) {
    return this.authService.googleLogin({
      email: body.email,
      name: body.name,
      image: body.image,
    });
  }
}

import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any, _info: any) {
    // Return user if authenticated, or null if anonymous (do not throw UnauthorizedException)
    return user || null;
  }
}

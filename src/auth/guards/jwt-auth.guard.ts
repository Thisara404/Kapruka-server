import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any, _info: any) {
    if (err || !user) {
      throw (
        err ||
        new UnauthorizedException('Please authenticate to access this resource')
      );
    }
    return user;
  }
}

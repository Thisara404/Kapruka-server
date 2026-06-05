import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { User } from '../users/schemas/user.schema';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async register(name: string, email: string, password?: string): Promise<any> {
    const user = await this.usersService.create({ name, email, password });
    return this.login(user);
  }

  async validateUser(email: string, pass: string): Promise<any> {
    const user = await this.usersService.findOneByEmail(email);
    if (user && user.password) {
      const isMatch = await bcrypt.compare(pass, user.password);
      if (isMatch) {
        // Return without password hash
        const { password, ...result } = user.toObject();
        return result;
      }
    }
    return null;
  }

  async login(user: any) {
    const payload = { email: user.email, sub: user._id.toString() };
    const token = this.jwtService.sign(payload);
    return {
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        image: user.image,
      },
      token,
    };
  }

  async googleLogin(profile: { email: string; name: string; image?: string }) {
    let user = await this.usersService.findOneByEmail(profile.email);
    if (!user) {
      // Create OAuth user without password
      user = await this.usersService.create({
        name: profile.name,
        email: profile.email,
        image: profile.image,
      });
    } else if (profile.image && !user.image) {
      // Update user image if empty
      user.image = profile.image;
      await user.save();
    }
    
    return this.login(user);
  }
}

import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { UserEntity } from '../database/entities/user.entity.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async findOneByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({
      where: { email: email.toLowerCase() },
    });
  }

  async findOneById(id: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  async create(userData: Partial<UserEntity>): Promise<UserEntity> {
    const emailLower = userData.email?.toLowerCase();
    const existing = await this.findOneByEmail(emailLower || '');
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    let passwordHash: string | null = null;
    if (userData.password) {
      passwordHash = await bcrypt.hash(userData.password, 10);
    }

    const user = this.userRepo.create({
      ...userData,
      email: emailLower,
      password: passwordHash,
    });
    return this.userRepo.save(user);
  }

  async update(
    userId: string,
    updateData: Partial<UserEntity>,
  ): Promise<UserEntity> {
    await this.userRepo.update(userId, updateData);
    const updated = await this.findOneById(userId);
    if (!updated) {
      throw new Error('User not found');
    }
    return updated;
  }

  async markDeactivated(userId: string): Promise<void> {
    await this.userRepo.update(userId, {
      deactivated: true,
      deactivatedAt: new Date(),
    });
  }

  async deleteOne(userId: string): Promise<void> {
    await this.userRepo.delete(userId);
  }
}

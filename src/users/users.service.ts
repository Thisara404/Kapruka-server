import { Injectable, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async findOneByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  async findOneById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  async create(userData: Partial<User>): Promise<UserDocument> {
    const emailLower = userData.email?.toLowerCase();
    const existing = await this.findOneByEmail(emailLower || '');
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    let passwordHash = undefined;
    if (userData.password) {
      passwordHash = await bcrypt.hash(userData.password, 10);
    }

    const createdUser = new this.userModel({
      ...userData,
      email: emailLower,
      password: passwordHash,
    });
    return createdUser.save();
  }

  async markDeactivated(userId: string): Promise<any> {
    return this.userModel.updateOne(
      { _id: userId },
      { $set: { deactivated: true, deactivatedAt: new Date() } }
    ).exec();
  }

  async deleteOne(userId: string): Promise<any> {
    return this.userModel.deleteOne({ _id: userId }).exec();
  }
}

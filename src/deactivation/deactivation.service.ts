import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DeactivatedUser, DeactivatedUserDocument } from './schemas/deactivated-user.schema';
import { UsersService } from '../users/users.service';
import { ChatService } from '../chat/chat.service';
import { AnalyticsService } from '../analytics/analytics.service';

@Injectable()
export class DeactivationService {
  private readonly logger = new Logger('DeactivationService');

  constructor(
    @InjectModel(DeactivatedUser.name) private readonly deactivatedModel: Model<DeactivatedUserDocument>,
    private readonly usersService: UsersService,
    private readonly chatService: ChatService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  async deactivateUser(userId: string, reason = 'User requested'): Promise<any> {
    // 1. Mark user as deactivated in user collection
    await this.usersService.markDeactivated(userId);

    // 2. Schedule deletion in deactivated_users collection (deleteAfter = 48 hours from now)
    const deleteAfter = new Date(Date.now() + 48 * 60 * 60 * 1000);
    
    await this.deactivatedModel.updateOne(
      { userId },
      {
        $set: {
          userId,
          reason,
          deactivatedAt: new Date(),
          deleteAfter,
        },
      },
      { upsert: true }
    ).exec();

    this.logger.log(`User ${userId} scheduled for cascade delete at ${deleteAfter.toISOString()}`);
    return { success: true, deleteAfter };
  }

  async runDeactivationCleanup(): Promise<void> {
    const now = new Date();
    try {
      const expiredList = await this.deactivatedModel.find({
        deleteAfter: { $lte: now }
      }).exec();

      if (expiredList.length === 0) return;

      this.logger.log(`Found ${expiredList.length} expired deactivations to sweep.`);

      for (const record of expiredList) {
        const { userId } = record;
        this.logger.log(`Cascade deleting deactivated user data for userId: ${userId}`);

        // Delete user
        await this.usersService.deleteOne(userId);

        // Delete related database records
        await this.chatService.deleteByUserId(userId);
        await this.analyticsService.deleteByUserId(userId);

        // Delete scheduling record
        await this.deactivatedModel.deleteOne({ _id: record._id }).exec();
      }
    } catch (err: any) {
      this.logger.error(`Cascade deletion sweep failed: ${err.message}`);
    }
  }
}

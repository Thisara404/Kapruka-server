import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, LessThanOrEqual } from 'typeorm';
import {
  DeactivatedUserEntity,
  UserEntity,
  AgentSessionEntity,
  OrderEntity,
  AnalyticsEntity,
  ProductViewEntity,
  DeliveryCheckEntity,
} from '../database/entities/index.js';
import { UsersService } from '../users/users.service.js';
import { ChatService } from '../chat/chat.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';

@Injectable()
export class DeactivationService {
  private readonly logger = new Logger('DeactivationService');

  constructor(
    @InjectRepository(DeactivatedUserEntity)
    private readonly deactivatedUserRepo: Repository<DeactivatedUserEntity>,
    private readonly usersService: UsersService,
    private readonly chatService: ChatService,
    private readonly analyticsService: AnalyticsService,
    private readonly dataSource: DataSource,
  ) {}

  async deactivateUser(
    userId: string,
    reason = 'User requested',
  ): Promise<any> {
    // 1. Mark user as deactivated in user collection
    await this.usersService.markDeactivated(userId);

    // 2. Schedule deletion (deleteAfter = 48 hours from now)
    const deleteAfter = new Date(Date.now() + 48 * 60 * 60 * 1000);

    await this.deactivatedUserRepo.upsert(
      {
        userId,
        reason,
        deactivatedAt: new Date(),
        deleteAfter,
      },
      ['userId'],
    );

    this.logger.log(
      `User ${userId} scheduled for cascade delete at ${deleteAfter.toISOString()}`,
    );
    return { success: true, deleteAfter };
  }

  async runDeactivationCleanup(): Promise<void> {
    const now = new Date();
    try {
      // Find all expired scheduling records
      const expiredList = await this.deactivatedUserRepo.find({
        where: { deleteAfter: LessThanOrEqual(now) },
      });

      if (expiredList.length === 0) return;

      this.logger.log(
        `Found ${expiredList.length} expired deactivations to sweep.`,
      );

      // Run cleanup inside a single ACID transaction
      await this.dataSource.transaction(async (manager) => {
        for (const record of expiredList) {
          const { userId } = record;
          this.logger.log(
            `Cascade deleting deactivated user data for userId: ${userId}`,
          );

          // 1. Delete user (which can set null or delete related records)
          await manager.delete(UserEntity, { id: userId });

          // 2. Delete agent sessions (which cascade deletes turns and step_traces)
          await manager.delete(AgentSessionEntity, { externalUserId: userId });

          // 3. Delete related analytics & order records
          await manager.delete(OrderEntity, { userId });
          await manager.delete(AnalyticsEntity, { userId });
          await manager.delete(ProductViewEntity, { userId });
          await manager.delete(DeliveryCheckEntity, { userId });

          // 4. Delete scheduling record itself
          await manager.delete(DeactivatedUserEntity, { id: record.id });
        }
      });
    } catch (err: any) {
      this.logger.error(`Cascade deletion sweep failed: ${err.message}`);
    }
  }
}

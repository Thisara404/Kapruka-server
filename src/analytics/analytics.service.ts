import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  OrderEntity,
  ProductViewEntity,
  DeliveryCheckEntity,
  AnalyticsEntity,
} from '../database/entities/index.js';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger('AnalyticsService');

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(ProductViewEntity)
    private readonly productViewRepo: Repository<ProductViewEntity>,
    @InjectRepository(DeliveryCheckEntity)
    private readonly deliveryCheckRepo: Repository<DeliveryCheckEntity>,
    @InjectRepository(AnalyticsEntity)
    private readonly analyticsRepo: Repository<AnalyticsEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async logProductView(data: any): Promise<any> {
    try {
      const view = this.productViewRepo.create({
        ...data,
        viewedAt: new Date(),
      });
      return await this.productViewRepo.save(view);
    } catch (err: any) {
      this.logger.warn(`Failed to log product view: ${err.message}`);
    }
  }

  async logDeliveryCheck(data: any): Promise<any> {
    try {
      const check = this.deliveryCheckRepo.create({
        ...data,
        checkedAt: new Date(),
      });
      return await this.deliveryCheckRepo.save(check);
    } catch (err: any) {
      this.logger.warn(`Failed to log delivery check: ${err.message}`);
    }
  }

  async logOrder(data: any): Promise<any> {
    try {
      const order = this.orderRepo.create({
        ...data,
        createdAt: new Date(),
      });
      return await this.orderRepo.save(order);
    } catch (err: any) {
      this.logger.warn(`Failed to log order: ${err.message}`);
    }
  }

  async cancelOrder(orderRef: string): Promise<void> {
    try {
      const order = await this.orderRepo.findOne({ where: { orderRef } });
      if (order) {
        order.status = 'cancelled';
        await this.orderRepo.save(order);
        this.logger.log(`Order ${orderRef} status updated to cancelled`);
      } else {
        this.logger.warn(`Order ${orderRef} not found for cancellation`);
      }
    } catch (err: any) {
      this.logger.error(`Failed to cancel order ${orderRef}: ${err.message}`);
    }
  }

  async restoreOrder(orderRef: string): Promise<void> {
    try {
      const order = await this.orderRepo.findOne({ where: { orderRef } });
      if (order) {
        order.status = 'created';
        await this.orderRepo.save(order);
        this.logger.log(`Order ${orderRef} status restored to created`);
      } else {
        this.logger.warn(`Order ${orderRef} not found for restoration`);
      }
    } catch (err: any) {
      this.logger.error(`Failed to restore order ${orderRef}: ${err.message}`);
    }
  }

  async logEvent(data: {
    sessionId: string;
    userId?: string;
    ipAddress?: string;
    eventName: string;
    metadata?: Record<string, any>;
  }): Promise<any> {
    try {
      const event = {
        name: data.eventName,
        metadata: data.metadata || {},
        timestamp: new Date().toISOString(),
      };

      const eventJson = JSON.stringify([event]);

      // Atomic ON CONFLICT upsert appending to the events jsonb array
      return await this.analyticsRepo.query(
        `INSERT INTO analytics ("sessionId", "userId", "ipAddress", "events", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, now(), now())
         ON CONFLICT ("sessionId") DO UPDATE SET
           "userId" = COALESCE(EXCLUDED."userId", analytics."userId"),
           "ipAddress" = COALESCE(EXCLUDED."ipAddress", analytics."ipAddress"),
           "events" = analytics.events || EXCLUDED.events,
           "updatedAt" = now()`,
        [
          data.sessionId,
          data.userId || null,
          data.ipAddress || null,
          eventJson,
        ],
      );
    } catch (err: any) {
      this.logger.warn(`Failed to log event: ${err.message}`);
    }
  }

  async migrateSession(sessionId: string, userId: string): Promise<any> {
    try {
      this.logger.log(
        `Migrating session records for ${sessionId} to user ${userId}`,
      );
      // Run updates atomically within a transaction
      await this.dataSource.transaction(async (manager) => {
        await manager.update(OrderEntity, { sessionId }, { userId });
        await manager.update(AnalyticsEntity, { sessionId }, { userId });
        await manager.update(ProductViewEntity, { sessionId }, { userId });
        await manager.update(DeliveryCheckEntity, { sessionId }, { userId });
      });
    } catch (err: any) {
      this.logger.error(`Migration of session records failed: ${err.message}`);
    }
  }

  async deleteByUserId(userId: string): Promise<any> {
    try {
      // Run deletes atomically within a transaction
      await this.dataSource.transaction(async (manager) => {
        await manager.delete(OrderEntity, { userId });
        await manager.delete(AnalyticsEntity, { userId });
        await manager.delete(ProductViewEntity, { userId });
        await manager.delete(DeliveryCheckEntity, { userId });
      });
    } catch (err: any) {
      this.logger.error(`Deletion of user records failed: ${err.message}`);
    }
  }
}

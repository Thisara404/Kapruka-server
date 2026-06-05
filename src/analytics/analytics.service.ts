import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from './schemas/order.schema';
import { ProductView, ProductViewDocument } from './schemas/product-view.schema';
import { DeliveryCheck, DeliveryCheckDocument } from './schemas/delivery-check.schema';
import { Analytics, AnalyticsDocument, AnalyticsEvent } from './schemas/analytics.schema';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger('AnalyticsService');

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(ProductView.name) private readonly productViewModel: Model<ProductViewDocument>,
    @InjectModel(DeliveryCheck.name) private readonly deliveryCheckModel: Model<DeliveryCheckDocument>,
    @InjectModel(Analytics.name) private readonly analyticsModel: Model<AnalyticsDocument>,
  ) {}

  async logProductView(data: any): Promise<any> {
    try {
      const view = new this.productViewModel({
        ...data,
        viewedAt: new Date(),
      });
      return await view.save();
    } catch (err: any) {
      this.logger.warn(`Failed to log product view: ${err.message}`);
    }
  }

  async logDeliveryCheck(data: any): Promise<any> {
    try {
      const check = new this.deliveryCheckModel({
        ...data,
        checkedAt: new Date(),
      });
      return await check.save();
    } catch (err: any) {
      this.logger.warn(`Failed to log delivery check: ${err.message}`);
    }
  }

  async logOrder(data: any): Promise<any> {
    try {
      const order = new this.orderModel({
        ...data,
        createdAt: new Date(),
      });
      return await order.save();
    } catch (err: any) {
      this.logger.warn(`Failed to log order: ${err.message}`);
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
      const event: AnalyticsEvent = {
        name: data.eventName,
        metadata: data.metadata,
        timestamp: new Date(),
      };
      return await this.analyticsModel.updateOne(
        { sessionId: data.sessionId },
        {
          $push: { events: event },
          $set: {
            userId: data.userId,
            ipAddress: data.ipAddress,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      ).exec();
    } catch (err: any) {
      this.logger.warn(`Failed to log event: ${err.message}`);
    }
  }

  async migrateSession(sessionId: string, userId: string): Promise<any> {
    try {
      this.logger.log(`Migrating session records for ${sessionId} to user ${userId}`);
      await this.orderModel.updateMany({ sessionId }, { $set: { userId } }).exec();
      await this.analyticsModel.updateMany({ sessionId }, { $set: { userId } }).exec();
      await this.productViewModel.updateMany({ sessionId }, { $set: { userId } }).exec();
      await this.deliveryCheckModel.updateMany({ sessionId }, { $set: { userId } }).exec();
    } catch (err: any) {
      this.logger.error(`Migration of session records failed: ${err.message}`);
    }
  }

  async deleteByUserId(userId: string): Promise<any> {
    try {
      await this.orderModel.deleteMany({ userId }).exec();
      await this.analyticsModel.deleteMany({ userId }).exec();
      await this.productViewModel.deleteMany({ userId }).exec();
      await this.deliveryCheckModel.deleteMany({ userId }).exec();
    } catch (err: any) {
      this.logger.error(`Deletion of user records failed: ${err.message}`);
    }
  }
}

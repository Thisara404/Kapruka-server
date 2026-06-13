import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsService } from './analytics.service.js';
import {
  OrderEntity,
  ProductViewEntity,
  DeliveryCheckEntity,
  AnalyticsEntity,
} from '../database/entities/index.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderEntity,
      ProductViewEntity,
      DeliveryCheckEntity,
      AnalyticsEntity,
    ]),
  ],
  providers: [AnalyticsService],
  exports: [AnalyticsService, TypeOrmModule],
})
export class AnalyticsModule {}

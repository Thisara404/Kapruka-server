import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AnalyticsService } from './analytics.service';
import { Order, OrderSchema } from './schemas/order.schema';
import { ProductView, ProductViewSchema } from './schemas/product-view.schema';
import { DeliveryCheck, DeliveryCheckSchema } from './schemas/delivery-check.schema';
import { Analytics, AnalyticsSchema } from './schemas/analytics.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: ProductView.name, schema: ProductViewSchema },
      { name: DeliveryCheck.name, schema: DeliveryCheckSchema },
      { name: Analytics.name, schema: AnalyticsSchema },
    ]),
  ],
  providers: [AnalyticsService],
  exports: [AnalyticsService, MongooseModule],
})
export class AnalyticsModule {}

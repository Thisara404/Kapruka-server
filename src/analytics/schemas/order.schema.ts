import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type OrderDocument = Order & Document;

@Schema({ timestamps: true, collection: 'orders' })
export class Order {
  @Prop({ required: true, index: true })
  sessionId: string;

  @Prop({ index: true })
  userId?: string;

  @Prop({ required: true, unique: true, index: true })
  orderRef: string;

  @Prop({ required: true })
  checkoutUrl: string;

  @Prop({ type: [MongooseSchema.Types.Mixed], required: true })
  cart: any[];

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  recipient: any;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  delivery: any;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  sender: any;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  summary: {
    subtotal: number;
    deliveryRate: number;
    total: number;
  };

  @Prop({ required: true, default: 'created' })
  status: string;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

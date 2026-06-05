import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DeliveryCheckDocument = DeliveryCheck & Document;

@Schema({ timestamps: false, collection: 'delivery_checks' })
export class DeliveryCheck {
  @Prop({ required: true, index: true })
  sessionId: string;

  @Prop({ index: true })
  userId?: string;

  @Prop({ required: true })
  city: string;

  @Prop()
  date?: string;

  @Prop()
  productId?: string;

  @Prop({ required: true })
  available: boolean;

  @Prop()
  rate?: number;

  @Prop()
  perishableWarning?: boolean;

  @Prop({ default: Date.now })
  checkedAt: Date;
}

export const DeliveryCheckSchema = SchemaFactory.createForClass(DeliveryCheck);

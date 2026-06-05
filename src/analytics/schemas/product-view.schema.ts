import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductViewDocument = ProductView & Document;

@Schema({ timestamps: false, collection: 'product_views' })
export class ProductView {
  @Prop({ required: true, index: true })
  sessionId: string;

  @Prop({ index: true })
  userId?: string;

  @Prop({ required: true })
  productId: string;

  @Prop({ required: true })
  productName: string;

  @Prop({ required: true })
  price: number;

  @Prop()
  imageUrl?: string;

  @Prop({ default: Date.now })
  viewedAt: Date;
}

export const ProductViewSchema = SchemaFactory.createForClass(ProductView);
export const ProductViewSchemaIndex = { productId: 1, sessionId: 1 };

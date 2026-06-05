import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type AnalyticsDocument = Analytics & Document;

@Schema({ timestamps: false })
export class AnalyticsEvent {
  @Prop({ required: true })
  name: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  metadata?: Record<string, any>;

  @Prop({ default: Date.now })
  timestamp: Date;
}

const AnalyticsEventSchema = SchemaFactory.createForClass(AnalyticsEvent);

@Schema({ timestamps: true, collection: 'analytics' })
export class Analytics {
  @Prop({ required: true, unique: true, index: true })
  sessionId: string;

  @Prop({ index: true })
  userId?: string;

  @Prop()
  ipAddress?: string;

  @Prop({ type: [AnalyticsEventSchema], default: [] })
  events: AnalyticsEvent[];
}

export const AnalyticsSchema = SchemaFactory.createForClass(Analytics);

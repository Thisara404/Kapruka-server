import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type ConversationDocument = Conversation & Document;

@Schema({ timestamps: true, collection: 'conversations' })
export class Conversation {
  @Prop({ required: true, index: true })
  sessionId: string;

  @Prop({ index: true })
  userId?: string;

  @Prop({ required: true, enum: ['public', 'user'], default: 'public' })
  type: string;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  messages: any[];
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

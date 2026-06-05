import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DeactivatedUserDocument = DeactivatedUser & Document;

@Schema({ timestamps: false, collection: 'deactivated_users' })
export class DeactivatedUser {
  @Prop({ required: true, unique: true, index: true })
  userId: string;

  @Prop({ default: 'User requested' })
  reason: string;

  @Prop({ default: Date.now })
  deactivatedAt: Date;

  @Prop({ required: true, index: true })
  deleteAfter: Date; // Indexed to support TTL deletion or manual cron sweeps
}

export const DeactivatedUserSchema = SchemaFactory.createForClass(DeactivatedUser);

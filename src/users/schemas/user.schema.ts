import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop()
  password?: string; // Optional for Google OAuth users

  @Prop({ default: false })
  deactivated?: boolean;

  @Prop()
  deactivatedAt?: Date;

  @Prop()
  image?: string; // Google user image

  @Prop()
  emailVerified?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

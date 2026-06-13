import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { UserEntity } from './user.entity.js';
import { AgentTurnEntity } from './agent-turn.entity.js';
import { SessionStatus } from '../enums/session-status.enum.js';

@Entity('agent_sessions')
export class AgentSessionEntity {
  /**
   * The frontend-generated UUID (crypto.randomUUID()) is used directly as PK.
   * This avoids an extra lookup column and simplifies the API contract.
   */
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ type: 'uuid', nullable: true })
  externalUserId: string | null;

  @ManyToOne(() => UserEntity, (user) => user.sessions, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'externalUserId' })
  user: UserEntity | null;

  @Column({
    type: 'enum',
    enum: SessionStatus,
    default: SessionStatus.ACTIVE,
  })
  currentStatus: SessionStatus;

  @Column({ type: 'jsonb', nullable: true })
  deliveryMetadata: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  currentCartSnapshot: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => AgentTurnEntity, (turn) => turn.session, { cascade: true })
  turns: AgentTurnEntity[];
}

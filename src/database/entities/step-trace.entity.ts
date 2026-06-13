import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { AgentTurnEntity } from './agent-turn.entity.js';
import { StepType } from '../enums/step-type.enum.js';

@Entity('step_traces')
export class StepTraceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  turnId: string;

  @ManyToOne(() => AgentTurnEntity, (turn) => turn.traces, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'turnId' })
  turn: AgentTurnEntity;

  @Column({
    type: 'enum',
    enum: StepType,
  })
  stepType: StepType;

  @Column({ type: 'varchar', length: 255 })
  nodeName: string;

  @Index('idx_step_traces_input', { synchronize: false })
  @Column({ type: 'jsonb', nullable: true })
  inputPayload: Record<string, any> | null;

  @Index('idx_step_traces_output', { synchronize: false })
  @Column({ type: 'jsonb', nullable: true })
  outputPayload: Record<string, any> | null;

  @Column({ type: 'int', default: 0 })
  executionDurationMs: number;

  @Column({ type: 'boolean', default: false })
  isError: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

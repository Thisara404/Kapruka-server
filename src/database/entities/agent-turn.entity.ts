import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { AgentSessionEntity } from './agent-session.entity.js';
import { StepTraceEntity } from './step-trace.entity.js';

@Entity('agent_turns')
@Index(['sessionId', 'createdAt'])
export class AgentTurnEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  sessionId: string;

  @ManyToOne(() => AgentSessionEntity, (session) => session.turns, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'sessionId' })
  session: AgentSessionEntity;

  @Column({ type: 'text' })
  userPrompt: string;

  @Column({ type: 'text', nullable: true })
  finalAgentResponse: string | null;

  @Column({ type: 'int', default: 0 })
  promptTokens: number;

  @Column({ type: 'int', default: 0 })
  completionTokens: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => StepTraceEntity, (trace) => trace.turn, { cascade: true })
  traces: StepTraceEntity[];
}

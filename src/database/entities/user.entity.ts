import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { AgentSessionEntity } from './agent-session.entity.js';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({
    type: 'varchar',
    length: 255,
    unique: true,
    transformer: {
      to: (value: string) => value?.toLowerCase()?.trim(),
      from: (value: string) => value,
    },
  })
  email: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  password: string | null;

  @Column({ type: 'boolean', default: false })
  deactivated: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  deactivatedAt: Date | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  image: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  emailVerified: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => AgentSessionEntity, (session) => session.user)
  sessions: AgentSessionEntity[];
}

import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity('deactivated_users')
export class DeactivatedUserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  userId: string;

  @Column({ type: 'varchar', length: 512, default: 'User requested' })
  reason: string;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  deactivatedAt: Date;

  @Index('idx_deactivated_users_delete_after')
  @Column({ type: 'timestamptz' })
  deleteAfter: Date;
}

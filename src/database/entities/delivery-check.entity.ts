import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('delivery_checks')
export class DeliveryCheckEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  sessionId: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 255 })
  city: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  date: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  productId: string | null;

  @Column({ type: 'boolean' })
  available: boolean;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  rate: number | null;

  @Column({ type: 'boolean', default: false })
  perishableWarning: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  checkedAt: Date;
}

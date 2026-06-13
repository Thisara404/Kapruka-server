import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('orders')
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  sessionId: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 255, unique: true })
  orderRef: string;

  @Column({ type: 'text' })
  checkoutUrl: string;

  @Column({ type: 'jsonb' })
  cart: Record<string, any>[];

  @Column({ type: 'jsonb' })
  recipient: Record<string, any>;

  @Column({ type: 'jsonb' })
  delivery: Record<string, any>;

  @Column({ type: 'jsonb' })
  sender: Record<string, any>;

  @Column({ type: 'jsonb' })
  summary: {
    subtotal: number;
    deliveryRate: number;
    total: number;
  };

  @Column({ type: 'varchar', length: 50, default: 'created' })
  status: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

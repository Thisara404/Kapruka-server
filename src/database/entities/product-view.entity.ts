import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('product_views')
@Index(['productId', 'sessionId'])
export class ProductViewEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  sessionId: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 255 })
  productId: string;

  @Column({ type: 'varchar', length: 512 })
  productName: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  price: number;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  imageUrl: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  viewedAt: Date;
}

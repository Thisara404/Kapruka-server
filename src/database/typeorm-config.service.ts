import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmOptionsFactory, TypeOrmModuleOptions } from '@nestjs/typeorm';

@Injectable()
export class TypeOrmConfigService implements TypeOrmOptionsFactory {
  private readonly logger = new Logger('TypeOrmConfig');

  constructor(private readonly configService: ConfigService) {}

  createTypeOrmOptions(): TypeOrmModuleOptions {
    const url = this.configService.get<string>('DATABASE_URL');
    // this.configService.get<string>('POSTGRESQL_DATABASE_URL');

    if (!url) {
      this.logger.error('DATABASE_URL is not set in environment variables!');
      throw new Error('DATABASE_URL not configured');
    }

    this.logger.log('Configuring TypeORM PostgreSQL connection...');

    return {
      type: 'postgres',
      url,
      ssl:
        url.includes('localhost') || url.includes('127.0.0.1')
          ? false
          : { rejectUnauthorized: false },
      autoLoadEntities: true,
      synchronize: true, // Dev only — switch to migrations for production
      logging: ['error', 'warn'],
      extra: {
        // Connection pool tuning for concurrent AI streaming workloads
        max: 25,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 10000,
      },
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { MongooseOptionsFactory, MongooseModuleOptions } from '@nestjs/mongoose';
import { MongoClient } from 'mongodb';

@Injectable()
export class MongooseConfigService implements MongooseOptionsFactory {
  private readonly logger = new Logger('MongooseConfig');

  async createMongooseOptions(): Promise<MongooseModuleOptions> {
    const primaryUri = process.env.MONGODB_URL || '';
    if (!primaryUri) {
      this.logger.error('MONGODB_URL is not set in environment variables!');
      throw new Error('MONGODB_URL not configured');
    }

    const options = {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    };

    try {
      this.logger.log('Testing primary MONGODB_URL connection...');
      const testClient = new MongoClient(primaryUri, options);
      await testClient.connect();
      await testClient.close();
      this.logger.log('Primary MONGODB_URL connection successful. Using standard connection.');
      return {
        uri: primaryUri,
      };
    } catch (err: any) {
      this.logger.warn(`Primary MONGODB_URL connection failed: ${err.message}`);
      
      const isSrvOrDnsFailure =
        err.message?.includes('querySrv') ||
        err.message?.includes('ECONNREFUSED') ||
        err.code === 'ECONNREFUSED' ||
        err.message?.includes('DNS');

      if (primaryUri.startsWith('mongodb+srv://') && isSrvOrDnsFailure && primaryUri.includes('kaprukacluster0.kyxtwj9.mongodb.net')) {
        this.logger.log('Detected querySrv/DNS failure. Trying pre-resolved replica set fallback URI...');
        try {
          const match = primaryUri.match(/mongodb\+srv:\/\/([^:]+):([^@]+)@kaprukacluster0\.kyxtwj9\.mongodb\.net/);
          if (match) {
            const user = match[1];
            const pass = match[2];
            const fallbackUri = `mongodb://${user}:${pass}@ac-qhm2oje-shard-00-00.kyxtwj9.mongodb.net:27017,ac-qhm2oje-shard-00-01.kyxtwj9.mongodb.net:27017,ac-qhm2oje-shard-00-02.kyxtwj9.mongodb.net:27017/thisari_db?ssl=true&authSource=admin&replicaSet=atlas-ov62pk-shard-0&appName=KaprukaCluster0`;
            
            // Test fallback connection
            const testClient = new MongoClient(fallbackUri, options);
            await testClient.connect();
            await testClient.close();
            this.logger.log('Connected successfully using replica set fallback URI!');
            return {
              uri: fallbackUri,
            };
          }
        } catch (fallbackErr: any) {
          this.logger.error(`Replica set fallback connection also failed: ${fallbackErr.message}`);
        }
      }
      
      // If fallback failed or wasn't applicable, return primary anyway to let mongoose fail natively
      return {
        uri: primaryUri,
      };
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeactivationService } from './deactivation.service.js';

@Injectable()
export class DeactivationScheduler {
  private readonly logger = new Logger('DeactivationScheduler');

  constructor(private readonly deactivationService: DeactivationService) {}

  // Run database sweep every hour
  @Cron(CronExpression.EVERY_HOUR)
  async handleExpiredDeactivations() {
    this.logger.log('Starting background deactivation cascade sweep...');
    await this.deactivationService.runDeactivationCleanup();
  }
}

import { Module } from '@nestjs/common';
import { ClosingsController } from './closings.controller.js';
import { ClosingsService } from './closings.service.js';
import { TransactionsModule } from '../transactions/transactions.module.js';

@Module({
  imports: [TransactionsModule],
  controllers: [ClosingsController],
  providers: [ClosingsService],
  exports: [ClosingsService],
})
export class ClosingsModule {}

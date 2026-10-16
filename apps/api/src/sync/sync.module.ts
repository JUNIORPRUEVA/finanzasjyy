import { Module } from '@nestjs/common';
import { ClosingsModule } from '../closings/closings.module.js';
import { LoansModule } from '../loans/loans.module.js';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { TransfersModule } from '../transfers/transfers.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

@Module({
  imports: [TransactionsModule, TransfersModule, ClosingsModule, LoansModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}

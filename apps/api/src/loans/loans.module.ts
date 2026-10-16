import { Module } from '@nestjs/common';
import { LoansController } from './loans.controller.js';
import { LoansService } from './loans.service.js';

@Module({
  controllers: [LoansController],
  providers: [LoansService],
  exports: [LoansService],
})
export class LoansModule {}

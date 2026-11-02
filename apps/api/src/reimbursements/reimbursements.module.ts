import { Module } from '@nestjs/common';
import { ReimbursementsController } from './reimbursements.controller.js';
import { ReimbursementsService } from './reimbursements.service.js';

@Module({
  controllers: [ReimbursementsController],
  providers: [ReimbursementsService],
  exports: [ReimbursementsService],
})
export class ReimbursementsModule {}

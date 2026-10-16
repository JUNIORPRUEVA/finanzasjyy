import { Module } from '@nestjs/common';
import { ObligationsController } from './obligations.controller.js';
import { ObligationsService } from './obligations.service.js';

@Module({
  controllers: [ObligationsController],
  providers: [ObligationsService],
  exports: [ObligationsService],
})
export class ObligationsModule {}

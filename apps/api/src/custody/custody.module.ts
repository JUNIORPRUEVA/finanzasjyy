import { Module } from '@nestjs/common';
import { CustodyController } from './custody.controller.js';
import { CustodyService } from './custody.service.js';

@Module({
  controllers: [CustodyController],
  providers: [CustodyService],
  exports: [CustodyService],
})
export class CustodyModule {}

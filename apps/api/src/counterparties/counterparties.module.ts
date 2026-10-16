import { Module } from '@nestjs/common';
import { CounterpartiesController } from './counterparties.controller.js';
import { CounterpartiesService } from './counterparties.service.js';

@Module({
  controllers: [CounterpartiesController],
  providers: [CounterpartiesService],
  exports: [CounterpartiesService],
})
export class CounterpartiesModule {}

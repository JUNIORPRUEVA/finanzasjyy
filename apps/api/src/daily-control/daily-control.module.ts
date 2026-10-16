import { Module } from '@nestjs/common';
import { DailyControlController } from './daily-control.controller.js';
import { DailyControlService } from './daily-control.service.js';
import { ClosingsModule } from '../closings/closings.module.js';

/**
 * El control diario reutiliza el cálculo de disciplina del módulo de cierres:
 * una sola definición de «verde/amarillo/rojo» en todo el sistema.
 */
@Module({
  imports: [ClosingsModule],
  controllers: [DailyControlController],
  providers: [DailyControlService],
  exports: [DailyControlService],
})
export class DailyControlModule {}

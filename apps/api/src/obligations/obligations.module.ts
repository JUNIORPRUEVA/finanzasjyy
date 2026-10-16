import { Module } from '@nestjs/common';
import { ObligationsController } from './obligations.controller.js';
import { ObligationsService } from './obligations.service.js';
import { TransactionsModule } from '../transactions/transactions.module.js';

/**
 * Las obligaciones registran sus cobros y pagos a través del servicio de
 * movimientos: es el ÚNICO camino por el que entra o sale dinero (valida,
 * genera el asiento de partida doble, aplica idempotencia y deja auditoría).
 */
@Module({
  imports: [TransactionsModule],
  controllers: [ObligationsController],
  providers: [ObligationsService],
  exports: [ObligationsService],
})
export class ObligationsModule {}

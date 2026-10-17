import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { ShoppingController } from './shopping.controller.js';
import { ShoppingService } from './shopping.service.js';

/**
 * COMPRAS PERSONALES
 * Importa TransactionsModule porque registrar el gasto de una lista debe pasar
 * por el MISMO servicio que el resto de movimientos de FINANZA. No hay ningún
 * camino alternativo al libro mayor.
 */
@Module({
  imports: [TransactionsModule],
  controllers: [ShoppingController],
  providers: [ShoppingService],
  exports: [ShoppingService],
})
export class ShoppingModule {}

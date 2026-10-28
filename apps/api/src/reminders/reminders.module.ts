import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller.js';
import { RemindersController } from './reminders.controller.js';
import { RemindersService } from './reminders.service.js';

/**
 * Recordatorios y notas, con su calendario de suscripción.
 * Prisma, auditoría y control de acceso son módulos globales: no hace falta
 * importarlos aquí.
 */
@Module({
  controllers: [RemindersController, CalendarController],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}

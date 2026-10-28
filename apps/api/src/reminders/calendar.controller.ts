import { Controller, Get, Header, Param } from '@nestjs/common';
import { Public } from '../common/http.decorators.js';
import { RemindersService } from './reminders.service.js';

/**
 * CALENDARIO PÚBLICO POR ENLACE
 * -----------------------------
 * Google Calendar no puede enviar la sesión de la app: se suscribe a una URL.
 * Por eso este endpoint es público **pero no adivinable**: el token de 48
 * caracteres aleatorios es la llave, y se puede cambiar en cualquier momento
 * desde Ajustes del recordatorio («cambiar enlace»).
 *
 * Devuelve iCalendar (ICS): recordatorios con aviso + compromisos mensuales +
 * cuotas de préstamos + cuentas por pagar.
 */
@Controller('calendar')
export class CalendarController {
  constructor(private readonly reminders: RemindersService) {}

  @Public()
  @Get('feed/:token')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @Header('Content-Disposition', 'inline; filename="finanza.ics"')
  @Header('Cache-Control', 'no-cache, max-age=0')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async feed(@Param('token') token: string): Promise<string> {
    const { body } = await this.reminders.buildFeed(token);
    return body;
  }
}

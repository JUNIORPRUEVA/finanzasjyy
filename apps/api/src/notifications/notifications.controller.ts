import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { NotificationsService } from './notifications.service.js';
import { PushService } from './push.service.js';
import { ListNotificationsQuery, SubscribePushDto, UnsubscribePushDto } from './notifications.dto.js';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  /**
   * TAREAS FINANCIERAS PENDIENTES: lo que hay que hacer hoy, calculado con
   * datos reales. Es la información que la app muestra al abrirse.
   */
  @Get('tasks')
  tasks(@CurrentUser() user: AuthenticatedUser, @Query('entityId') entityId?: string) {
    return this.notifications.pendingTasks(user, entityId);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListNotificationsQuery) {
    return this.notifications.list(user, {
      unreadOnly: query.unreadOnly === 'true',
      severity: query.severity,
      entityId: query.entityId,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  }

  @Post(':id/read')
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markRead(user, id);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user);
  }

  // ---------------------------------------------------------------------
  // Web Push
  // ---------------------------------------------------------------------

  /** Estado real del push: si faltan claves VAPID, se dice claramente. */
  @Get('push/status')
  pushStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.push.listSubscriptions(user.userId);
  }

  @Post('push/subscribe')
  subscribe(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubscribePushDto) {
    return this.push.subscribe(user.userId, dto);
  }

  @Delete('push/subscribe')
  unsubscribe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UnsubscribePushDto) {
    return this.push.unsubscribe(user.userId, dto.endpoint);
  }

  /** Informe honesto de entrega (para el informe de UAT). */
  @Get('push/delivery-report')
  deliveryReport(@CurrentUser() user: AuthenticatedUser) {
    return this.push.deliveryReport(user.userId);
  }

  /** Envía una notificación de prueba a los dispositivos del usuario. */
  @Post('push/test')
  async testPush(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.push.sendToUser(user.userId, {
      title: 'FINANZA — prueba de notificación',
      body: 'Si ve este mensaje, las notificaciones push funcionan en este dispositivo.',
      severity: 'INFO',
      actionUrl: '/panel',
      tag: 'test',
    });

    return {
      ...result,
      message: result.disabled
        ? 'El envío push está DESACTIVADO en el servidor (faltan claves VAPID). Configure VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.'
        : result.attempted === 0
          ? 'No hay dispositivos suscritos para este usuario.'
          : `Se envió a ${result.attempted} dispositivo(s); el proveedor aceptó ${result.accepted}.`,
    };
  }

  /** Fuerza la generación de recordatorios (útil para probar sin esperar). */
  @Post('run-reminders')
  async runReminders(@CurrentUser() user: AuthenticatedUser) {
    const tasks = await this.notifications.pendingTasks(user);
    return {
      level: tasks.level,
      mandatoryCount: tasks.mandatoryCount,
      note: 'El planificador del servidor genera los recordatorios automáticamente cada 5 minutos.',
    };
  }
}

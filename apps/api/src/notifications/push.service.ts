import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';
import { ConflictError, NotFoundError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PushPayload {
  title: string;
  body: string;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  /** Ruta de la app que resuelve la tarea pendiente. */
  actionUrl?: string;
  notificationId?: string;
  tag?: string;
}

/**
 * NOTIFICACIONES PUSH (Web Push / VAPID)
 * --------------------------------------
 * · Si no hay claves VAPID configuradas, el módulo queda activo pero
 *   DESACTIVADO: se registra en el log y la app sigue avisando dentro de la
 *   propia aplicación (centro de notificaciones). Nunca se finge que se envió.
 * · Las suscripciones que el navegador rechaza con 404/410 se marcan como
 *   inválidas y se dejan de usar (limpieza automática).
 * · iOS: las notificaciones web sólo funcionan si la PWA está INSTALADA en la
 *   pantalla de inicio y con iOS 16.4 o superior. Se documenta en el README y
 *   en el informe; el sistema nunca asume que llegaron.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly enabled: boolean;
  private readonly publicKey: string | null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    const publicKey = (config.get<string>('VAPID_PUBLIC_KEY') ?? '').trim();
    const privateKey = (config.get<string>('VAPID_PRIVATE_KEY') ?? '').trim();
    const subject = (config.get<string>('VAPID_SUBJECT') ?? 'mailto:admin@finanza.local').trim();

    if (publicKey && privateKey) {
      try {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        this.enabled = true;
        this.publicKey = publicKey;
        this.logger.log('Web Push configurado (VAPID presente)');
      } catch (error) {
        this.enabled = false;
        this.publicKey = null;
        this.logger.error(
          `Las claves VAPID no son válidas: ${error instanceof Error ? error.message : String(error)}. ` +
            'Las notificaciones push quedan DESACTIVADAS.',
        );
      }
    } else {
      this.enabled = false;
      this.publicKey = null;
      this.logger.warn(
        'Web Push DESACTIVADO: no hay claves VAPID. Genérelas con "npx web-push generate-vapid-keys" ' +
          'y añádalas al .env para activar los avisos push. Las alertas dentro de la app funcionan igual.',
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPublicKey(): string | null {
    return this.publicKey;
  }

  async subscribe(
    userId: string,
    dto: { endpoint: string; p256dh: string; auth: string; deviceId?: string; platform?: string },
  ) {
    const subscription = await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.p256dh,
        auth: dto.auth,
        deviceId: dto.deviceId ?? null,
        platform: dto.platform ?? null,
        isActive: true,
      },
      update: {
        userId,
        p256dh: dto.p256dh,
        auth: dto.auth,
        deviceId: dto.deviceId ?? null,
        platform: dto.platform ?? null,
        isActive: true,
        failCount: 0,
        lastError: null,
      },
    });

    await this.audit.record({
      userId,
      action: 'push.subscribed',
      entityType: 'PushSubscription',
      entityId: subscription.id,
      after: { platform: dto.platform ?? null },
    });

    return {
      subscribed: true,
      pushEnabled: this.enabled,
      message: this.enabled
        ? 'Dispositivo suscrito a las notificaciones push.'
        : 'Suscripción guardada, pero el envío push está desactivado en el servidor (faltan claves VAPID). Las alertas seguirán apareciendo dentro de la aplicación.',
    };
  }

  async unsubscribe(userId: string, endpoint: string) {
    const subscription = await this.prisma.pushSubscription.findFirst({ where: { userId, endpoint } });
    if (!subscription) {
      throw new NotFoundError('Suscripción push');
    }
    await this.prisma.pushSubscription.update({
      where: { id: subscription.id },
      data: { isActive: false },
    });
    await this.audit.record({
      userId,
      action: 'push.unsubscribed',
      entityType: 'PushSubscription',
      entityId: subscription.id,
    });
    return { unsubscribed: true };
  }

  async listSubscriptions(userId: string) {
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId },
      select: {
        id: true,
        deviceId: true,
        platform: true,
        isActive: true,
        failCount: true,
        lastError: true,
        lastSentAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      pushEnabledOnServer: this.enabled,
      publicKey: this.publicKey,
      count: subscriptions.length,
      activeCount: subscriptions.filter((subscription) => subscription.isActive).length,
      subscriptions,
    };
  }

  /**
   * Envía una notificación a todos los dispositivos activos del usuario.
   * Devuelve cuántas se entregaron realmente (el navegador puede aceptar el
   * envío aunque la notificación no se muestre: por eso no se afirma entrega).
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<{ attempted: number; accepted: number; failed: number; disabled: boolean }> {
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId, isActive: true },
    });

    if (!this.enabled) {
      return { attempted: 0, accepted: 0, failed: 0, disabled: true };
    }
    if (subscriptions.length === 0) {
      return { attempted: 0, accepted: 0, failed: 0, disabled: false };
    }

    let accepted = 0;
    let failed = 0;

    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify({
            title: payload.title,
            body: payload.body,
            severity: payload.severity ?? 'INFO',
            actionUrl: payload.actionUrl ?? '/',
            notificationId: payload.notificationId,
            tag: payload.tag,
          }),
        );

        accepted += 1;
        await this.prisma.pushSubscription.update({
          where: { id: subscription.id },
          data: { lastSentAt: new Date(), failCount: 0, lastError: null },
        });
      } catch (error) {
        failed += 1;
        const statusCode = (error as { statusCode?: number }).statusCode;
        const message = error instanceof Error ? error.message : String(error);

        // 404/410 = la suscripción ya no existe en el navegador.
        const shouldDeactivate = statusCode === 404 || statusCode === 410;

        await this.prisma.pushSubscription.update({
          where: { id: subscription.id },
          data: {
            failCount: { increment: 1 },
            lastError: `${statusCode ?? 'sin código'}: ${message}`.slice(0, 300),
            isActive: shouldDeactivate ? false : true,
          },
        });

        this.logger.warn(
          `Fallo al enviar push a ${subscription.id} (${statusCode ?? 'sin código'}): ${message}${
            shouldDeactivate ? ' — suscripción desactivada' : ''
          }`,
        );
      }
    }

    return { attempted: subscriptions.length, accepted, failed, disabled: false };
  }

  /** Estadísticas honestas para el informe de UAT. */
  async deliveryReport(userId: string) {
    const subscriptions = await this.prisma.pushSubscription.findMany({ where: { userId } });
    return {
      pushEnabledOnServer: this.enabled,
      publicKeyConfigured: Boolean(this.publicKey),
      total: subscriptions.length,
      active: subscriptions.filter((subscription) => subscription.isActive).length,
      withFailures: subscriptions.filter((subscription) => subscription.failCount > 0).length,
      lastError: subscriptions.find((subscription) => subscription.lastError)?.lastError ?? null,
      note: this.enabled
        ? 'El servidor puede enviar avisos push. La entrega real depende del navegador y del sistema operativo.'
        : 'Faltan claves VAPID: los avisos se muestran sólo dentro de la aplicación.',
    };
  }

  /** Valida que el endpoint pertenezca al usuario (evita suplantación entre usuarios). */
  async assertOwnership(userId: string, endpoint: string): Promise<void> {
    const subscription = await this.prisma.pushSubscription.findUnique({ where: { endpoint } });
    if (subscription && subscription.userId !== userId) {
      throw new ConflictError('Ese endpoint de notificaciones ya está registrado por otro usuario');
    }
  }
}

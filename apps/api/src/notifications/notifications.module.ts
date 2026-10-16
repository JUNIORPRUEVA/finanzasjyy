import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsScheduler } from './notifications.scheduler.js';
import { NotificationsService } from './notifications.service.js';
import { PushService } from './push.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, PushService, NotificationsScheduler],
  exports: [NotificationsService, PushService],
})
export class NotificationsModule {}

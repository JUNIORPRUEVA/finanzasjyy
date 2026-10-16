import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service.js';

/**
 * Módulo global de seguridad: expone el control de acceso a unidades
 * financieras a todos los módulos de dominio.
 */
@Global()
@Module({
  providers: [AccessService],
  exports: [AccessService],
})
export class SecurityModule {}

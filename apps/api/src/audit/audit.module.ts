import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

/**
 * MÓDULO DE AUDITORÍA
 * ===================
 * Ojo con este archivo: `@Global()` hace que el servicio esté disponible en toda
 * la aplicación (cualquier módulo puede registrar quién hizo qué), pero **el
 * controlador hay que declararlo aquí**. Sin esa línea, `GET /audit` responde 404
 * aunque el archivo del controlador exista, y la pantalla de auditoría queda
 * inservible sin que nada avise: el servicio sigue funcionando por dentro y los
 * registros se siguen guardando. Es exactamente el fallo que se encontró al usar
 * la aplicación (ver `docs/INFORME-UX-COMPRAS.md`).
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

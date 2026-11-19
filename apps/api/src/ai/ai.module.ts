import { Module } from '@nestjs/common';
import { AiService } from './ai.service.js';

/**
 * ASISTENTE DE COMPRAS (IA)
 * Exporta el servicio para que Compras pueda leer facturas y pedir consejos.
 * No tiene controlador propio: los endpoints viven en el módulo de compras,
 * donde se aplican sus permisos.
 */
@Module({
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}

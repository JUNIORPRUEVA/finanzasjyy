import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/http.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Sonda de vida: no toca la base de datos. */
  @Public()
  @Get()
  live(): { status: string; app: string; timezone: string; timestamp: string } {
    return {
      status: 'ok',
      app: 'FINANZA API',
      timezone: process.env.BUSINESS_TIMEZONE ?? 'America/Santo_Domingo',
      timestamp: new Date().toISOString(),
    };
  }

  /** Sonda de preparación: comprueba la base de datos y las migraciones. */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string; database: string; migrationsApplied: boolean; detail?: string }> {
    const result = await this.prisma.healthcheck();
    return {
      status: result.ok && result.migrationsApplied ? 'ready' : 'degraded',
      database: result.ok ? 'up' : 'down',
      migrationsApplied: result.migrationsApplied,
      detail: result.error,
    };
  }
}

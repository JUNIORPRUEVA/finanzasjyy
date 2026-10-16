import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

/**
 * Conexión a PostgreSQL mediante el adaptador `pg` (driver nativo, sin motor Rust).
 *
 * GOTCHA documentado: en `PrismaPg` el esquema va en el SEGUNDO argumento
 * (`new PrismaPg(poolConfig, { schema })`). Si se pasa dentro del primer objeto,
 * `pg` lo ignora en silencio y todo acaba en `public`. FINANZA usa `public`
 * dentro de una base de datos dedicada, por lo que aquí no se necesita el
 * segundo argumento; se deja constancia para cuando se migre a esquema propio.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL');
    if (!connectionString) {
      throw new Error('DATABASE_URL no está configurada: revisa apps/api/.env');
    }

    const adapter = new PrismaPg({
      connectionString,
      max: Number(config.get<string>('DATABASE_POOL_MAX') ?? 10),
    });

    super({
      adapter,
      log: config.get<string>('NODE_ENV') === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conectado a PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Comprueba que la base responde y que las migraciones están aplicadas.
   * Se usa en el endpoint de salud y al arrancar.
   */
  async healthcheck(): Promise<{ ok: boolean; migrationsApplied: boolean; error?: string }> {
    try {
      await this.$queryRaw`SELECT 1`;
      const rows = await this.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL
      `;
      return { ok: true, migrationsApplied: Number(rows[0]?.count ?? 0) > 0 };
    } catch (error) {
      return {
        ok: false,
        migrationsApplied: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Ejecuta `fn` dentro de una transacción con nivel de aislamiento SERIALIZABLE
   * cuando se trata de dinero. Cualquier error provoca ROLLBACK completo.
   *
   * Los conflictos de serialización (SQLSTATE 40001 / P2034) SÍ pueden ocurrir
   * aunque el aislamiento sea Serializable: es la forma que tiene PostgreSQL de
   * avisar de que dos transacciones se han cruzado. Aquí se REINTENTA la
   * operación completa, que es seguro porque la transacción se ha deshecho por
   * completo y la idempotencia se garantiza por `clientOperationId`.
   */
  async inMoneyTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const maxAttempts = 3;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.$transaction(fn, {
          isolationLevel: 'Serializable',
          timeout: 30_000,
          maxWait: 10_000,
        });
      } catch (error) {
        if (attempt >= maxAttempts || !this.isRetryableConflict(error)) {
          throw error;
        }
        this.logger.warn(
          `Conflicto de concurrencia al registrar dinero (intento ${attempt}/${maxAttempts}). Reintentando...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
      }
    }
  }

  /** Detecta errores de serialización/deadlock que merecen un reintento. */
  private isRetryableConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const candidate = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    const code = candidate.code ?? candidate.cause?.code;
    const message = `${candidate.message ?? ''} ${candidate.cause?.message ?? ''}`;

    return (
      code === 'P2034' ||
      code === '40001' ||
      code === '40P01' ||
      /could not serialize access|write conflict|deadlock detected/i.test(message)
    );
  }
}

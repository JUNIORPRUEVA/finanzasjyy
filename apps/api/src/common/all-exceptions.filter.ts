import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError, isDomainError } from '../common/errors.js';
import { MoneyError } from '../domain/money.js';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  path?: string;
  timestamp: string;
}

/**
 * FILTRO GLOBAL DE EXCEPCIONES
 * ----------------------------
 * 1. Traduce los errores de dominio a HTTP sin exponer trazas internas.
 * 2. Traduce los errores de Prisma (duplicado, clave foránea, no encontrado)
 *    a códigos comprensibles en lugar de un 500 opaco.
 * 3. Traduce las violaciones de los TRIGGERS de integridad contable a 422 con
 *    el mensaje exacto de la base de datos: es la última línea de defensa del
 *    sistema y su explicación ("asiento descuadrado...") es útil, no ruido.
 * 4. Nunca devuelve `stack` ni detalles de conexión al cliente.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const body = this.toErrorBody(exception, request);

    if (body.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${body.statusCode} ${body.code}: ${body.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (body.statusCode >= 400) {
      this.logger.warn(`${request.method} ${request.url} -> ${body.statusCode} ${body.code}: ${body.message}`);
    }

    response.status(body.statusCode).json(body);
  }

  private toErrorBody(exception: unknown, request: Request): ErrorBody {
    const timestamp = new Date().toISOString();
    const path = request.url;

    if (isDomainError(exception)) {
      const domain = exception as DomainError;
      return {
        statusCode: domain.status,
        code: domain.code,
        message: domain.message,
        details: domain.details,
        path,
        timestamp,
      };
    }

    if (exception instanceof MoneyError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'INVALID_AMOUNT',
        message: exception.message,
        path,
        timestamp,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      let message = exception.message;
      let details: unknown;

      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        const rawMessage = record.message;
        if (Array.isArray(rawMessage)) {
          message = rawMessage.join('; ');
          details = rawMessage;
        } else if (typeof rawMessage === 'string') {
          message = rawMessage;
        }
      }

      return {
        statusCode: status,
        code: this.httpCodeName(status),
        message,
        details,
        path,
        timestamp,
      };
    }

    const prismaMapped = this.mapPrismaError(exception);
    if (prismaMapped) {
      return { ...prismaMapped, path, timestamp };
    }

    const dbMapped = this.mapDatabaseIntegrityError(exception);
    if (dbMapped) {
      return { ...dbMapped, path, timestamp };
    }

    const message = exception instanceof Error ? exception.message : 'Error interno';
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      // En desarrollo se muestra el mensaje real; en producción, uno genérico.
      message:
        process.env.NODE_ENV === 'production'
          ? 'Error interno del servidor. El equipo técnico ha registrado el detalle.'
          : message,
      path,
      timestamp,
    };
  }

  private httpCodeName(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      default:
        return 'HTTP_ERROR';
    }
  }

  private mapPrismaError(exception: unknown): Omit<ErrorBody, 'path' | 'timestamp'> | null {
    if (!exception || typeof exception !== 'object') {
      return null;
    }
    const code = (exception as { code?: string }).code;
    if (typeof code !== 'string' || !code.startsWith('P')) {
      return null;
    }

    switch (code) {
      case 'P2002': {
        const meta = (exception as { meta?: Record<string, unknown> }).meta ?? {};
        const target = (meta as { target?: unknown }).target;
        const fields = Array.isArray(target) ? target.join(', ') : String(target ?? JSON.stringify(meta));
        return {
          statusCode: HttpStatus.CONFLICT,
          code: 'DUPLICATE_RECORD',
          message: `Ya existe un registro con el mismo valor en: ${fields}`,
          // Se devuelve el meta completo: con el adaptador `pg` el campo
          // conflictivo aparece anidado y sin esto no hay forma de diagnosticar.
          details: meta,
        };
      }
      case 'P2003':
        return {
          statusCode: HttpStatus.CONFLICT,
          code: 'FOREIGN_KEY_VIOLATION',
          message: 'La operación referencia un registro que no existe o que está en uso.',
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'El registro solicitado no existe.',
        };
      case 'P2034':
        return {
          statusCode: HttpStatus.CONFLICT,
          code: 'TRANSACTION_CONFLICT',
          message: 'Otra operación modificó los mismos datos al mismo tiempo. Vuelva a intentarlo.',
        };
      case 'P1000':
      case 'P1001':
      case 'P1002':
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'DATABASE_UNAVAILABLE',
          message: 'No se pudo conectar con la base de datos. Verifique que PostgreSQL está en marcha.',
        };
      default:
        return null;
    }
  }

  /**
   * Los triggers de integridad contable lanzan `check_violation` (23514) con
   * mensajes en español escritos para el usuario final.
   */
  private mapDatabaseIntegrityError(
    exception: unknown,
  ): Omit<ErrorBody, 'path' | 'timestamp'> | null {
    if (!exception || typeof exception !== 'object') {
      return null;
    }
    const error = exception as { code?: string; message?: string; cause?: unknown };
    const cause = error.cause as { code?: string; message?: string } | undefined;
    const dbCode = cause?.code ?? error.code;
    const rawMessage = cause?.message ?? error.message ?? '';

    const isCheckViolation =
      dbCode === '23514' ||
      rawMessage.includes('check_violation') ||
      /Asiento contable|Prohibido|exige un motivo/i.test(rawMessage);

    if (!isCheckViolation) {
      return null;
    }

    const clean = rawMessage.split('\n')[0];

    if (/Cuentas intercompañ|intercompan/i.test(clean)) {
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'LEDGER_INTEGRITY',
        message: clean,
      };
    }

    if (/Asiento contable/i.test(clean)) {
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'LEDGER_UNBALANCED',
        message: `La base de datos rechazó el asiento: ${clean}`,
      };
    }

    if (/reasign|movimiento|linea de asiento|registro financiero/i.test(clean)) {
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'IMMUTABLE_RECORD',
        message: clean,
      };
    }

    return {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'INTEGRITY_VIOLATION',
      message: clean,
    };
  }
}

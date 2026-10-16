import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Prisma } from '../generated/prisma/client.js';

/**
 * SERIALIZACIÓN SEGURA DE DINERO
 * ------------------------------
 * Todo importe viaja al cliente como STRING decimal ("1250.75"), nunca como
 * número flotante de JavaScript. Es la última barrera de la política monetaria:
 * aunque un `Decimal` se cuele en un objeto de respuesta, se convierte aquí
 * antes de que `JSON.stringify` lo transforme en un flotante impreciso.
 *
 * También convierte `BigInt` a string (JSON no soporta BigInt y lanzaría
 * "Do not know how to serialize a BigInt").
 */
@Injectable()
export class SerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => this.serialize(data)));
  }

  private serialize(value: unknown, depth = 0): unknown {
    if (depth > 24) {
      return value;
    }
    if (value === null || value === undefined) {
      return value;
    }
    if (value instanceof Prisma.Decimal) {
      return value.toFixed(2);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.serialize(item, depth + 1));
    }
    if (typeof value === 'object') {
      // Se respeta cualquier respuesta ya preparada (por ejemplo, un objeto
      // envuelto por @Res() o un stream) sin recorrerlo.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        return value;
      }
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.serialize(nested, depth + 1);
      }
      return result;
    }
    return value;
  }
}

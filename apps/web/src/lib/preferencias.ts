/**
 * PREFERENCIAS DE OPERACIÓN (sólo en este dispositivo)
 * ====================================================
 * Guarda en el teléfono lo que la persona ya eligió la última vez, para no
 * volver a preguntárselo: la cuenta con la que apuntó el último gasto, la que
 * usó para el último ingreso…
 *
 * Tres decisiones deliberadas:
 *
 *  1. **Se guarda por tipo de operación y por unidad.** Quien gasta desde la
 *     caja de FULLTECH no gasta desde el banco personal: recordar una sola
 *     cuenta global obligaría a corregirla cada vez.
 *  2. **No se guarda nada sensible ni contable**: sólo un identificador de
 *     cuenta que ya está en la lista del servidor. Si la cuenta se borra o el
 *     usuario pierde el acceso, el identificador deja de encontrarse y la
 *     aplicación usa el valor por defecto de siempre. Nunca puede provocar un
 *     movimiento en la cuenta equivocada «porque lo recordaba».
 *  3. **Vive en localStorage, no en la base de datos.** No hay migración, no hay
 *     campo nuevo en el servidor y borrar los datos del navegador no rompe nada.
 *     Cuando se quiera compartir entre dispositivos, esto se sustituye por una
 *     preferencia del servidor sin tocar las pantallas.
 *
 * Todo va envuelto en try/catch: en modo privado algunos navegadores lanzan al
 * escribir en localStorage, y que no se pueda recordar una cuenta no puede
 * impedir registrar el movimiento.
 */

const CLAVE = 'finanza:ultimaCuenta';

function leerMapa(): Record<string, string> {
  try {
    const crudo = window.localStorage.getItem(CLAVE);
    if (!crudo) {
      return {};
    }
    const valor = JSON.parse(crudo) as unknown;
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) {
      return {};
    }
    const mapa: Record<string, string> = {};
    for (const [clave, dato] of Object.entries(valor as Record<string, unknown>)) {
      if (typeof dato === 'string' && dato !== '') {
        mapa[clave] = dato;
      }
    }
    return mapa;
  } catch {
    return {};
  }
}

function claveDe(kind: string, entityId: string | undefined): string {
  return `${kind}:${entityId ?? 'todas'}`;
}

/** Cuenta usada la última vez para este tipo de operación en esta unidad. */
export function leerUltimaCuenta(kind: string, entityId?: string): string {
  return leerMapa()[claveDe(kind, entityId)] ?? '';
}

/** Recuerda la cuenta elegida. Si no se puede guardar, no pasa nada. */
export function guardarUltimaCuenta(kind: string, accountId: string, entityId?: string): void {
  if (!accountId) {
    return;
  }
  try {
    const mapa = leerMapa();
    mapa[claveDe(kind, entityId)] = accountId;
    window.localStorage.setItem(CLAVE, JSON.stringify(mapa));
  } catch {
    // Sin memoria de preferencias la aplicación sigue funcionando igual.
  }
}

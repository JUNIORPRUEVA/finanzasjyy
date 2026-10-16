/**
 * ERRORES DE DOMINIO DE FINANZA
 * -----------------------------
 * El dominio no conoce HTTP: lanza estos errores y el filtro global los traduce
 * a códigos de estado. Así las reglas financieras se pueden probar sin levantar
 * el servidor y el mensaje que ve el usuario explica QUÉ regla se rompió.
 */

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Datos de entrada inválidos (400). */
export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Se requiere autenticación') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'No tiene permiso para esta operación') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id?: string) {
    super(id ? `${resource} no encontrado: ${id}` : `${resource} no encontrado`, 'NOT_FOUND', 404);
  }
}

/** Conflicto con el estado actual: duplicado, cierre ya hecho, etc. (409). */
export class ConflictError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFLICT', 409, details);
  }
}

/** Se ha violado un invariante financiero (422). */
export class InvariantError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'FINANCIAL_INVARIANT_VIOLATED', 422, details);
  }
}

/** La operación no es válida dentro del estado actual de un cierre (422). */
export class ClosingStateError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'CLOSING_STATE_ERROR', 422, details);
  }
}

/** La ventana de trabajo offline ha caducado: hace falta conexión (401). */
export class OfflineWindowExpiredError extends DomainError {
  constructor(message = 'La autorización offline ha caducado. Conéctese a internet para continuar.') {
    super(message, 'OFFLINE_WINDOW_EXPIRED', 401);
  }
}

/**
 * El mismo `clientOperationId` llegó con un contenido distinto.
 * Indica un fallo de la app cliente, no un simple reintento.
 */
export class IdempotencyConflictError extends DomainError {
  constructor(operationId: string, details?: unknown) {
    super(
      `La operación ${operationId} ya se registró con datos diferentes. Se conserva la primera versión.`,
      'IDEMPOTENCY_CONFLICT',
      409,
      details,
    );
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

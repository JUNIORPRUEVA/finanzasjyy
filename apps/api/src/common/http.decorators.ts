import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { EntityMemberRole, UserRole } from '../generated/prisma/enums.js';

export const IS_PUBLIC_KEY = 'finanza:isPublic';
export const ROLES_KEY = 'finanza:roles';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  sessionId: string;
  deviceId?: string;
  /** Hasta cuándo puede operar sin conexión con esta sesión. */
  offlineAllowedUntil?: string;
}

/** Marca un endpoint como accesible sin autenticación (login, salud). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restringe un endpoint a determinados roles globales. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Inyecta el usuario autenticado en el handler. */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext): unknown => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      return undefined;
    }
    return data ? user[data] : user;
  },
);

export interface EntityAccessContext {
  entityId: string;
  role: EntityMemberRole;
  isOwner: boolean;
}

/** Inyecta el contexto de acceso a la unidad financiera resuelto por el guard/servicio. */
export const EntityAccess = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): EntityAccessContext | undefined => {
    const request = ctx.switchToHttp().getRequest<{ entityAccess?: EntityAccessContext }>();
    return request.entityAccess;
  },
);

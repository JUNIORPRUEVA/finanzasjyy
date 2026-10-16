import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { UserRole } from '../generated/prisma/enums.js';
import { ForbiddenError, UnauthorizedError } from '../common/errors.js';
import { IS_PUBLIC_KEY, ROLES_KEY, type AuthenticatedUser } from '../common/http.decorators.js';

/**
 * Guard de autenticación. Respeta @Public() y, cuando la sesión se usó para
 * operar offline, informa en la respuesta hasta cuándo está permitido.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  handleRequest<TUser = AuthenticatedUser>(err: unknown, user: TUser | false): TUser {
    if (err || !user) {
      if (err instanceof Error) {
        throw err;
      }
      throw new UnauthorizedError('Se requiere autenticación para esta operación');
    }
    return user;
  }
}

/** Guard de roles globales (OWNER/ADMIN/MEMBER/VIEWER). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      throw new UnauthorizedError();
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenError(`Esta acción requiere uno de estos roles: ${required.join(', ')}`);
    }
    return true;
  }
}

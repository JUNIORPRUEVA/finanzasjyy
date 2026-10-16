import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import { UnauthorizedError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AccessTokenPayload } from './tokens.js';

/**
 * Estrategia JWT de FINANZA.
 *
 * Además de verificar la firma, comprueba CONTRA LA BASE DE DATOS que la sesión
 * sigue viva: así cerrar sesión o revocar un dispositivo surte efecto
 * inmediatamente, sin esperar a que caduque el token.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET no está configurado');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: {
        id: true,
        revokedAt: true,
        expiresAt: true,
        offlineAllowedUntil: true,
        userId: true,
        user: { select: { isActive: true, email: true, name: true, role: true } },
      },
    });

    if (!session || session.revokedAt !== null) {
      throw new UnauthorizedError('La sesión no es válida o ha sido cerrada');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError('La sesión ha caducado. Inicie sesión de nuevo.');
    }
    if (!session.user.isActive || session.userId !== payload.sub) {
      throw new UnauthorizedError('El usuario está inactivo');
    }

    return {
      userId: session.userId,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      sessionId: session.id,
      deviceId: payload.did,
      offlineAllowedUntil: session.offlineAllowedUntil?.toISOString(),
    };
  }
}

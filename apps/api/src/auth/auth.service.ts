import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../common/errors.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshTokenDto,
  RegisterUserDto,
  UpdatePreferencesDto,
  UpdateProfileDto,
} from './auth.dto.js';
import { hashPassword, isPasswordStrongEnough, verifyPassword } from './password.js';
import { generateRefreshToken, hashToken, type AccessTokenPayload } from './tokens.js';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  /** Fin de la ventana en la que la app puede operar sin conexión. */
  offlineAllowedUntil: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

/**
 * SERVICIO DE AUTENTICACIÓN
 * -------------------------
 * · Contraseñas con Argon2id; nunca se guarda ni se registra la contraseña.
 * · Bloqueo temporal tras 5 intentos fallidos (protección de fuerza bruta).
 * · El refresh token rota en cada uso y se guarda HASHEADO.
 * · La sesión lleva una VENTANA OFFLINE explícita: la app puede registrar
 *   movimientos sin conexión hasta ese instante, y el servidor lo sabe.
 * · Cerrar sesión revoca la sesión de inmediato (el guard consulta la BD).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** Hash de referencia para igualar tiempos cuando el usuario no existe. */
  private readonly dummyHash: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {
    // Se calcula una vez por proceso; sólo se usa para comparar tiempos.
    this.dummyHash =
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZXg$3f9y0Yq0k8Q1n5Pz3s0nHqz4k3H9v5r8wWq1f0nGm2Y';
  }

  private get accessTtlSeconds(): number {
    return Number(this.config.get<string>('JWT_ACCESS_TTL') ?? 900);
  }

  private get refreshTtlSeconds(): number {
    return Number(this.config.get<string>('JWT_REFRESH_TTL') ?? 2_592_000);
  }

  private get offlineWindowHours(): number {
    return Number(this.config.get<string>('OFFLINE_WINDOW_HOURS') ?? 24);
  }

  /** ¿Existe ya algún usuario? Lo usa el onboarding del frontend. */
  async bootstrapStatus(): Promise<{ requiresSetup: boolean; userCount: number }> {
    const userCount = await this.prisma.user.count();
    return { requiresSetup: userCount === 0, userCount };
  }

  async login(dto: LoginDto, meta: RequestMetaInfo): Promise<AuthResponse> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Se compara igualmente contra un hash para no filtrar por tiempo de respuesta
      // si el correo existe o no.
      await verifyPassword(this.dummyHash, dto.password).catch(() => false);
      await this.audit.record({
        action: 'auth.login.failed',
        entityType: 'User',
        entityId: null,
        after: { email, reason: 'USER_NOT_FOUND' },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedError('Credenciales inválidas');
    }

    if (!user.isActive) {
      throw new ForbiddenError('El usuario está desactivado');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      await this.audit.record({
        userId: user.id,
        action: 'auth.login.blocked',
        entityType: 'User',
        entityId: user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new ForbiddenError(
        `La cuenta está bloqueada temporalmente por intentos fallidos. Inténtelo en ${minutes} minuto(s).`,
      );
    }

    const validPassword = await verifyPassword(user.passwordHash, dto.password);
    if (!validPassword) {
      const attempts = user.failedLoginCount + 1;
      const shouldLock = attempts >= MAX_LOGIN_ATTEMPTS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: attempts,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      await this.audit.record({
        userId: user.id,
        action: 'auth.login.failed',
        entityType: 'User',
        entityId: user.id,
        after: { attempts, locked: shouldLock },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedError(
        shouldLock
          ? `Credenciales inválidas. La cuenta quedó bloqueada ${LOCK_MINUTES} minutos.`
          : 'Credenciales inválidas',
      );
    }

    return this.issueSession(user.id, dto, meta, 'auth.login.success');
  }

  /**
   * Alta del PRIMER usuario (onboarding). Si ya existe algún usuario, esta vía
   * se cierra: a partir de ahí sólo un OWNER/ADMIN puede crear usuarios.
   */
  async registerFirstUser(dto: RegisterUserDto, meta: RequestMetaInfo): Promise<AuthResponse> {
    const userCount = await this.prisma.user.count();
    if (userCount > 0) {
      throw new ConflictError(
        'Ya existe un usuario propietario. Solicite a un administrador que cree su cuenta desde Ajustes → Usuarios.',
      );
    }

    const strength = isPasswordStrongEnough(dto.password);
    if (!strength.ok) {
      throw new UnauthorizedError(strength.reason ?? 'Contraseña demasiado débil');
    }

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.trim().toLowerCase(),
        name: dto.name.trim(),
        passwordHash: await hashPassword(dto.password),
        role: 'OWNER',
        isActive: true,
      },
    });

    await this.ensurePreferences(user.id);
    await this.audit.record({
      userId: user.id,
      action: 'auth.user.created',
      entityType: 'User',
      entityId: user.id,
      after: { email: user.email, role: user.role, via: 'ONBOARDING' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.issueSession(user.id, dto, meta, 'auth.login.success');
  }

  /** Alta de usuarios por parte de un administrador. */
  async createUser(
    dto: RegisterUserDto,
    actor: AuthenticatedUser,
    meta: RequestMetaInfo,
  ): Promise<{ id: string; email: string; name: string; role: string }> {
    const strength = isPasswordStrongEnough(dto.password);
    if (!strength.ok) {
      throw new UnauthorizedError(strength.reason ?? 'Contraseña demasiado débil');
    }

    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictError('Ya existe un usuario con ese correo electrónico');
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name.trim(),
        passwordHash: await hashPassword(dto.password),
        role: dto.role ?? 'MEMBER',
        isActive: true,
      },
    });

    await this.ensurePreferences(user.id);
    await this.audit.record({
      userId: actor.userId,
      action: 'auth.user.created',
      entityType: 'User',
      entityId: user.id,
      after: { email: user.email, role: user.role, via: 'ADMIN' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  async listUsers(): Promise<Array<{ id: string; email: string; name: string; role: string; isActive: boolean; lastLoginAt: Date | null }>> {
    return this.prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, isActive: true, lastLoginAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Rota el refresh token en cada uso (rotación de credenciales). */
  async refresh(dto: RefreshTokenDto, meta: RequestMetaInfo): Promise<AuthResponse> {
    const tokenHash = hashToken(dto.refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
      include: { user: { select: { id: true, isActive: true } } },
    });

    if (!session) {
      throw new UnauthorizedError('La sesión no es válida. Vuelva a iniciar sesión.');
    }
    if (session.revokedAt) {
      // Un refresh token revocado que se vuelve a presentar es señal de robo:
      // se cierran TODAS las sesiones del usuario por precaución.
      await this.prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'REFRESH_TOKEN_REUSE_DETECTED' },
      });
      await this.audit.record({
        userId: session.userId,
        action: 'auth.refresh.reuse_detected',
        entityType: 'Session',
        entityId: session.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedError('Se detectó un uso indebido del token. Todas las sesiones se cerraron.');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError('La sesión ha caducado. Inicie sesión de nuevo.');
    }
    if (!session.user.isActive) {
      throw new ForbiddenError('El usuario está desactivado');
    }

    const newRefreshToken = generateRefreshToken();
    const offlineAllowedUntil = new Date(Date.now() + this.offlineWindowHours * 3_600_000);
    const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1_000);

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: hashToken(newRefreshToken),
        expiresAt,
        offlineAllowedUntil,
        lastUsedAt: new Date(),
        ip: meta.ip ?? session.ip,
        userAgent: meta.userAgent ?? session.userAgent,
      },
    });

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: session.userId },
      select: { id: true, email: true, name: true, role: true },
    });

    return {
      accessToken: await this.signAccessToken({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        sid: session.id,
        did: dto.deviceId,
        offlineUntil: Math.floor(offlineAllowedUntil.getTime() / 1_000),
      }),
      refreshToken: newRefreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
      offlineAllowedUntil: offlineAllowedUntil.toISOString(),
      user,
    };
  }

  async logout(user: AuthenticatedUser, meta: RequestMetaInfo): Promise<{ revoked: boolean }> {
    await this.prisma.session.updateMany({
      where: { id: user.sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'USER_LOGOUT' },
    });
    await this.audit.record({
      userId: user.userId,
      action: 'auth.logout',
      entityType: 'Session',
      entityId: user.sessionId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { revoked: true };
  }

  async logoutAll(user: AuthenticatedUser, meta: RequestMetaInfo): Promise<{ revokedCount: number }> {
    const result = await this.prisma.session.updateMany({
      where: { userId: user.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'USER_LOGOUT_ALL' },
    });
    await this.audit.record({
      userId: user.userId,
      action: 'auth.logout_all',
      entityType: 'User',
      entityId: user.userId,
      after: { revokedCount: result.count },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { revokedCount: result.count };
  }

  /**
   * Perfil del usuario: incluye preferencias y las unidades financieras a las
   * que tiene acceso, para que la app no tenga que adivinar el contexto.
   */
  async me(user: AuthenticatedUser) {
    const [profile, preferences, memberships] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: user.userId },
        select: { id: true, email: true, name: true, role: true, lastLoginAt: true, createdAt: true },
      }),
      this.ensurePreferences(user.userId),
      this.prisma.financialEntity.findMany({
        where: {
          isActive: true,
          OR: [{ ownerUserId: user.userId }, { members: { some: { userId: user.userId } } }],
        },
        select: { id: true, code: true, name: true, type: true, currency: true, isActive: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const session = await this.prisma.session.findUnique({
      where: { id: user.sessionId },
      select: { offlineAllowedUntil: true, deviceId: true, createdAt: true },
    });

    return {
      user: profile,
      preferences,
      entities: memberships,
      session: {
        id: user.sessionId,
        deviceId: session?.deviceId ?? null,
        offlineAllowedUntil: session?.offlineAllowedUntil ?? null,
        offlineWindowHours: preferences.offlineWindowHours,
      },
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto, meta: RequestMetaInfo) {
    const before = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, email: true },
    });

    if (dto.email && dto.email.toLowerCase() !== before.email) {
      const existing = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
      if (existing) {
        throw new ConflictError('Ese correo electrónico ya está en uso');
      }
    }

    const after = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name?.trim(),
        email: dto.email?.trim().toLowerCase(),
      },
      select: { id: true, email: true, name: true },
    });

    await this.audit.record({
      userId,
      action: 'auth.profile.updated',
      entityType: 'User',
      entityId: userId,
      before,
      after,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return after;
  }

  async changePassword(
    user: AuthenticatedUser,
    dto: ChangePasswordDto,
    meta: RequestMetaInfo,
  ): Promise<{ changed: boolean; revokedOtherSessions: boolean }> {
    const record = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });

    const valid = await verifyPassword(record.passwordHash, dto.currentPassword);
    if (!valid) {
      await this.audit.record({
        userId: user.userId,
        action: 'auth.password.change_failed',
        entityType: 'User',
        entityId: user.userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedError('La contraseña actual no es correcta');
    }

    const strength = isPasswordStrongEnough(dto.newPassword);
    if (!strength.ok) {
      throw new UnauthorizedError(strength.reason ?? 'Contraseña demasiado débil');
    }

    await this.prisma.user.update({
      where: { id: user.userId },
      data: { passwordHash: await hashPassword(dto.newPassword) },
    });

    let revokedOtherSessions = false;
    if (dto.revokeOtherSessions !== false) {
      const result = await this.prisma.session.updateMany({
        where: { userId: user.userId, revokedAt: null, id: { not: user.sessionId } },
        data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
      });
      revokedOtherSessions = result.count > 0;
    }

    await this.audit.record({
      userId: user.userId,
      action: 'auth.password.changed',
      entityType: 'User',
      entityId: user.userId,
      after: { revokedOtherSessions },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { changed: true, revokedOtherSessions };
  }

  async listSessions(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        revokedReason: true,
        offlineAllowedUntil: true,
      },
      take: 50,
    });

    return sessions.map((session) => ({
      ...session,
      isActive: session.revokedAt === null && session.expiresAt.getTime() > Date.now(),
    }));
  }

  async revokeSession(userId: string, sessionId: string, meta: RequestMetaInfo): Promise<{ revoked: boolean }> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new NotFoundError('Sesión', sessionId);
    }
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedReason: 'REVOKED_BY_USER' },
    });
    await this.audit.record({
      userId,
      action: 'auth.session.revoked',
      entityType: 'Session',
      entityId: sessionId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { revoked: true };
  }

  async listDevices(userId: string) {
    return this.prisma.device.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        name: true,
        platform: true,
        appVersion: true,
        isActive: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });
  }

  async revokeDevice(userId: string, deviceId: string, meta: RequestMetaInfo): Promise<{ revoked: boolean }> {
    const device = await this.prisma.device.findFirst({ where: { userId, deviceId } });
    if (!device) {
      throw new NotFoundError('Dispositivo', deviceId);
    }
    await this.prisma.device.update({ where: { id: device.id }, data: { isActive: false } });
    const result = await this.prisma.session.updateMany({
      where: { userId, deviceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'DEVICE_REVOKED' },
    });
    await this.audit.record({
      userId,
      action: 'auth.device.revoked',
      entityType: 'Device',
      entityId: device.id,
      after: { sessionsRevoked: result.count },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { revoked: true };
  }

  async getPreferences(userId: string) {
    return this.ensurePreferences(userId);
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto, meta: RequestMetaInfo) {
    await this.ensurePreferences(userId);
    const before = await this.prisma.userPreference.findUniqueOrThrow({ where: { userId } });

    const updated = await this.prisma.userPreference.update({
      where: { userId },
      data: {
        timezone: dto.timezone,
        currency: dto.currency?.toUpperCase(),
        locale: dto.locale,
        theme: dto.theme,
        closingReminderHour: dto.closingReminderHour,
        closingReminderMinute: dto.closingReminderMinute,
        reminderOffsetsJson: dto.reminderOffsetsMinutes
          ? (JSON.parse(JSON.stringify(dto.reminderOffsetsMinutes)) as object)
          : undefined,
        offlineWindowHours: dto.offlineWindowHours,
        budgetWarnPct: dto.budgetWarnPct,
        budgetAlertPct: dto.budgetAlertPct,
        cashDifferenceAlert: dto.cashDifferenceAlert,
        pushEnabled: dto.pushEnabled,
        dailyBriefEnabled: dto.dailyBriefEnabled,
      },
    });

    await this.audit.record({
      userId,
      action: 'settings.preferences.updated',
      entityType: 'UserPreference',
      entityId: updated.id,
      before,
      after: updated,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private async issueSession(
    userId: string,
    dto: LoginDto | RegisterUserDto,
    meta: RequestMetaInfo,
    auditAction: string,
  ): Promise<AuthResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true },
    });

    const refreshToken = generateRefreshToken();
    const offlineAllowedUntil = new Date(Date.now() + this.offlineWindowHours * 3_600_000);
    const deviceId = dto.deviceId ?? meta.deviceId;

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashToken(refreshToken),
        deviceId: deviceId ?? null,
        offlineAllowedUntil,
        expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1_000),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        lastUsedAt: new Date(),
      },
    });

    if (deviceId) {
      await this.prisma.device.upsert({
        where: { userId_deviceId: { userId: user.id, deviceId } },
        create: {
          userId: user.id,
          deviceId,
          name: dto.deviceName ?? 'Dispositivo',
          platform: dto.platform ?? 'desconocida',
          appVersion: dto.appVersion ?? null,
          isActive: true,
          lastSeenAt: new Date(),
        },
        update: {
          name: dto.deviceName ?? undefined,
          platform: dto.platform ?? undefined,
          appVersion: dto.appVersion ?? undefined,
          isActive: true,
          lastSeenAt: new Date(),
        },
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    await this.ensurePreferences(user.id);

    await this.audit.record({
      userId: user.id,
      action: auditAction,
      entityType: 'Session',
      entityId: session.id,
      after: { deviceId: deviceId ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    this.logger.log(`Sesión iniciada para ${user.email} (sesión ${session.id})`);

    return {
      accessToken: await this.signAccessToken({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        sid: session.id,
        did: deviceId,
        offlineUntil: Math.floor(offlineAllowedUntil.getTime() / 1_000),
      }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
      offlineAllowedUntil: offlineAllowedUntil.toISOString(),
      user,
    };
  }

  private async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.accessTtlSeconds,
    });
  }

  private async ensurePreferences(userId: string) {
    const existing = await this.prisma.userPreference.findUnique({ where: { userId } });
    if (existing) {
      return existing;
    }
    return this.prisma.userPreference.create({
      data: {
        userId,
        timezone: this.config.get<string>('BUSINESS_TIMEZONE') ?? 'America/Santo_Domingo',
        currency: this.config.get<string>('DEFAULT_CURRENCY') ?? 'DOP',
        offlineWindowHours: this.offlineWindowHours,
      },
    });
  }

  /** Huella del token para no registrarlo nunca completo en auditoría. */
  static fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 12);
  }
}

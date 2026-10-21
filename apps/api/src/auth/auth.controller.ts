import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser, Public, Roles, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { ForbiddenError, UnauthorizedError } from '../common/errors.js';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshTokenDto,
  RegisterUserDto,
  SetUserPasswordDto,
  UpdatePreferencesDto,
  UpdateProfileDto,
  UpdateUserDto,
} from './auth.dto.js';
import { AuthService, type AuthResponse } from './auth.service.js';
import {
  CSRF_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  csrfMatches,
  generateCsrfToken,
  isCookieSessionMode,
  readCookie,
  setSessionCookies,
} from './session-cookies.js';

/**
 * LÍMITE DE INTENTOS DE ACCESO
 * ---------------------------
 * Cinco intentos por minuto y por dirección, para frenar los ataques de fuerza
 * bruta contra la contraseña. Es una protección REAL y se mantiene en producción.
 *
 * `E2E_AUTH_LOGIN_LIMIT` existe únicamente para las pruebas de navegador: cada
 * prueba abre un navegador limpio y necesita entrar una vez, así que en una
 * verificación completa se superan los cinco intentos y la prueba fallaría
 * diciendo «Too Many Requests» en vez de comprobar lo que quiere comprobar.
 * Es una variable de PROCESO (no del archivo `.env`), de modo que por defecto
 * —y siempre en la aplicación real— el límite es 5.
 */
const LOGIN_RATE_LIMIT = Number(process.env.E2E_AUTH_LOGIN_LIMIT ?? 5);

/**
 * Límite de RENOVACIONES de sesión. Sesenta por minuto es de sobra para una
 * persona (la aplicación renueva al abrir y cada vez que caduca el token de
 * acceso). `E2E_AUTH_REFRESH_LIMIT` sigue el mismo criterio que el límite de
 * acceso: sólo existe para las pruebas de navegador, que abren muchos
 * navegadores seguidos.
 */
const REFRESH_RATE_LIMIT = Number(process.env.E2E_AUTH_REFRESH_LIMIT ?? 60);

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Entrega la sesión al cliente.
   *
   * En modo «cookie» (el que usa la PWA) el refresh token se va a una cookie
   * HttpOnly y NO se devuelve en el cuerpo: así no puede acabar en
   * localStorage ni ser leído por un script ajeno. El access token sí viaja en
   * el cuerpo, porque vive únicamente en memoria del cliente.
   */
  private respondWithSession(
    req: Request,
    res: Response,
    result: AuthResponse,
    meta: RequestMetaInfo,
  ): Omit<AuthResponse, 'refreshToken'> & { sessionMode: 'cookie' | 'token' } {
    if (!isCookieSessionMode(req)) {
      return { ...result, sessionMode: 'token' as const };
    }

    const csrfToken = readCookie(req, CSRF_COOKIE) ?? generateCsrfToken();
    setSessionCookies(req, res, {
      refreshToken: result.refreshToken,
      csrfToken,
      refreshTtlSeconds: this.auth.sessionTtlSeconds,
    });

    const { refreshToken: _ignored, ...rest } = result;
    return { ...rest, sessionMode: 'cookie' as const };
  }

  /** ¿Hace falta el onboarding inicial? Lo consulta la pantalla de acceso. */
  @Public()
  @Get('bootstrap-status')
  bootstrapStatus() {
    return this.auth.bootstrapStatus();
  }

  @Public()
  @Throttle({ default: { limit: LOGIN_RATE_LIMIT, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    const result = await this.auth.login(dto, meta);
    return this.respondWithSession(req, res, result, meta);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterUserDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    const result = await this.auth.registerFirstUser(dto, meta);
    return this.respondWithSession(req, res, result, meta);
  }

  /**
   * Renueva la sesión (rotación de refresh token).
   *
   * Acepta el token en el cuerpo (clientes antiguos) o en la cookie HttpOnly.
   * Cuando llega por cookie se exige el doble envío CSRF: la cookie sólo se
   * envía desde el mismo sitio y la cabecera demuestra que quien pide es la
   * propia aplicación.
   */
  @Public()
  @Throttle({ default: { limit: REFRESH_RATE_LIMIT, ttl: 60_000 } })
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    const cookieToken = readCookie(req, REFRESH_COOKIE);
    const token = dto.refreshToken ?? cookieToken ?? null;

    if (!token) {
      clearSessionCookies(res);
      throw new UnauthorizedError(
        'No hay ninguna sesión que renovar. Inicie sesión.',
        'SESSION_MISSING',
      );
    }

    if (cookieToken && !dto.refreshToken && !csrfMatches(req)) {
      throw new ForbiddenError(
        'La petición de renovación no superó la comprobación de seguridad (CSRF). Recargue la aplicación.',
      );
    }

    try {
      const result = await this.auth.refresh({ ...dto, refreshToken: token }, meta);
      return this.respondWithSession(req, res, result, meta);
    } catch (error) {
      // Si el servidor dice claramente que la sesión ya no sirve, se borran las
      // cookies. Si falla por otra razón (por ejemplo, un corte temporal), las
      // cookies se conservan: el usuario NO debe volver a escribir la contraseña
      // por un problema de red.
      if (error instanceof UnauthorizedError) {
        clearSessionCookies(res);
      }
      throw error;
    }
  }

  @Post('logout')
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    const result = await this.auth.logout(user, meta);
    clearSessionCookies(res);
    return result;
  }

  @Post('logout-all')
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    const result = await this.auth.logoutAll(user, meta);
    clearSessionCookies(res);
    return result;
  }

  /** Indica si el navegador trae indicios de sesión (para el arranque de la PWA). */
  @Public()
  @Get('session-hint')
  sessionHint(@Req() req: Request) {
    return { hasSessionCookie: Boolean(readCookie(req, REFRESH_COOKIE)) };
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user);
  }

  @Patch('me')
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.auth.updateProfile(user.userId, dto, meta);
  }

  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.auth.changePassword(user, dto, meta);
  }

  @Get('preferences')
  preferences(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.getPreferences(user.userId);
  }

  @Patch('preferences')
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePreferencesDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.auth.updatePreferences(user.userId, dto, meta);
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.listSessions(user.userId);
  }

  @Delete('sessions/:id')
  revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.auth.revokeSession(user.userId, id, meta);
  }

  @Get('devices')
  devices(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.listDevices(user.userId);
  }

  @Delete('devices/:deviceId')
  revokeDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('deviceId') deviceId: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.auth.revokeDevice(user.userId, deviceId, meta);
  }

  @Roles('OWNER', 'ADMIN')
  @Get('users')
  users(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.listUsers(user.userId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('users')
  createUser(
    @Body() dto: RegisterUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.auth.createUser(dto, user, meta);
  }

  /** Edita nombre, correo, rol o el permiso de entrar de otra persona. */
  @Roles('OWNER', 'ADMIN')
  @Patch('users/:id')
  updateUser(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.auth.updateUser(id, dto, user, meta);
  }

  /** Pone una contraseña nueva a otra persona (por si la olvida). */
  @Roles('OWNER', 'ADMIN')
  @Post('users/:id/password')
  setUserPassword(
    @Param('id') id: string,
    @Body() dto: SetUserPasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.auth.setUserPassword(id, dto.password, user, meta);
  }
}

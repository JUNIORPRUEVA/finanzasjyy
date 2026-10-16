import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, Public, Roles, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshTokenDto,
  RegisterUserDto,
  UpdatePreferencesDto,
  UpdateProfileDto,
} from './auth.dto.js';
import { AuthService } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** ¿Hace falta el onboarding inicial? Lo consulta la pantalla de acceso. */
  @Public()
  @Get('bootstrap-status')
  bootstrapStatus() {
    return this.auth.bootstrapStatus();
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto, @RequestMeta() meta: RequestMetaInfo) {
    return this.auth.login(dto, meta);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('register')
  register(@Body() dto: RegisterUserDto, @RequestMeta() meta: RequestMetaInfo) {
    return this.auth.registerFirstUser(dto, meta);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto, @RequestMeta() meta: RequestMetaInfo) {
    return this.auth.refresh(dto, meta);
  }

  @Post('logout')
  logout(@CurrentUser() user: AuthenticatedUser, @RequestMeta() meta: RequestMetaInfo) {
    return this.auth.logout(user, meta);
  }

  @Post('logout-all')
  logoutAll(@CurrentUser() user: AuthenticatedUser, @RequestMeta() meta: RequestMetaInfo) {
    return this.auth.logoutAll(user, meta);
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
  users() {
    return this.auth.listUsers();
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
}

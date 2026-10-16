import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface RequestMetaInfo {
  ip?: string;
  userAgent?: string;
  deviceId?: string;
  clientOperationId?: string;
}

/** Extrae metadatos de auditoría y de dispositivo de la petición. */
export const RequestMeta = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestMetaInfo => {
  const request = ctx.switchToHttp().getRequest<{
    headers?: Record<string, string | string[] | undefined>;
    ip?: string;
    socket?: { remoteAddress?: string };
  }>();

  const headerValue = (name: string): string | undefined => {
    const raw = request.headers?.[name];
    if (Array.isArray(raw)) {
      return raw[0];
    }
    return raw;
  };

  return {
    ip: request.ip ?? request.socket?.remoteAddress,
    userAgent: headerValue('user-agent'),
    deviceId: headerValue('x-device-id'),
    clientOperationId: headerValue('x-client-operation-id'),
  };
});

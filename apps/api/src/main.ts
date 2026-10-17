import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { SerializationInterceptor } from './common/serialization.interceptor.js';
import { buildCorsOptions } from './common/cors.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  if (!process.env.DATABASE_URL) {
    logger.error('Falta DATABASE_URL. Copie apps/api/.env.example a apps/api/.env y ajústelo.');
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug'],
  });

  app.setGlobalPrefix('api/v1');

  /*
   * Detrás de un proxy (nginx y el proxy de EasyPanel/Traefik) la dirección del
   * cliente NO es la del proxy. Sin esto, todos los usuarios compartirían la
   * misma «IP» y el límite de intentos de acceso (5 por minuto) los afectaría a
   * todos a la vez: bastaría que tres personas escribieran mal la contraseña
   * para bloquear a las demás.
   *
   * `1` significa «confía en el proxy inmediato» y toma la IP real de la cabecera
   * X-Forwarded-For. Se puede subir con TRUST_PROXY si hay más saltos.
   */
  const trustProxy = Number(process.env.TRUST_PROXY ?? 1);
  app.set('trust proxy', Number.isFinite(trustProxy) ? trustProxy : 1);

  // Cabeceras de seguridad. La CSP se relaja sólo para Swagger en desarrollo.
  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.enableCors(buildCorsOptions());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new SerializationInterceptor());
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3010);
  /*
   * En desarrollo se escucha sólo en local (nadie más de la red puede entrar).
   * Dentro de un contenedor hay que escuchar en 0.0.0.0 o nginx no puede
   * alcanzar la API: el contenedor arrancaría, el chequeo interno pasaría y la
   * web daría 502. Ese detalle se come una tarde, así que se resuelve aquí.
   */
  const host = process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  await app.listen(port, host);

  logger.log(`FINANZA API escuchando en http://${host}:${port}/api/v1`);
  logger.log(`Zona horaria de negocio: ${process.env.BUSINESS_TIMEZONE ?? 'America/Santo_Domingo'}`);
  logger.log(`Ventana offline: ${process.env.OFFLINE_WINDOW_HOURS ?? 24} horas`);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('No se pudo arrancar FINANZA API:', error);
  process.exit(1);
});

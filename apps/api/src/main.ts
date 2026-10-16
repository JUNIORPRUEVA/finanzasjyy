import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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

  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug'],
  });

  app.setGlobalPrefix('api/v1');

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
  const host = process.env.HOST ?? '127.0.0.1';
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

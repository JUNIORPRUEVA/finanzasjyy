# FINANZA API — imagen de producción
# Multi-etapa: se compila con las dependencias completas y la imagen final sólo
# lleva lo necesario para ejecutar.
#
# Nota: el esquema de Prisma se aplica con `prisma migrate deploy` al arrancar,
# para que un despliegue nuevo no quede con la base de datos sin actualizar.
# NUNCA se ejecuta `migrate reset` en esta imagen.

FROM node:24-alpine AS build
WORKDIR /app

# openssl lo necesita Prisma para detectar la versión de la plataforma.
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

# Sólo dependencias de producción para la imagen final.
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3010
ENV TZ=America/Santo_Domingo

RUN apk add --no-cache openssl tzdata curl \
  && cp /usr/share/zoneinfo/America/Santo_Domingo /etc/localtime

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/package.json ./package.json

# El usuario no root reduce el daño en caso de compromiso del proceso.
RUN addgroup -S finanza && adduser -S finanza -G finanza && chown -R finanza:finanza /app
USER finanza

EXPOSE 3010

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3010/api/v1/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/scripts/seed-structure.js && node dist/main.js"]

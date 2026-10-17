# FINANZA PWA — imagen de producción (build + nginx)
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# URL relativa: nginx hace de proxy hacia la API, así no hay CORS ni URLs
# incrustadas en el paquete compilado.
ENV VITE_API_URL=/api/v1
RUN npm run build

FROM nginx:1.29-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html

# La configuración es una PLANTILLA: la imagen oficial de nginx la procesa al
# arrancar y sustituye ${API_UPSTREAM} por la dirección de la API. Por defecto
# apunta al servicio «api» de la pila completa; en un despliegue de dos servicios
# separados se cambia con una variable de entorno, sin recompilar nada.
COPY nginx.template.conf /etc/nginx/templates/default.conf.template
ENV API_UPSTREAM=http://api:3010
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]

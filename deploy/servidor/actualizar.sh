#!/bin/bash
# Actualiza FINANZA en el servidor: baja el último código, reconstruye las dos
# imágenes y actualiza los servicios sin cortar el acceso.
#
# Uso (en el servidor, como root):
#   bash deploy/servidor/actualizar.sh
#
# Qué garantiza:
#   · La API aplica las migraciones nuevas al arrancar (`prisma migrate deploy`).
#   · Nunca se ejecuta `migrate reset` ni se borra ningún dato.
#   · Si la construcción falla, los servicios actuales siguen funcionando (se
#     construye ANTES de tocar nada).
#   · El cambio es reversible con `docker service rollback <servicio>`.
#
# Variables opcionales:
#   RAMA=master            rama a desplegar
#   SIN_RED=1              no reconstruye (sólo reinicia los servicios)
set -u

REPO="${REPO:-https://github.com/JUNIORPRUEVA/finanzasjyy.git}"
RAMA="${RAMA:-master}"
DIR="${DIR:-/tmp/finanza-deploy}"
IMG_API="easypanel/ventas/finanzapersonales:latest"
IMG_WEB="easypanel/ventas/finanzaspersonalespwa:latest"
SVC_API="ventas_finanzapersonales"
SVC_WEB="ventas_finanzaspersonalespwa"
DOM="${DOM:-ventas-finanzaspersonalespwa.gcdndd.easypanel.host}"

fallo() { echo "ERROR: $*" >&2; exit 1; }

echo "== 1/5  Código =="
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$RAMA" >/dev/null 2>&1 || fallo "no puedo contactar con GitHub"
  git -C "$DIR" reset --hard "origin/$RAMA" >/dev/null || fallo "no puedo actualizar el código"
else
  rm -rf "$DIR"
  git clone --depth 1 --branch "$RAMA" "$REPO" "$DIR" || fallo "no puedo clonar el repositorio"
fi
echo "   versión: $(git -C "$DIR" log --oneline -1)"

if [ "${SIN_RED:-0}" != "1" ]; then
  echo "== 2/5  Imagen de la API =="
  docker build -f "$DIR/Dockerfile.api" -t "$IMG_API" "$DIR" > /tmp/finanza-build-api.log 2>&1 \
    || { tail -25 /tmp/finanza-build-api.log; fallo "la imagen de la API no se construyó"; }
  echo "   ok ($(docker images --format '{{.Size}}' "$IMG_API" | head -1))"

  echo "== 3/5  Imagen de la web =="
  docker build -f "$DIR/Dockerfile.web" -t "$IMG_WEB" "$DIR" > /tmp/finanza-build-web.log 2>&1 \
    || { tail -25 /tmp/finanza-build-web.log; fallo "la imagen de la web no se construyó"; }
  echo "   ok ($(docker images --format '{{.Size}}' "$IMG_WEB" | head -1))"
else
  echo "== 2-3/5  Construcción omitida (SIN_RED=1) =="
fi

echo "== 4/5  Actualizando servicios =="
for PAR in "$SVC_API|$IMG_API" "$SVC_WEB|$IMG_WEB"; do
  SVC="${PAR%%|*}"; IMG="${PAR##*|}"
  docker service update \
    --force --no-resolve-image --image "$IMG" \
    --update-order start-first --update-delay 5s \
    "$SVC" 2>&1 | grep -viE 'overall progress|verify: Waiting' | tail -3
  for i in $(seq 1 30); do
    ESTADO=$(docker service ps "$SVC" --filter desired-state=running --format '{{.CurrentState}}' 2>/dev/null | head -1)
    case "$ESTADO" in Running*) break ;; esac
    sleep 4
  done
  echo "   $SVC -> ${ESTADO:-?}"
done

echo "== 5/5  Comprobación =="
sleep 4
printf '   portada: '
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' --max-time 20 "https://$DOM/" || echo "sin respuesta"
printf '   salud  : '
curl -sS --max-time 20 "https://$DOM/api/v1/health" || echo "sin respuesta"
echo
echo "   Si algo va mal:  docker service rollback $SVC_API && docker service rollback $SVC_WEB"

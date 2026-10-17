# Desplegar FINANZA en EasyPanel

Guía para dejar FINANZA funcionando en su servidor con **HTTPS y base de datos propia**,
subiendo el código desde GitHub. Está pensada para hacerlo a mano, con calma, en unos 15 minutos.

> **Estado actual: YA ESTÁ DESPLEGADO Y FUNCIONANDO** (17/10/2026).
>
> | | |
> | --- | --- |
> | Dirección | **https://ventas-finanzaspersonalespwa.gcdndd.easypanel.host** |
> | Certificado | Let's Encrypt, válido y renovándose solo |
> | Base de datos | la suya del panel (`ventas_studio-db`, base `finanza`), con las 31 tablas creadas |
> | Acceso | usuario propietario ya creado; la contraseña temporal está en el servidor, en `/root/finanza-acceso.txt` |
>
> Lo que sigue queda como referencia por si algún día hay que rehacerlo desde cero, y para explicar
> **cómo actualizar** el sistema a partir de ahora (sección 6). El detalle exacto de lo que hay en el
> servidor está en la **sección 10**.
| Cosa | Estado |
| --- | --- |
| Código en GitHub | ✅ ya está en `https://github.com/JUNIORPRUEVA/finanzasjyy` (rama `master`) |
| Servidor con EasyPanel | Lo tiene usted |
| Un nombre de dominio o subdominio | Recomendado. Sin él, EasyPanel puede dar un dominio gratuito `*.easypanel.host` |

El despliegue levanta **tres contenedores**:

| Servicio | Qué es | Puerto |
| --- | --- | --- |
| `web` | La aplicación (PWA) servida por nginx. **Es el único que se publica.** | 80 → se publica como **3000** |
| `api` | La API de FINANZA | 3010 (sólo interno) |
| `db` | PostgreSQL 16 con su volumen | 5432 (sólo interno) |

nginx hace de portero: todo lo que empieza por `/api` lo manda a la API. Así la web y la API comparten
dominio y **no hay problemas de CORS ni de cookies**.

---

## 1. Crear la base de datos (dos opciones)

### Opción B — usar su PostgreSQL del panel: **ya está hecha en su servidor**

En el servidor `31.97.99.70` (EasyPanel, proyecto `ventas`) **la base ya está creada y probada**:

| Dato | Valor |
| --- | --- |
| Servicio PostgreSQL | `ventas_studio-db` (imagen `postgres:17`, el que usted llama «studio») |
| Host interno (verificado) | **`ventas_studio-db`** |
| Puerto | `5432` |
| Base de datos | **`finanza`** |
| Usuario | **`finanza_user`** |
| Contraseña | En el servidor: `/root/finanza-db-credentials.txt` (permisos `600`, sólo root) |

La cadena que hay que pegar en `DATABASE_URL` es:

```
postgresql://finanza_user:LA_CLAVE@ventas_studio-db:5432/finanza?schema=public
```

Para ver la clave (queda fuera de este documento a propósito):

```ssh
ssh -i SU_CLAVE root@31.97.99.70 "cat /root/finanza-db-credentials.txt"
```

Comprobaciones hechas sobre esa base, no supuestas: el usuario conecta, escribe y borra una tabla; la
base está vacía (0 tablas, el esquema lo creará la API al desplegar) y pertenece a `finanza_user`.
Si elige esta opción, en el paso 2 use **`docker-compose.produccion.base-existente.yml`** y **no** ponga
las variables `FINANZA_DB_*`.

### Opción A — que FINANZA traiga su propia base (servidor nuevo o proyecto aparte)

No haga nada en este paso: el archivo `docker-compose.produccion.yml` ya incluye el contenedor
`db` con su volumen. Los datos quedan en `finanzasjyy_pgdata`.

---

## 2. Crear el servicio en EasyPanel

1. Entre en su proyecto (o cree uno nuevo, p. ej. **finanzasjyy**).
2. **+ Create service** → **Docker Compose** (aparece como *Stack*).
3. Rellene:

   | Campo | Valor |
   | --- | --- |
   | Name | `finanza` |
   | Source | **GitHub** → autorice y elija `JUNIORPRUEVA/finanzasjyy` |
   | Branch | `master` |
   | Docker Compose file | `docker-compose.produccion.yml` (Opción A) o `docker-compose.produccion.base-existente.yml` (Opción B) |

4. **Environment** (pestaña de variables). Pegue y rellene esto:

   ```env
   # Opción A (base incluida)
   FINANZA_DB_USER=finanza_app
   FINANZA_DB_PASSWORD=una-clave-larga-y-unica
   FINANZA_DB_NAME=finanza

   # Opción B: en lugar de las tres de arriba, una sola:
   # DATABASE_URL=postgresql://finanza_app:CLAVE@EL_HOST_INTERNO:5432/finanza?schema=public

   JWT_ACCESS_SECRET=<genérelo abajo>
   JWT_REFRESH_SECRET=<genérelo abajo>

   CORS_ORIGINS=https://EL-DOMINIO-QUE-VAYA-A-USAR
   COOKIE_SAMESITE=lax
   TRUST_PROXY=1
   OFFLINE_WINDOW_HOURS=24
   SESSION_MAX_HOURS=720
   SESSION_IDLE_HOURS=168
   ```

   Para generar los dos secretos, en su ordenador:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

   Ejecútelo **dos veces** (uno para cada secreto) y pegue cada resultado. No los reutilice de otro
   proyecto.

5. **Deploy**. En los registros verá, en este orden:
   - `db`: `database system is ready to accept connections`
   - `api`: `Aplicando migraciones…` y luego `FINANZA API escuchando en http://0.0.0.0:3010/api/v1`
   - `web`: nginx arrancando.

### 2-bis. Alternativa: dos servicios «App» en vez de un Compose

Si prefiere (o si ya empezó por aquí) crear **dos servicios de tipo *App*** —uno para la API y otro para
la web—, el campo que suele atascar a todo el mundo es **«Ruta de compilación»**. El repositorio es un
monorepo (`apps/api`, `apps/web`) y ese campo **no** espera `api` ni `apps/api`: espera la raíz.

Para que no haya nada que adivinar, en la raíz del repositorio hay dos Dockerfiles hechos a propósito:

| Servicio | Ruta de compilación | Archivo (Dockerfile) | Puerto interno |
| --- | --- | --- | --- |
| API | `/` (la raíz, sin escribir nada) | `Dockerfile.api` | `3010` |
| Web | `/` (la raíz, sin escribir nada) | `Dockerfile.web` | `80` |

> **Por qué fallaba:** si en «Ruta de compilación» se escribe `api`, EasyPanel busca
> `<repositorio>/api` —que no existe— y el registro dice
> `unable to prepare context: path ".../code/api" not found`. Dejándolo vacío o `/`, el contexto es la
> raíz del repositorio y basta con indicar el Dockerfile de la tabla.

En el servicio **web**, además, hay que decirle a nginx dónde está la API (los dos servicios son
contenedores separados, así que `http://api:3010` no existe):

```env
API_UPSTREAM=http://EL-NOMBRE-INTERNO-DEL-SERVICIO-DE-LA-API:3010
```

Ese nombre interno es el que muestre EasyPanel en el servicio de la API (p. ej.
`ventas_finanzapersonales`). El **dominio** se pone sólo en el servicio **web**, apuntando a su puerto
`80`; la API no necesita dominio propio porque la web le pasa `/api` por dentro.

En la API, las variables son las de la tabla del paso 4 (`DATABASE_URL`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `CORS_ORIGINS`…) más `PORT=3010`.

> **Recomendación:** si no tiene una razón concreta para lo contrario, use la vía **Docker Compose** del
> paso 2. Ya está probada de punta a punta (imágenes construidas, pila levantada y `/api/v1/health`
> respondiendo a través de nginx) y no necesita conectar los dos servicios a mano.

   Si `api` se reinicia en bucle, casi siempre es `DATABASE_URL` mal escrita (revise el usuario, la
   contraseña y el `?schema=public`).

---

## 3. Dominio y HTTPS

1. En el servicio, pestaña **Domains** → **Add domain**.
2. Escriba su dominio (p. ej. `finanzas.sudominio.com`) y **asocie el puerto 3000** del servicio `web`.
3. Active **HTTPS** (Let's Encrypt). EasyPanel crea el certificado solo.
4. En su proveedor de DNS, apunte ese subdominio a la IP del servidor (registro `A`), si no lo ha
   hecho ya.
5. Vuelva a **Environment** y confirme que `CORS_ORIGINS` es **exactamente** su dominio con `https://`
   y **sin** barra final. Si no coincide, el navegador bloqueará el acceso (y el registro dirá
   «blocked by CORS policy»).

---

## 4. Primera puesta en marcha (crear su usuario)

La aplicación arranca **sin ningún dato**: ni saldos, ni movimientos, ni cifras de ejemplo. Lo primero
es crear la estructura contable y su usuario.

1. Abra `https://SU-DOMINIO/`.
2. Como la base está vacía, la pantalla mostrará **«Primer uso»**: escriba su nombre, correo y
   contraseña, y pulse **Crear usuario propietario**.
3. Entre. La app le pedirá **«Organizar mi dinero»**: es el asistente para decir cuánto dinero hay y de
   quién es. Sin eso no puede calcular nada (y no lo inventa).

> Si prefiere crearlo desde la terminal del panel (servicio `api` → **Console**):
> ```sh
> npm run db:seed
> ```
> Eso crea el catálogo contable (72 cuentas), las 32 categorías, las 4 unidades (FULLTECH,
> PHYTOEMAGRY, FULLPOS CLOUD y FINANZAS PERSONALES) y el usuario indicado en
> `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`. **No** crea importes.

---

## 5. Comprobaciones después de desplegar (2 minutos)

| Comprobación | Cómo | Debe dar |
| --- | --- | --- |
| La API vive | Abra `https://SU-DOMINIO/api/v1/health` | `{"status":"ok"}` |
| La app carga | Abra `https://SU-DOMINIO/` | Pantalla de acceso o el panel |
| El login funciona | Entre con su usuario | Panel con «¿Dónde está mi dinero?» |
| La sesión aguanta | Recargue la página | Sigue dentro, sin pedir contraseña |
| La base responde | `api` → Console → `npx prisma migrate status` | `Database schema is up to date!` |
| Sin errores de CORS | F12 → Console, al entrar | Ningún «blocked by CORS policy» |

---

## 6. Actualizar la aplicación más adelante

1. Suba los cambios a GitHub (`git push`).
2. En EasyPanel: servicio → **Deploy** (o active *Auto Deploy* en el servicio).
3. Al arrancar, la API aplica las migraciones nuevas sola. **Nunca** se ejecuta `migrate reset` en el
   servidor: no se borran datos.

---

## 7. Copias de seguridad (no se salte esto)

**Opción A (base incluida en la pila):**

```sh
# desde la consola del servicio «db»
pg_dump -U finanza_app -d finanza -Fc -f /tmp/finanza.dump
```

**Opción B (base en su servicio PostgreSQL del panel):** use el botón de copia del propio servicio
PostgreSQL de EasyPanel (pestaña **Backups**), o `pg_dump` desde su consola con la misma cadena.

Guarde además una copia fuera del servidor. Un respaldo que sólo vive en el mismo disco no es un
respaldo.

---

## 8. Problemas típicos y qué significan

| Síntoma | Causa casi segura | Solución |
| --- | --- | --- |
| `api` en bucle de reinicio | `DATABASE_URL` mal formada | Revise usuario, contraseña, host interno y `?schema=public` |
| La web carga pero dice «No se puede contactar con el servidor» | La API está caída o nginx no la alcanza | Mire los registros de `api`; compruebe que escucha en `0.0.0.0` |
| «blocked by CORS policy» al iniciar sesión | `CORS_ORIGINS` no coincide con el dominio | Póngalo idéntico, con `https://` y sin `/` final; redespliegue |
| Todo funciona pero no entra nadie | Faltan `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Rellénelos y redespliegue |
| «La tabla X no existe» | Nunca se aplicaron las migraciones | Console del servicio `api`: `npx prisma migrate deploy` |
| La app se queda con la versión anterior | El service worker del navegador | Cierre la app del todo y vuelva a abrirla, o `Ctrl+Shift+R` |

---

## 9. Lo que queda fuera de esta guía (y hay que decidir)

- **Nombre de dominio definitivo.** Hasta que lo tenga, use el `*.easypanel.host` que da el panel y
  ponga ese valor en `CORS_ORIGINS`.
- **Notificaciones push.** Opcionales: si deja `VAPID_PUBLIC_KEY` vacío, la app lo dice y no envía
  nada. Se generan con `npx web-push generate-vapid-keys`.
- **Autenticación en dos pasos.** No está implementada (ver `docs/FUNCIONALIDADES.md`).
- **Copias automáticas.** EasyPanel las ofrece por servicio; actívelas y pruébelas.

---

## 10. Lo que hay realmente en el servidor (17/10/2026)

Esta sección no es teoría: es el estado comprobado del servidor `31.97.99.70`.

### Servicios

| Servicio (Swarm) | Qué es | Puerto interno | Dominio asignado |
| --- | --- | --- | --- |
| `ventas_finanzaspersonalespwa` | La aplicación, servida por nginx | `80` | **https://ventas-finanzaspersonalespwa.gcdndd.easypanel.host** |
| `ventas_finanzapersonales` | La API | `3010` | `ventas-finanzapersonales.gcdndd.easypanel.host` (no hace falta usarlo: la web le pasa `/api` por dentro) |
| `ventas_studio-db` | Su PostgreSQL (ya existía; no se ha tocado) | `5432` | — |

Los nombres son **los que el panel ya esperaba** en su configuración de dominios. Por eso el enrutado
funciona sin tocar Traefik: nginx reenvía `/api` a `http://ventas_finanzapersonales:3010`.

### Dónde está cada cosa en el servidor

| Ruta | Qué contiene | Permisos |
| --- | --- | --- |
| `/root/finanza-api.env` | Variables de la API (incluidos los dos secretos JWT y la `DATABASE_URL`) | `600` |
| `/root/finanza-db-credentials.txt` | Usuario y contraseña de la base `finanza` | `600` |
| `/root/finanza-acceso.txt` | Dirección, correo y contraseña **temporal** del propietario | `600` |

Nada de eso se ha subido al repositorio, y ninguna de esas claves se ha escrito en este documento.

### Cómo se actualiza (a partir de ahora)

```sh
# en el servidor, como root
bash /ruta/al/repo/deploy/servidor/actualizar.sh
```

El script baja el último `master`, reconstruye las dos imágenes y actualiza los servicios sin
cortar el servicio (orden «start-first»). La API aplica las migraciones nuevas al arrancar.

A mano, el equivalente es:

```sh
git -C /tmp/finanza-deploy pull --ff-only origin master
docker build -f /tmp/finanza-deploy/Dockerfile.api -t easypanel/ventas/finanzapersonales:latest /tmp/finanza-deploy
docker build -f /tmp/finanza-deploy/Dockerfile.web -t easypanel/ventas/finanzaspersonalespwa:latest /tmp/finanza-deploy
docker service update --force --no-resolve-image --image easypanel/ventas/finanzapersonales:latest ventas_finanzapersonales
docker service update --force --no-resolve-image --image easypanel/ventas/finanzaspersonalespwa:latest ventas_finanzaspersonalespwa
```

> **Importante:** estos dos servicios se crearon desde la terminal, **no** desde EasyPanel. Se ven y se
> reinician con `docker service ...`, pero el panel no los lista. Si algún día quiere que el panel los
> gestione, use la vía **Docker Compose** del paso 2 en un servicio nuevo y, cuando esté arriba,
> `docker service rm ventas_finanzapersonales ventas_finanzaspersonalespwa`.
> **No** pulse *Deploy* en los dos servicios de tipo *App* que quedaron sin desplegar: siguen con la
> ruta de compilación equivocada y volverán a fallar (sin afectar a lo que ya funciona).

### Para volver atrás

```sh
docker service rollback ventas_finanzapersonales
docker service rollback ventas_finanzaspersonalespwa
```

Swarm guarda la versión anterior de cada servicio, así que esto devuelve la imagen previa en segundos.
La base de datos **no** se revierte sola: si una migración nueva cambió el esquema, haga la copia de
seguridad antes de actualizar (sección 7).

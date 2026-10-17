# Desplegar FINANZA en EasyPanel

Guía para dejar FINANZA funcionando en su servidor con **HTTPS y base de datos propia**,
subiendo el código desde GitHub. Está pensada para hacerlo a mano, con calma, en unos 15 minutos.

> **Lo que yo no puedo hacer desde aquí:** entrar en su servidor. No tengo acceso a EasyPanel ni a su
> base de datos, y no voy a pedirle contraseñas por el chat. Todo lo que sigue lo ejecuta usted; cada
> paso dice exactamente qué debe escribir y qué debe ver si salió bien.

---

## 0. Lo que hace falta antes de empezar

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

### Opción A — que FINANZA traiga su propia base (lo más simple)

No haga nada en este paso: el archivo `docker-compose.produccion.yml` ya incluye el contenedor
`db` con su volumen. Los datos quedan en `finanzasjyy_pgdata`.

### Opción B — usar su PostgreSQL del panel (por ejemplo el servicio «studio»)

1. En EasyPanel, abra su servicio de PostgreSQL (el que llama **studio**).
2. Pestaña **Databases** → **Create database**:
   - Nombre: `finanza`
3. Pestaña **Users** (o «Credentials») → cree un usuario:
   - Usuario: `finanza_app`
   - Contraseña: una larga (30+ caracteres). **Apúntela**, la necesitará en el paso 2.
4. En la pestaña **General** de ese servicio verá el **host interno** (algo como
   `studio_finanzasjyy` o `studio_nombreproyecto`). Anótelo.
5. Su cadena de conexión será:

   ```
   postgresql://finanza_app:LA_CONTRASEÑA@EL_HOST_INTERNO:5432/finanza?schema=public
   ```

   > Ojo: el `?schema=public` del final es obligatorio. Sin él, Prisma busca las tablas en otro sitio y
   > el despliegue falla con «la tabla no existe».

Si elige esta opción, en el paso 2 usará `docker-compose.produccion.base-existente.yml` en vez
del normal.

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

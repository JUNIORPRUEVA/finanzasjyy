# SEGURIDAD DE FINANZA

## 1. Principio general

FINANZA maneja dinero y datos de cuatro negocios. Las decisiones de seguridad van en una dirección:
**preferir no hacer algo antes que hacerlo de forma insegura**. De ahí que no haya integraciones con
otros sistemas, ni claves en el repositorio, ni nada publicado en internet.

---

## 2. Contraseñas

| Aspecto | Decisión |
| --- | --- |
| Algoritmo | **Argon2id** |
| Parámetros | Memoria, iteraciones y paralelismo dimensionados para un servidor pequeño; se ajustan en `password.ts` |
| Sal | Única por contraseña (la genera la biblioteca) |
| Longitud mínima | 10 caracteres, con letras y números |
| En la semilla | Se genera aleatoriamente y se muestra **una sola vez** |
| En registros | Nunca se escribe una contraseña en el log (ni en claro, ni en hash) |

No existe ninguna contraseña por defecto conocida. Si la semilla genera una, la imprime en la consola
de tu máquina y no la guarda en ningún sitio.

---

## 3. Sesiones y tokens

- **Token de acceso** de vida corta, enviado en la cabecera `Authorization: Bearer`. **Vive sólo en
  memoria** en la PWA: no toca `localStorage` ni IndexedDB, así que un fallo de XSS no se lleva una
  sesión.
- **Token de refresco** rotado: al usarlo se emite uno nuevo y el anterior deja de valer.
  En la base de datos se guarda **sólo su hash** (`refreshTokenHash`), no el token.
- El token de refresco viaja en una **cookie `HttpOnly`** (`finanza_rt`, con `Path=/api/v1/auth`):
  `document.cookie` no puede leerla. Lleva `Secure` cuando hay HTTPS y `SameSite=Lax` por defecto
  (configurable con `COOKIE_SAMESITE`).
- **Antifalsificación (CSRF) por doble envío**: una cookie legible `finanza_csrf` y la misma marca en
  la cabecera `X-CSRF-Token`. Sin coincidencia, la renovación se rechaza. Sólo se exige cuando el
  token viene de la cookie, no cuando se envía en el cuerpo (clientes antiguos).
- Cada sesión está ligada a un **dispositivo** (`X-Device-Id`), con IP y agente de usuario
  registrados, visibles y revocables uno a uno desde Ajustes → Seguridad.
- **Una sesión robada se detecta:** si se presenta un token de refresco ya revocado, se cierran
  **todas** las sesiones del usuario y queda registrado en la auditoría (`SESSION_REUSE_DETECTED`).
- Caducidad por **inactividad** (`SESSION_IDLE_HOURS`, 168 h por defecto) y **duración máxima**
  (`SESSION_MAX_HOURS`, 720 h): al superarlas, la sesión se revoca con su motivo.
- Cambiar la contraseña **cierra las demás sesiones**.
- La sesión guarda `offlineAllowedUntil`: hasta cuándo se permite registrar sin conexión.
- **Fallar no es cerrar sesión.** Ni un 401 sin código, ni un 403, ni un 500, ni un 502/503, ni un
  tiempo agotado, ni un corte de red cierran la sesión: sólo los códigos explícitos `SESSION_*`.
  Si un mal minuto del servidor bastara para expulsar al usuario, la contraseña acabaría escrita en
  sitios peores.

**Los tokens no se guardan en IndexedDB.** La caché local de la PWA contiene operaciones pendientes y
datos de lectura (cuentas y categorías confirmadas por el servidor), pero nunca credenciales.

**Límites de intentos:** 5 accesos por minuto y 60 renovaciones por minuto. Existen las variables de
**proceso** `E2E_AUTH_LOGIN_LIMIT` y `E2E_AUTH_REFRESH_LIMIT` para las pruebas de navegador (que
abren muchos navegadores seguidos). No son variables del archivo `.env`, de modo que la aplicación
real siempre usa 5 y 60. Está explicado en `auth.controller.ts`.

---

## 4. Aislamiento entre unidades financieras

El sistema es multiusuario y multiunidad desde el diseño, no como añadido.

- `EntityMember` relaciona usuario y unidad, con papel `OWNER`, `ADMIN`, `OPERATOR` o `VIEWER`.
- `AccessService.assertCanRead/Write/Administer` se ejecuta **antes** de cada operación.
- `AccessService.resolveScope` determina qué unidades puede ver el usuario; las consultas se filtran
  por ese ámbito.
- Pedir datos de una unidad sin permiso devuelve **403**, aunque se conozca el identificador.

Está cubierto por una prueba e2e que inicia sesión con dos usuarios distintos e intenta leer datos
ajenos.

---

## 5. Integridad de los datos como defensa

La seguridad no es sólo «quién entra», también «qué se puede estropear»:

- **Triggers de base de datos** impiden descuadrar un asiento, modificar un movimiento confirmado o
  borrar un registro contable. Ni con SQL directo.
- **Idempotencia** por `clientOperationId` único: un reintento no duplica un cobro.
- **Transacciones Serializable** con reintentos: dos operaciones simultáneas no producen un estado
  intermedio incoherente.
- **Auditoría** (`AuditLog`) de acciones sensibles: quién, qué, cuándo, desde qué dispositivo.

---

## 6. Superficie de red

| Aspecto | Configuración |
| --- | --- |
| PostgreSQL | Publicado **sólo** en `127.0.0.1:55432` (no accesible desde la red local) |
| API | Escucha en local; pensada para publicarse detrás de un proxy con TLS |
| CORS | Restringido al origen configurado de la PWA |
| Límite de peticiones | Global y más estricto en inicio de sesión y registro |
| Cabeceras | `helmet` (nosniff, frame-deny, referrer-policy y demás) |
| Tamaño de cuerpo | Limitado; los adjuntos también |
| Logs | Sin contraseñas, sin tokens, sin cuerpos de petición sensibles |

---

## 7. Secretos

- Se generan con el generador criptográfico de Node (`scripts/bootstrap-dev.ps1`), no con `Math.random`.
- Viven en `.env` (raíz y `apps/api/.env`), **ignorados por Git**.
- `scripts/sync-env.ps1` los propaga entre archivos sin imprimirlos por pantalla.
- `.env.example` documenta todas las variables **sin valores reales**.
- Los scripts de copia de seguridad leen las credenciales del `.env` y no las muestran.

**Nada de esto se ha publicado en ningún sitio.** No hay secretos versionados ni compartidos.

---

## 8. Dispositivos perdidos

1. Ajustes → Seguridad → cerrar esa sesión.
2. Cerrar **todas** las sesiones (`logout-all`) e invalidar el dispositivo.
3. Si el dispositivo tenía la aplicación instalada, la ventana de trabajo sin conexión es de 24 h:
   pasado ese plazo, no podrá registrar nada sin validar sesión.
4. Los datos locales del dispositivo (cola de operaciones y caché) se pueden borrar desde el propio
   navegador; no contienen credenciales.

---

## 9. Copias de seguridad

- `scripts/backup-db.ps1` genera un volcado comprimido con `pg_dump` **dentro** del contenedor.
- `scripts/restore-test.ps1` **restaura en una base de datos aparte** (`finanza_restore_test`),
  comprueba que los asientos cuadran y la elimina al terminar. Nunca restaura sobre la base de trabajo.
- Las copias se guardan en `backups/`, fuera del control de versiones.

Una copia que nunca se ha restaurado no es una copia: por eso el script de restauración es parte
del procedimiento, no un extra.

---

## 10. Lo que NO se ha hecho (y conviene saber)

| Punto | Estado |
| --- | --- |
| Despliegue en internet con HTTPS | **No hecho.** Sin TLS real no hay garantía frente a un atacante en la red |
| Cifrado de la base de datos en reposo | No configurado (depende del disco del sistema) |
| Cifrado de los adjuntos en disco | No: se guardan tal cual en la carpeta de datos local |
| Autenticación en dos pasos | No implementada |
| Copias de seguridad automáticas programadas | No: hay script, no tarea programada |
| Auditoría externa de seguridad | No realizada |
| Pruebas de penetración | No realizadas |

Estas ausencias no son secretos: están aquí para que quien decida desplegar en producción sepa
exactamente qué le falta antes de exponerlo a internet.

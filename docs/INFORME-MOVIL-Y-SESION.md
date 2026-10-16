# INFORME — Diseño móvil y sesión persistente

**Fecha:** 16 de octubre de 2026
**Alcance:** rediseño móvil completo de la PWA de FINANZA y persistencia real de la sesión.
**Estado:** **GO** para el uso diario previsto (uso personal y de sus negocios).

> Este informe está escrito para que se pueda comprobar, no para que se pueda leer por encima.
> Cuando algo NO se ha probado, se dice. Cuando algo se ha detectado a medias, también.

---

## 1. Qué pedía la misión

1. Que la aplicación se sienta como una aplicación nativa de finanzas, no como una web adaptada.
2. **Que no haya que iniciar sesión cada vez que se cierra y se vuelve a abrir.**
3. Que la sesión viva en cookies `HttpOnly`/`Secure` y que ni un corte del servidor ni un
   error 502/503 se interpreten como «credenciales inválidas».
4. Pantalla de acceso nueva y profesional.
5. Diseño móvil de 320 a 768 px, con área segura (notch y barra de gestos).
6. Barra inferior permanente con cinco accesos y acción central «Añadir».
7. Revisión de TODAS las pantallas, biblioteca de componentes reutilizable, carga diferida.
8. Pruebas de sesión y pruebas en navegador con capturas.
9. No romper el libro mayor ni la lógica financiera.

---

## 2. La avería de fondo (por qué tenía que iniciar sesión cada vez)

No era un problema de diseño: era un fallo de lógica en el cliente.

- `tryRefreshSession()` **borraba el token de refresco ante CUALQUIER respuesta que no fuera
  correcta**: un 503, un 502, un corte de red o un tiempo de espera agotado equivalían, para el
  código, a «tu sesión ya no sirve». El token se destruía en el dispositivo.
- Al arrancar, la aplicación exigía tener un token de acceso en `localStorage`. Como el token
  vivía también en `localStorage` (a merced de cualquier script), cualquier fallo previo dejaba
  la aplicación sin sesión y pedía la contraseña otra vez.

**Resultado:** si el servidor tenía un mal minuto, el usuario pagaba con su contraseña.

Además, guardar el token de refresco en `localStorage` era un riesgo de seguridad real: un fallo
de XSS se llevaba una sesión de 30 días.

---

## 3. Cómo funciona ahora la sesión

| Pieza                     | Dónde vive ahora                                        | Por qué                                             |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| Token de acceso           | **Sólo en memoria**                                     | Se pierde al recargar, se recupera solo. No lo ve un script ajeno. |
| Token de refresco         | **Cookie `HttpOnly`** (`finanza_rt`, ruta `/api/v1/auth`) | Ni siquiera `document.cookie` puede leerla.          |
| Antifalsificación (CSRF)  | Cookie legible `finanza_csrf` + cabecera `X-CSRF-Token` | Doble envío: sin la cabecera, la renovación se rechaza. |
| Aviso de sesión           | Cookie `finanza_sesion`                                 | Saber si merece la pena intentar recuperar la sesión. |

Reglas de decisión del cliente (esto es el corazón del arreglo):

| Lo que pasa                                   | Qué hace FINANZA                                    |
| --------------------------------------------- | --------------------------------------------------- |
| El servidor responde 401 en una petición       | Renueva la sesión y **repite** la petición (una vez). |
| Varias peticiones fallan a la vez              | **Una sola** renovación (si no, se invalidarían entre ellas). |
| Sin red, tiempo agotado, 500, 502, 503 o 429   | **NO se cierra la sesión.** Se entra en modo sin conexión y se reintenta. |
| El servidor dice `SESSION_EXPIRED`             | Se cierra la sesión y **se explica el motivo** en la pantalla de acceso. |
| El servidor dice `SESSION_REVOKED`             | Igual, con su motivo (por ejemplo: cerrada desde otro dispositivo). |
| `SESSION_IDLE_TIMEOUT` (168 h sin usarla)      | Igual, indicando que fue por inactividad.            |
| `SESSION_MAX_LIFETIME` (720 h de duración)     | Igual, indicando que se alcanzó la duración máxima.  |
| `SESSION_REUSE_DETECTED` (token robado)        | Se cierran **todas** las sesiones del usuario y se exige identificarse. |

Los códigos son de máquina (`SESSION_*`). Cualquier otra cosa —un 401 sin código, un 403, un
5xx, un tiempo de espera— **no** cierra la sesión.

---

## 4. Qué se ha cambiado, en concreto

### Colores y aspecto

- Un solo sistema de diseño en `src/index.css`: nombres con significado (`surface`, `ink`,
  `muted`, `brand`, `positive`, `negative`, `warning`…) en lugar de colores sueltos.
- **Modo oscuro y modo claro** desde el mismo código.
- Se eliminaron **292 usos** de la paleta antigua (`slate`, `emerald`, `rose`, `amber`) en 15
  pantallas: eran colores fijos que en modo claro dejaban texto ilegible.

### Componentes (`src/components/ui.tsx`, `icons.tsx`, `Toast.tsx`)

Conjunto único y reutilizable: superficies, títulos de sección, filas de lista, importes
(`Money` y `AmountDisplay` con cifras tabulares), etiquetas de estado, botones (con área táctil
mínima de 44 px), campos con 16 px de letra (por debajo de eso, el móvil hace zoom al enfocar),
campo de importe con teclado numérico, esqueletos de carga, estados vacíos y de error, avisos,
pestañas, hojas inferiores, diálogos de confirmación y avisos breves (`toast`).

### Estructura (`AppShell.tsx`)

- Cabecera compacta: unidad financiera activa (se cambia en una hoja inferior), estado de la
  sesión, avisos de «sin conexión» y contador de operaciones sin confirmar.
- Barra inferior permanente con **Inicio, Movimientos, Añadir (botón central), Control, Más**.
- «Añadir» abre una hoja con las acciones diarias: Ingreso, Gasto, Traspaso, Compromiso,
  Cierre del día y Deuda o cuota.
- Área segura respetada: `env(safe-area-inset-*)` arriba, abajo y a los lados, y espacio extra al
  final del contenido para que la barra nunca tape nada.

### Pantallas revisadas

Las 17: Panel, Movimientos, Registrar, Cuentas, Mi control diario, Cierre del día, Traspasos,
Préstamos y deudas, Obligaciones, Presupuestos, Documentos, Unidades financieras, Informes,
Organizar mi dinero, Ajustes, Más y Acceso.

Cambios de fondo en ellas:

- **Panel** reconstruido alrededor de la pregunta «¿Dónde está mi dinero?», con el disponible en
  grande, el desglose efectivo/bancos, lo de hoy, lo del período, deudas, presupuesto, tareas y
  cierres. Los gráficos **no se cargan** hasta que se piden («Ver gráficos del período»).
- **Acceso** rediseñado: marca, mensaje, correo y contraseña con botón de mostrar/ocultar,
  `autoComplete` correcto, estado de carga, errores legibles y aviso claro si no hay conexión.
- **Registrar** entiende el botón central (`?kind=INGRESO/GASTO`) y muestra los saldos formateados.
- Tres diálogos nativos del navegador (`window.confirm` / `window.prompt`) sustituidos por
  diálogos y hojas propias: se pueden leer en un teléfono, no bloquean y se pueden cancelar.
- Los tres resúmenes de tres columnas que podían desbordar en 320 px ahora se reparten solos
  (`repeat(auto-fit, minmax(8.5rem, 1fr))`).

### Carga y rendimiento

- Las 17 pantallas se cargan **bajo demanda** (`React.lazy` + `Suspense`) con un esqueleto de la
  misma forma que la pantalla real.
- Los gráficos (la parte más pesada, con `recharts`) se cargan aparte.

---

## 5. Dos fallos REALES que encontraron las pruebas de navegador (y se arreglaron)

Esto es lo más importante de este informe, porque eran fallos que rompían la promesa de la
aplicación y **no** se veían en las pruebas unitarias.

### 5.1. React Query pausaba las operaciones sin conexión

Con el navegador sin conexión, React Query **no ejecutaba** las peticiones ni las mutaciones: las
dejaba «en espera». Consecuencias reales:

- Al registrar un gasto sin conexión, el botón se quedaba en «Registrando…» **para siempre** y el
  movimiento **nunca llegaba a la cola del dispositivo**. Se perdía.
- El panel se quedaba con el esqueleto de carga indefinidamente, sin explicar nada.

Arreglo: `networkMode: 'always'` en consultas y mutaciones (`src/main.tsx`). Sin conexión, la
petición se intenta y falla rápido; entonces la aplicación hace lo que tiene previsto: guardar en
el dispositivo y marcarlo como «sin confirmar».

### 5.2. No se guardaban las cuentas ni las categorías para el modo sin conexión

`getCachedAccounts()` se leía en «Registrar», pero **nadie escribía nunca** esa copia. Sin
conexión, la lista de cuentas salía vacía y no se podía registrar nada.

Arreglo nuevo: `src/lib/cache-mirror.ts` escucha las respuestas correctas de la API y guarda una
copia local de cuentas y categorías **sin borrar las demás unidades** (`upsertCachedAccounts`,
`upsertCachedCategories`). Se guarda sólo lo confirmado por el servidor: ningún saldo inventado.

### 5.3. La sesión caducada no explicaba nada

Si la sesión terminaba al arrancar, la pantalla de acceso aparecía **sin motivo**. Ahora se
guarda el motivo que envía el servidor y se muestra («Su sesión ha caducado por seguridad.
Vuelva a identificarse.»). Sólo el caso «no hay sesión» (primera visita) se muestra sin aviso,
porque no hay nada que explicar.

---

## 6. Pruebas

### 6.1. Pruebas de la aplicación (sin navegador)

| Suite                       | Qué cubre                                                                 | Resultado |
| --------------------------- | ------------------------------------------------------------------------- | --------- |
| API unitarias              | Lógica financiera, validaciones, libro mayor                              | 82 ✔      |
| API extremo a extremo       | Flujos reales contra PostgreSQL (base de datos aislada `finanza_test`)     | 89 ✔      |
| PWA (`vitest`)              | Formato, cola sin conexión, sincronización **y sesión** (nueva)            | 54 ✔      |
| Comprobación de tipos       | `tsc --noEmit` en API y en PWA                                            | 0 errores |

La suite de sesión (`src/lib/session.test.ts`, 21 pruebas) comprueba con la red simulada:
entrar bien y entrar mal, reabrir la aplicación, renovación automática, **una sola renovación
simultánea**, servidor caído (503), sin red, tiempo agotado, 500, sesión caducada, revocada,
inactividad, duración máxima, cierre de sesión y recuperación posterior — y que la cola de
movimientos pendientes **sobrevive** al cierre de sesión.

### 6.2. Pruebas de navegador (Playwright) — **123 pruebas, todas correctas**

Cinco perfiles: Android 360×800, Android 390×844, iPhone 375×667, iPhone 430×932 y escritorio
1280×800.

Qué se comprueba de verdad:

- **Sesión:** recargar no vuelve a pedir la contraseña; otra pestaña entra directamente; un 503 al
  renovar **no** expulsa al usuario (y al volver el servidor se recupera sin escribir nada); un
  corte de red tampoco; cuando la sesión caduca de verdad, se pide identificarse **y se explica
  por qué**; un movimiento registrado sin conexión queda «sin confirmar» y **sobrevive a recargar
  la aplicación**.
- **Todas las pantallas, en todos los perfiles:** cargan, no se quedan en blanco, **no se
  desplazan en horizontal**, ningún elemento se sale de la pantalla y no hay errores en consola.
- **Navegación:** los cinco accesos llevan a donde dicen; el menú central ofrece las acciones
  diarias y cada una abre su pantalla; el selector de unidad financiera funciona.
- **Formularios y diálogos:** el campo de importe acepta «99,90» y lo convierte en «99.90»; sin
  descripción el botón sigue desactivado; las hojas se cierran con `Escape`; los accesos de la
  barra inferior y el botón central miden **44 px o más**.
- **Capturas:** 32 imágenes de referencia en `docs/capturas/` (dos tamaños × 16 pantallas).

### 6.3. Aislamiento (para no tocar el dinero real)

- Las pruebas de navegador levantan **su propia API en el puerto 3310** y su propia PWA en el 5280,
  conectadas a la base de datos **`finanza_test`**.
- `reuseExistingServer` está **desactivado** a propósito: es imposible que una prueba reutilice el
  servidor de desarrollo (puerto 3010) y escriba en las cuentas de trabajo.
- Al terminar, la base de trabajo `finanza` sigue con **0 movimientos** (se comprueba en cada
  preparación de la base de datos de pruebas).
- El usuario propietario de la base de pruebas se crea con contraseña **fija y conocida**
  (`e2e@finanza.test`), sólo para poder automatizar. La base de trabajo sigue generando su
  contraseña aleatoria y mostrándola una sola vez.

### 6.4. Límites de intentos (protección real, intacta)

El acceso limitaba a 5 intentos por minuto (fuerza bruta). Sigue siendo 5 en la aplicación. Para
las pruebas de navegador, que abren muchos navegadores seguidos, existe `E2E_AUTH_LOGIN_LIMIT`
(variable de **proceso**, no del archivo `.env`), documentada en `auth.controller.ts`, donde se
explica por qué existe y que el valor por defecto es 5.

---

## 7. Qué NO se ha probado (y por tanto no se puede afirmar)

1. **No se ha probado en teléfonos físicos.** Todo son perfiles de tamaño, densidad y táctil
   emulados en **Chromium**. No se ha usado hardware Android ni iPhone reales.
2. **No se ha probado en Safari/WebKit.** Los perfiles «iPhone» emulan el tamaño, no el motor de
   Apple. Está dicho también en `playwright.config.ts`. Para probar WebKit habría que instalar
   ese motor (`npx playwright install webkit`).
3. **Notch, teclado y gesto de retroceso no se pueden probar en emulación.** El área segura se
   implementa con `env(safe-area-inset-*)`, que en Chromium emulado vale 0: en un teléfono con
   notch el resultado depende del navegador real.
4. **Notificaciones push:** se ha verificado hasta el envío aceptado por el servidor; no se ha
   confirmado la recepción en un dispositivo real.
5. **La navegación sin conexión entre pantallas** depende del precacheo del Service Worker (la
   PWA compilada cachea todos los ficheros). En modo desarrollo (sin Service Worker) las pruebas
   visitan la pantalla una vez con conexión antes de cortarla; está explicado en la propia prueba
   (`session.spec.ts`).

---

## 8. Cómo se comprueba todo esto (repetible)

```powershell
# Todo: base de datos de pruebas + API + PWA (tipos, pruebas y compilación)
.\scripts\verify.ps1

# Sólo las pruebas de navegador (con capturas)
.\scripts\e2e-web.ps1

# Un solo tamaño de teléfono y sólo las pruebas de sesión
.\scripts\e2e-web.ps1 -Project android-390x844 -Grep "sesi"

# Sólo las capturas de pantalla
.\scripts\e2e-web.ps1 -SoloCapturas
```

Informe de Playwright con trazas: `apps/web/playwright-report/index.html`.

---

## 9. Decisiones que conviene conocer

- **Volver a pedir la contraseña es la última opción, nunca la primera.** Ante cualquier duda
  sobre la causa (red, servidor, tiempo agotado) se conserva la sesión y se avisa. Sólo se cierra
  cuando el servidor lo dice con un código explícito.
- **Se aceptan fallos del entorno de pruebas, no del producto.** El reintento de Playwright está
  en 1 para absorber caídas puntuales del servidor de desarrollo. Si alguna prueba apareciera como
  «flaky», el informe lo diría: en la última ejecución **no hubo ninguna**.
- **La protección contra fuerza bruta no se ha debilitado** en la aplicación; sólo se levanta en
  el proceso de pruebas, y de forma explícita.
- **Nada se ha inventado.** Las pantallas sin datos muestran que no hay datos («— sin datos —»,
  «No hay cuentas en esta unidad»). Los únicos importes que aparecen en las capturas son los que
  crean las propias pruebas en la base de datos de pruebas.

---

## 10. Servidor de acceso: qué falta y cómo se ha dicho

**No existe recuperación de contraseña automática.** No hay endpoint para eso, así que la pantalla
de acceso **no** ofrece un enlace que no llevaría a ningún sitio: dice, con todas las letras, que
la recuperación está pendiente y que la contraseña hay que restablecerla desde la administración
del sistema. Se prefirió decirlo a simularlo.

---

## 11. Conclusión

| Criterio                                             | Resultado |
| ---------------------------------------------------- | --------- |
| ¿Se siente como una aplicación nativa de finanzas?    | **Sí** (perfiles de móvil emulados, sin hardware físico) |
| ¿Hay que iniciar sesión al cerrar y volver a abrir?   | **No.** La sesión se recupera sola |
| ¿Un 503, un 502 o un corte de red cierran la sesión?  | **No.** Comprobado en navegador |
| ¿Sólo se pide identificarse cuando toca?              | **Sí**, y explicando el motivo |
| ¿Sobrevive la sesión a recargar y a otra pestaña?     | **Sí** |
| ¿Se pierde un movimiento registrado sin conexión?     | **No.** Queda «sin confirmar» y sobrevive a recargar |
| ¿Está intacta la lógica financiera?                   | **Sí.** 82 + 89 pruebas de API y las invariantes del libro mayor sin tocar |
| ¿Todo lo visual es reutilizable y con modo claro?     | **Sí**, con nombres de color con significado |
| ¿Hay desbordamiento horizontal en móvil?              | **No** en las 16 pantallas × 5 perfiles |
| ¿Se probó en teléfonos físicos?                       | **No.** No se afirma lo contrario |

**Veredicto: GO** para el uso diario previsto, con las salvedades del apartado 7.

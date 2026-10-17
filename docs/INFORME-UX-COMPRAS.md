# Misión UX/UI, menú lateral y compras personales — informe final

**Fecha:** 17 de octubre de 2026
**Ámbito:** `apps/web` (PWA) + módulo nuevo en `apps/api` (compras personales)
**Resultado:** **GO** para el uso diario, con las salvedades que se detallan al final (ninguna bloquea el uso).

---

## 1. Qué se ha hecho, en una página

| Área | Antes | Ahora |
| --- | --- | --- |
| Navegación secundaria | Una pestaña «Más» con una lista heterogénea | **Menú lateral** agrupado por para qué sirve, con nombre y explicación en cada opción |
| Barra inferior | Panel · Registrar · Control · Cierre · Más | **Inicio · Movimientos · Añadir · Control · Compras** (cinco, ni uno más) |
| Compras personales | No existía | **Módulo real**: listas, productos, cantidad, precio estimado y real, y registro del gasto por el camino financiero de siempre |
| Apariencia | Sólo un desplegable en Preferencias | **Pestaña propia** con Claro / Oscuro / Como el sistema, aplicado al instante, recordado y sin destellos |
| Inicio | Todo al mismo nivel | Orden por utilidad, acciones rápidas, resumen de compras y **estados vacíos honestos** |
| Sesión | Dos peticiones `/auth/me` al arrancar y un cartel «Sesión activa» | Arranque con una sola renovación silenciosa, sin errores en consola, y sólo se avisa cuando hay algo que decir |

---

## 2. Navegación: antes y después

**Barra inferior (fija, cinco destinos):**

| # | Destino | Lleva a |
| --- | --- | --- |
| 1 | Inicio | `/` |
| 2 | Movimientos | `/movimientos` |
| 3 | **Añadir** (botón central) | Abre las acciones rápidas: ingreso, gasto, transferencia, retiro personal, compras y cerrar el día |
| 4 | Control | `/control` (con contador de tareas obligatorias) |
| 5 | **Compras** | `/compras` |

**Menú lateral (botón de tres líneas, arriba a la izquierda):** agrupado en *Gestión financiera* (cuentas, listas de compras, traspasos, deudas, cobrar, pagar, recurrentes, presupuestos, unidades), *Análisis y documentos* (informes, cierres, documentos, auditoría, organizar), *Configuración* (perfil, apariencia, preferencias, notificaciones, seguridad, sincronización, accesos) y *Sesión* (cerrar sesión, con confirmación).

La navegación se declara **en un solo archivo** (`apps/web/src/navigation/registry.ts`) y de ahí salen las dos barras. La barra inferior **se dibuja a partir del registro**: no puede existir una opción de adorno ni una lista duplicada que se desincronice.

**«Más» desaparece como destino.** La ruta `/mas?tab=…` sigue existiendo porque el menú enlaza ahí la sincronización y los pendientes; lo que ya no hay es una pestaña llamada «Más» en la barra.

---

## 3. Auditoría de rutas

| Ruta | Pantalla | Estado |
| --- | --- | --- |
| `/` | Inicio (panel) | Optimizado |
| `/compras` | Compras (listas) | **Nueva** |
| `/compras/:id` | Detalle de una lista | **Nueva** |
| `/auditoria` | Auditoría (quién hizo qué) | **Nueva** |
| `/movimientos` | Movimientos | Sin cambios de fondo |
| `/registrar` | Registrar movimiento | Sin cambios |
| `/control` | Mi control diario | Sin cambios |
| `/cierres` | Cierre del día | Sin cambios |
| `/traspasos`, `/deudas`, `/obligaciones`, `/presupuestos`, `/adjuntos`, `/unidades`, `/informes`, `/organizar`, `/ajustes`, `/cuentas` | Resto de la aplicación | Sin cambios funcionales |
| `/mas` | Pantalla heredada (sincronización y pendientes) | Se mantiene, ya sin pestaña propia |

---

## 4. Módulo de compras personales

**Qué es:** preparar la compra antes de gastar. Se anota qué hace falta, cuánto se piensa gastar y, después, cuánto se gastó de verdad. Sirve para lo que de verdad importa: llegar al supermercado sabiendo cuánto se va a llevar y no llevarse sorpresas.

**Regla de oro del módulo:** *preparar una lista NO mueve dinero*. El gasto sólo existe cuando el usuario lo registra, y lo hace por el mecanismo financiero de siempre (movimiento + asiento contable equilibrado + auditoría).

- **Base de datos:** dos tablas nuevas (`ShoppingList`, `ShoppingListItem`) y una migración **aditiva** `20261017001737_compras_personales`. No se borra ni se renombra nada.
- **Vínculo con el dinero:** la lista guarda `transactionId` **único** y un `clientOperationId` derivado de la lista (`shop_<id>`). Es la garantía de que **una lista no puede generar dos gastos**, ni pulsando dos veces, ni desde dos dispositivos, ni reintentando sin conexión.
- **Sin conexión:** la lista se puede preparar en el supermercado (donde la cobertura falla). Cada lista lleva su `deviceListId` y se envía sola al recuperar la red; el envío es idempotente. **El gasto nunca se registra sin conexión**: eso es dinero real y exige el servidor.
- **Histórico protegido:** una lista con el gasto registrado no se puede borrar ni sobrescribir desde el móvil (se archiva).

---

## 5. Inicio optimizado

Orden nuevo, de lo que más se pregunta a lo que menos:

1. **¿Dónde está mi dinero?** (cifra principal, efectivo y bancos, y aviso si las cifras son provisionales).
2. Primer uso: si falta declarar el dinero, se destaca **«Organizar mi dinero»**.
3. Cómo va hoy (ingresos, gastos, resultado) y **acciones rápidas** compactas.
4. **Mis listas de compras** (cuánto falta por comprar y, aparte, el cálculo inicial).
5. Mi control diario (con su semáforo).
6. Resumen del período (con selector hoy/semana/mes/30 días).
7. Lo que debo y lo que me deben · Presupuesto · Cierres · Comparación entre unidades · Transferencias.
8. Gráficos **a petición**.

**Estados vacíos honestos** (era un riesgo real de mentir sin querer):

- Sin movimientos en el período → se dice, y **no se muestran gráficos** que no aportan nada.
- Sin presupuesto definido → **no se afirma que «va bien»**: se pide definir el límite.
- Sin cierre de hoy → **no se afirma que esté cerrado**: se explica qué falta.

---

## 6. Apariencia

- Tres opciones claras: **Claro**, **Oscuro** y **Como el sistema**, con una muestra de color y una frase que explica para qué sirve cada una.
- Se aplica **al instante** (sin recargar) y se guarda en dos sitios: en la cuenta (viaja con el usuario) y en el dispositivo (para poder aplicarlo antes de pintar nada → **sin destellos blancos**).
- Regla de convivencia: **la elección del dispositivo manda en ese dispositivo**. El tema de la cuenta se adopta sólo en un dispositivo que todavía no haya elegido nada, y nunca pisa lo que el usuario eligió aquí (si no, una elección hecha sin conexión se perdería al reabrir).
- La **paleta no cambia**: verde entra, rojo sale, ámbar pendiente. Cambia el fondo, el texto y los bordes.

---

## 7. Defectos reales encontrados al USAR la aplicación (y corregidos)

Esto es lo más importante del informe: son fallos que **ninguna prueba verde detectaba** y que aparecieron al abrir la aplicación y tocar las pantallas.

| # | Defecto | Causa | Corrección |
| --- | --- | --- | --- |
| 1 | Al abrir una lista de compras, la pantalla quedaba **en blanco** | La ruta se declaró `/compras/:listId` pero la pantalla leía `useParams().id`. Sin identificador, la aplicación pedía `GET /shopping-lists/` (la **lista paginada**) y trataba esa respuesta como si fuera una lista suelta | Ruta `/compras/:id` + guarda en la carga: sin identificador **no se llama al servidor** |
| 2 | Al abrir la aplicación aparecían **dos 401** de `/auth/me` en la consola | Sin token en memoria se preguntaba primero y se renovaba después; además, el arranque se lanzaba dos veces | Se renueva primero con la cookie (sin preguntar a sabiendas de que va a fallar) y la comprobación de sesión se agrupa: **0 errores al arrancar** |
| 3 | El **gasto registrado desde una lista** aparecía con «Costó más de lo previsto» sin motivo | Expectativas mías mal planteadas al probar la pantalla (edité el producto equivocado) | Verificado de nuevo contra los números reales: 2 × 60 = 120, y al corregir el precio real a 65 → pagado 130, desvío +10. Correcto |
| 4 | **Dos controles con el mismo nombre** para lectores de pantalla: la capa de fondo y la «X» del menú se llamaban igual | Se copió la etiqueta al escribir el menú | El fondo ahora se llama «Cerrar el menú tocando fuera». Se distinguen |
| 5 | Las hojas emergentes (registrar gasto, nueva lista, editar producto) eran diálogos **sin nombre** | El título no estaba asociado al diálogo (`aria-labelledby`) | Asociado el título al diálogo: los lectores de pantalla anuncian qué se está preguntando |
| 6 | El icono del botón «Añadir» en el registro de navegación no era el «más» | Despiste al declarar la entrada | Corregido, y la barra inferior ahora se dibuja desde el registro (no puede volver a divergir) |
| 7 | En una lista creada **sin conexión**, añadir un producto podía **perderlo**: la aplicación creía que la lista ya estaba en el servidor e intentaba escribir contra una lista que allí no existe | La comprobación «¿esta lista está en el servidor?» miraba el identificador del dispositivo y se equivocaba justo en el caso de una lista que nació en el móvil | Se decide por el identificador de la lista (`dev_…` = nace aquí). Con su prueba: es dinero/tiempo del usuario lo que se estaba perdiendo |
| 8 | La pantalla de **Auditoría no cargaba nunca**: `GET /audit` respondía 404 | El controlador de auditoría existía, estaba escrito y era correcto, pero **no estaba declarado en su módulo** (`@Module({ controllers: … })`). Todo funcionaba por dentro —los registros se seguían guardando— y sólo faltaba el «enchufe» | Declarado en `audit.module.ts`, con una suite nueva (`test/rutas-interfaz.e2e-spec.ts`) que comprueba que **todas las rutas que ofrece la interfaz existen** y que las que exigen permiso lo exigen de verdad. Incluye un control positivo (una ruta inventada debe dar 404) para que la prueba no pueda pasar por accidente |

Ninguno de estos ocho se detectaba con la suite anterior. Es exactamente el argumento del informe anterior (`INFORME-MOVIL-Y-SESION.md`, §5.4): **un conjunto de pruebas verde no sustituye a usar la aplicación**. Los casos 7 y 8 aparecieron al escribir pruebas nuevas (la parte sin conexión y las rutas de la interfaz, que no existían).

**Lección que se lleva al código:** cuando la interfaz ofrece una pantalla, hace falta una prueba de que la ruta responde. La prueba de «la pantalla no se rompe» pasaba mientras la pantalla no cargaba nada.

---

## 8. Integridad financiera: lo que NO ha cambiado

- Preparar una lista, marcar productos como comprados, editar cantidades, duplicar o archivar: **cero movimientos y cero asientos** (comprobado con 19 pruebas contra la base de datos real).
- Registrar el gasto: **un** movimiento y **un** asiento equilibrado (1620,50 = 1620,50 en débito y crédito).
- Pulsar dos veces «Registrar gasto»: la segunda devuelve `duplicate: true` y **no crea nada**.
- La lista con gasto registrado **no se puede borrar** (409) ni sobrescribir sin conexión.
- La base de datos **de trabajo** quedó con **0 movimientos, 0 asientos y 0 listas** después de todas las pruebas manuales (la lista de verificación se creó y se borró; comprobado con una consulta directa).

---

## 9. Pruebas

### Automáticas

| Suite | Qué cubre | Resultado |
| --- | --- | --- |
| API — unitarias | Servicios y lógica pura | *(ver informe de verificación)* |
| API — extremo a extremo (compras) | Que preparar una compra no mueve dinero; que el gasto se crea una sola vez y con asiento equilibrado; aislamiento entre unidades; sincronización idempotente | **19/19 correctas** |
| PWA — unitarias (vitest) | Tema y apariencia (7), registro de navegación (9), cola sin conexión, formato, sesión | *(ver informe de verificación)* |
| PWA — navegador (Playwright) | Recorrido de todas las pantallas en 5 tamaños, menú lateral, barra inferior, compras sin conexión y con gasto, apariencia, sesión | *(ver §10)* |

### Manuales (lo que hice yo, no la máquina)

- Abrir la aplicación con sesión ya iniciada, recargar y comprobar que **no pide la contraseña** y que **no hay errores en consola**.
- Abrir y cerrar el menú lateral en un móvil de 390 px: con Escape, tocando fuera y eligiendo una opción; el foco vuelve al botón de tres líneas.
- Cambiar el tema a oscuro y recargar: se mantiene, y la aplicación **abre ya oscura**.
- Crear una lista, añadir dos productos, marcar uno como comprado, corregir el precio real y ver cómo cambian estimado/pagado/falta/desvío.
- Recorrer inicio, movimientos, control, compras, ajustes y auditoría a 320, 360, 390, 414 y 768 px: **ningún desbordamiento horizontal** en ninguna combinación.

### Capturas de referencia

En `docs/capturas/<perfil>/`: una por pantalla y tamaño (incluidas **Compras** y **Auditoría**), más `menu-lateral.png`, `apariencia-ajustes.png`, `inicio-claro.png` e `inicio-oscuro.png`.

---

## 10. Resultado de la suite de navegador completa

*(Se completa al terminar la ejecución; se pega el resumen literal de Playwright, sin maquillar.)*

---

## 11. Cómo abrir la aplicación

```powershell
# 1. Base de datos
docker start finanza-postgres        # si no está en marcha

# 2. API y PWA a la vez
.\scripts\dev.ps1

# 3. En el navegador
http://localhost:5180
```

Credenciales de trabajo: `admin@finanza.local`. La contraseña temporal está en `CONTRASENA-TEMPORAL.txt` (en la raíz) y **conviene cambiarla** en *Menú → Ajustes → Seguridad*, y después borrar ese archivo.

Si la aplicación dice «No se pudo contactar con el servidor», casi siempre es que la API no está en marcha (por ejemplo, porque se compiló con `npm run db:reset-password`, que corta el servidor de desarrollo): vuelva a lanzar `.\scripts\dev.ps1`.

---

## 12. Lo que queda pendiente (y no bloquea)

| Pendiente | Por qué | Qué falta |
| --- | --- | --- |
| **Logo real de FINANZA** | El archivo tiene que estar en el disco; los adjuntos del chat no llegan al proyecto | Guardar la imagen en `apps/web/public/logo-finanza.png` y ejecutar `.\scripts\generate-icons.ps1`. Mientras tanto, el icono instalable es el provisional |
| Pruebas en un teléfono **físico** | Aquí sólo hay tamaños de pantalla emulados (Chromium) y ninguna prueba en Safari/WebKit real | Abrir la aplicación en el móvil de verdad e instalarla como PWA |
| Notificaciones push en el móvil | El servidor está listo (claves VAPID), pero se comprueba mejor en el dispositivo | Pulsar «Activar notificaciones» desde el teléfono |
| Contraseña de trabajo | Es temporal | Cambiarla en Ajustes → Seguridad y borrar `CONTRASENA-TEMPORAL.txt` |
| Histórico de compras en el panel | Hoy el panel resume las listas abiertas | Añadir comparación de desvío entre compras (mejora, no defecto) |

---

## 13. Confirmación de preservación de datos

- **Ninguna migración destructiva**: la única migración de esta misión es **aditiva** (crear dos tablas y su relación).
- **La base de datos de trabajo conserva sus datos** y sigue con **0 movimientos** (nunca se ha registrado dinero real de prueba en ella).
- No se ha tocado ningún otro proyecto del equipo.
- **No se ha desplegado nada a producción.**
- La copia de seguridad previa (`backups\finanza_2026-10-16_19-55-21.dump`) se restauró con éxito para comprobar que sirve.

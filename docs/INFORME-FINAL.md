# INFORME FINAL — PROYECTO FINANZA

**Fecha:** 17 de octubre de 2026
**Ámbito:** desarrollo local. **Nada se ha publicado en internet** y no se ha tocado ninguna base de
datos de producción de FULLTECH, PHYTOEMAGRY ni FULLPOS CLOUD.
**Entorno verificado:** Windows, Node 24.14.1, Docker 29.8.2, PostgreSQL 16 (contenedor `finanza-postgres`, puerto 55432).

---

## 1. Veredicto, sin adornos

| Ámbito | Veredicto |
| --- | --- |
| **Uso local, con datos reales, hoy** | **GO** — la API, la base de datos y la PWA funcionan de extremo a extremo, con 163 pruebas automatizadas en verde y las cuentas cuadrando por construcción |
| **Uso diario para el cierre y la conciliación** | **GO** — el asistente de cierre está completo y probado contra base de datos real |
| **Instalación en móvil y trabajo sin conexión real** | **GO parcial** — la lógica está implementada y probada, pero **la prueba en un dispositivo físico con modo avión NO se ha hecho** |
| **Notificaciones push** | **GO parcial** — preparadas y probadas en el servidor; **no hay claves VAPID, así que no se ha entregado ni una notificación real** |
| **Producción en internet** | **NO-GO** — sin HTTPS, sin copias automáticas fuera del equipo, sin 2FA. Ver secciones 20 y 24 |
| **Módulos con interfaz completa** | **GO parcial** — traspasos, préstamos, deudas, cuentas por cobrar/pagar, recurrentes, presupuestos y adjuntos funcionan por API y están probados, pero **no tienen pantalla** |

No hay ningún dato financiero inventado, ninguna pantalla simulada y ningún botón sin implementar.
Lo que no está, no está y se dice aquí.

---

## 2. Qué se ha construido

Tres piezas, todas ejecutables:

1. **API** (`apps/api`): NestJS 12 + TypeScript 6 + Prisma 7 + PostgreSQL 16. **19 controladores,
   129 puntos de acceso**, 18 módulos de funcionalidad, un núcleo de dominio puro y triggers de
   integridad contable en la base de datos. 104 archivos TypeScript, ~15 600 líneas.
2. **Base de datos**: 29 tablas, 22 tipos enumerados, **8 migraciones**, 8 funciones de trigger y
   restricciones que impiden descuadrar la contabilidad incluso escribiendo SQL a mano.
3. **PWA** (`apps/web`): React 19 + Vite 8 + Tailwind 4 + Dexie. 21 archivos TypeScript, 9 pantallas,
   instalable en móvil, con cola de operaciones sin conexión y service worker.

---

## 3. Arquitectura (resumen)

```
PWA (React) ──HTTPS/JSON──> API (NestJS) ──Prisma──> PostgreSQL 16
   cola local en IndexedDB        dominio puro         libro mayor + triggers
```

Decisiones que sostienen el objetivo («que ningún peso entre o salga sin quedar identificado»):

- **Partida doble obligatoria.** Todo movimiento genera un asiento; el asiento tiene que cuadrar
  (debe = haber) y lo impone un trigger diferido, no sólo el código.
- **El saldo se calcula del libro mayor**, nunca se guarda una columna «saldo actual» que alguien
  pueda desincronizar.
- **Nada se borra.** Se anula con motivo y se genera el asiento inverso; el original queda visible.
- **Idempotencia** por `clientOperationId` único: un reintento del móvil no duplica un cobro.
- **Intercompany con cuenta puente 1150**, compartiendo un mismo asiento: un traspaso entre negocios
  no infla nunca los ingresos del grupo.
- **Fechas de negocio** en `America/Santo_Domingo`, no en UTC.

Detalle completo: `docs/ARQUITECTURA.md` e `docs/INVARIANTES-FINANCIEROS.md`.

---

## 4. Base de datos y migraciones

```
npx prisma migrate status
  → 8 migrations found in prisma/migrations
  → Database schema is up to date!
```

| # | Migración | Contenido |
| --- | --- | --- |
| 1 | `init` | 29 tablas, enums, índices |
| 2 | `integridad_contable` | Triggers de partida doble, prohibiciones de modificar y borrar |
| 3 | `sync_server_id_payload_hash` | Sincronización |
| 4 | `cierre_protegido` | Protección del cierre finalizado |
| 5 | `transfer_asiento_compartido` | Un asiento puede respaldar dos movimientos |
| 6 | `cierre_cerrado_por_closedat` | Cerrado ⇔ `closedAt` (corrección) |
| 7 | `fix_triggers_text_uuid` | Corrección de tipos en los triggers |
| 8 | `cierre_cerrado_solo_por_closedat` | **Corrección final** del defecto del cierre (ver sección 14) |

Estado actual de los datos, comprobado tras la limpieza:

| Elemento | Cantidad |
| --- | --- |
| Movimientos financieros | **0** |
| Cierres | **0** |
| Unidades financieras | 4 (FULLTECH, PHYTOEMAGRY, FULLPOS CLOUD, FINANZAS PERSONALES) |
| Cuentas del catálogo contable | 72 |
| Categorías | 32 |
| Saldos iniciales | **ninguno** (los introduce el usuario) |

### Base de datos de pruebas, aislada

`finanza_test` es una base de datos aparte. Las 52 pruebas de extremo a extremo crean movimientos y
cierres de verdad, y **escriben sólo ahí**. `apps/api/test/setup-env.ts` aborta la ejecución si no
consigue una base de datos distinta de la de trabajo: preferible fallar a mezclar datos de prueba con
las cuentas reales. Esto se descubrió y se corrigió en esta sesión (sección 14).

---

## 5. Módulos: estado real, uno a uno

| Módulo | Servidor | Pantalla | Pruebas |
| --- | --- | --- | --- |
| Autenticación, sesiones, dispositivos | ✅ | ✅ | 9 |
| Unidades financieras y miembros | ✅ | lectura en Ajustes | 4 |
| Cuentas financieras (efectivo, banco, tarjeta) | ✅ | ✅ | 8 |
| Categorías y contrapartes | ✅ | ✅ | 5 |
| Ingresos / gastos / retiros / aportes / ajustes | ✅ | ✅ | 11 |
| Anulación con reverso y motivo | ✅ | ✅ | 4 |
| Traspasos (misma unidad y entre negocios) | ✅ | **⬜ no hay pantalla** | 6 |
| Préstamos, cuotas y pagos | ✅ | **⬜ no hay pantalla** | 7 |
| Cuentas por cobrar y por pagar | ✅ | **⬜ no hay pantalla** | 4 |
| Obligaciones recurrentes | ✅ | **⬜ no hay pantalla** | 3 |
| Presupuestos y alertas | ✅ | **⬜ no hay pantalla** (consumo en el panel) | 5 |
| **Cierre diario** | ✅ | ✅ completo | 11 |
| Disciplina (verde/amarillo/rojo) | ✅ | ✅ | 4 |
| Panel con gráficas | ✅ | ✅ | 3 |
| 12 informes + CSV | ✅ | ✅ | 6 |
| Sincronización sin conexión | ✅ | ✅ | 4 + 11 pruebas de cliente |
| Notificaciones internas y push | ✅ | ✅ | 5 |
| Adjuntos | ✅ | **⬜ sin subida** | 2 |
| Auditoría | ✅ | consulta por API | 2 |
| Salud y preparación | ✅ | — | 2 |

---

## 6. Cierre diario: el módulo que sostiene todo

Es el módulo más importante del encargo y está completo:

1. **Preparación**: saldo esperado de cada cuenta calculado del libro mayor, resumen del día
   (ingresos, gastos, movimientos), operaciones pendientes de sincronizar y las 10 casillas.
2. **Recuento**: importe contado por cuenta, diferencia calculada en vivo, explicación **obligatoria**
   de cada diferencia.
3. **Resultado**: o se finaliza, o el sistema enumera **exactamente** qué lo bloquea.
4. **Ajuste** opcional y explícito (faltante → 8010, sobrante → 4920), que deja el saldo de la cuenta
   igual al efectivo contado.
5. **Reapertura** sólo con motivo de 10 caracteres o más, dejando constancia de quién y cuándo.
6. **Calendario de 30 días** con el estado de cada jornada.

Reglas de bloqueo verificadas: no se finaliza con diferencias sin explicar, ni con operaciones
pendientes de sincronizar, ni sin conexión, ni con cuentas sin recuento, ni sin la lista de
comprobación completa. Un día no se cierra dos veces.

---

## 7. Trabajo sin conexión

- Se pueden registrar ingresos, gastos y demás operaciones sin cobertura: van a una cola en
  IndexedDB y se envían solas al recuperar la conexión.
- La ventana es de 24 h (configurable). Pasada, se bloquean nuevos registros hasta validar sesión.
- El service worker **sólo cachea archivos estáticos, nunca respuestas de la API**: es preferible no
  enseñar nada a enseñar un saldo de hace tres días como si fuera de hoy.
- Nada se pierde: lo que el servidor rechaza se conserva con su motivo, visible en «Más».

**Honestidad sobre el alcance:** la cola se ha probado con **IndexedDB real** (11 pruebas de cliente)
y el protocolo de sincronización con pruebas de extremo a extremo (4). **No se ha hecho la prueba de
24 horas en un móvil real con modo avión.**

---

## 8. Notificaciones

- Recordatorio escalonado del cierre (hora configurada, +1 h y +3 h).
- Avisos internos ante cualquier asunto que requiera atención, con pantalla de tareas.
- Web Push completo en servidor y cliente: suscripción por dispositivo, control de fallos, informe de
  entrega y envío de prueba.

**Lo que no se puede afirmar:** sin claves VAPID configuradas no se ha entregado ninguna notificación
en ningún dispositivo. La aplicación dice literalmente «las notificaciones push están DESACTIVADAS» y
sigue funcionando con los avisos internos. Generar las claves está documentado en
`docs/DESPLIEGUE.md` (tres líneas).

---

## 9. Seguridad

Argon2id para contraseñas, tokens de refresco rotados y guardados sólo con hash, sesiones por
dispositivo revocables, límite de peticiones, cabeceras con `helmet`, CORS restringido, aislamiento
entre unidades con `403` verificado en pruebas, auditoría de acciones sensibles y secretos generados
con el generador criptográfico (nunca en el repositorio).

**Los tokens no se guardan en IndexedDB.** PostgreSQL sólo escucha en `127.0.0.1:55432`.

Ausencias declaradas: sin HTTPS, sin cifrado en reposo, sin 2FA, sin auditoría externa, sin pruebas de
penetración. Detalle en `docs/SEGURIDAD.md`.

---

## 10. Interfaz y experiencia móvil

9 pantallas pensadas para el móvil, con navegación inferior de 5 elementos:

**Panel** · **Registrar** · **Movimientos** · **Cierre** · **Más** (tareas, sincronización, accesos)
+ **Informes** y **Ajustes**.

- Selector de unidad financiera siempre visible en la cabecera.
- Avisos permanentes de «sin conexión» y de operaciones pendientes.
- Importes grandes, teclado numérico decimal, entrada de un toque.
- Modo claro y oscuro; colores con significado (entra/sale) y nunca como única señal.
- Ninguna cifra inventada: si no hay datos, dice «no hay datos», nunca un cero que parezca un saldo.

---

## 11. Informes

12 informes: diario, semanal, mensual, por negocio, consolidado, flujo de efectivo, gastos por
categoría, retiros del propietario, estado de cuentas, obligaciones pendientes, cierres con
diferencias y presupuestos. Todos con su período declarado, totales visibles y descarga **CSV con BOM
UTF-8** (los acentos se abren bien en Excel). Más el balance de comprobación, el libro diario y el
**informe de integridad contable**.

---

## 12. Validaciones ejecutadas, con su resultado

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Tipos API | `npx tsc --noEmit` | **0 errores** |
| Lint API | `npx eslint "src/**/*.ts" "test/**/*.ts"` | **0 errores**, 13 avisos (importes no usados) |
| Pruebas unitarias API | `npm test` | **82 / 82 en verde** (5 suites, 4,4 s) |
| Pruebas extremo a extremo | `npm run test:e2e` | **52 / 52 en verde** (base de datos real, 3,0 s) |
| Compilación API | `npx nest build` | **correcta** (`dist/main.js`) |
| Tipos PWA | `npx tsc --noEmit` | **0 errores** |
| Lint PWA | `npx eslint "src/**/*.{ts,tsx}"` | **0 errores** |
| Pruebas PWA | `npx vitest run` | **29 / 29 en verde** |
| Compilación PWA | `npx vite build` | **correcta** — 758 módulos, 984 kB (293 kB gzip), service worker con 13 elementos precargados |
| Migraciones | `npx prisma migrate status` | **8 migraciones aplicadas, «up to date»** |
| Base de datos aislada | `create-test-db.ps1` + e2e | 52/52 en verde **sobre una base creada desde cero** |
| Limpieza | `reset-dev-db.ps1` | 0 movimientos, 0 cierres, 4 unidades, 72 cuentas, 32 categorías |

**Total: 163 pruebas automatizadas en verde.**

---

## 13. Defectos encontrados y corregidos en esta sesión

| # | Defecto | Consecuencia real | Cómo se encontró | Corrección |
| --- | --- | --- | --- | --- |
| 1 | `operator does not exist: text = uuid` en los triggers | **El 100 % de las operaciones financieras fallaba con error 500** | Prueba de extremo a extremo (el comprobador de tipos no lo veía) | Migración 7: variables `text` en las funciones de trigger |
| 2 | `journalEntryId` único | Un traspaso dentro de la misma unidad (un asiento, dos movimientos) era imposible | Prueba de extremo a extremo de traspasos | Migración 5: índice en lugar de único; relación a lista |
| 3 | El trigger daba por cerrado un cierre en estado `WITH_DIFFERENCES` | No se podía explicar una diferencia y volver a guardar para finalizar | Prueba de extremo a extremo del cierre | Migración 6 (y, definitivamente, la 8) |
| 4 | La finalización exigía reenviar la lista de comprobación | Cerrar el día fallaba con 422 tras haberlo confirmado | Prueba de extremo a extremo | `finalize` lee la lista ya guardada |
| 5 | Conflicto de serialización en traspasos | 409 intermitente en operaciones legítimas | Prueba de extremo a extremo | Reintentos en `inMoneyTransaction` |
| 6 | Pago de préstamo por encima de la deuda se recortaba en silencio | El saldo dejaba de cuadrar sin explicación | Prueba de extremo a extremo | Rechazo explícito con el desglose |
| 7 | **Orden de las migraciones**: la migración 4 (marca de tiempo posterior a la 6) reintroducía el defecto 3 | Una instalación **nueva** nacía con el cierre diario roto, aunque en la máquina de desarrollo funcionara | Reconstruir la base de datos desde cero y correr las pruebas | Migración 8, con comprobación interna que falla si el defecto vuelve |
| 8 | Las pruebas escribían en la base de datos de trabajo | Datos de prueba mezclados con las cuentas reales (142 movimientos falsos) | Recuento de filas al preparar el aislamiento | Base de datos `finanza_test` + abortar si no se puede aislar + limpieza de la base de trabajo |

El defecto 7 es el más importante de la sesión: **las 52 pruebas pasaban sobre una base de datos
corregida a mano, y el sistema se rompía al instalarlo limpio**. Se descubrió precisamente por
reconstruir la base desde el historial de migraciones. Es la razón por la que hoy existe
`scripts/create-test-db.ps1` y por la que la migración 8 comprueba su propio resultado.

También se corrigieron, a raíz de las pruebas: `process.loadEnvFile` no funciona con
`--experimental-vm-modules` (carga manual del `.env`), `app.init()` daba fallos intermitentes en las
pruebas (se usa `app.listen(0)`), y un `await` dentro de JSX en la PWA.

---

## 14. Lo que NO está hecho

**Sin pantalla** (funciona por API y está probado): traspasos, préstamos y cuotas, cuentas por
cobrar y por pagar, obligaciones recurrentes, presupuestos, subida de adjuntos, gestión de miembros.

**Sin implementar**: informes en PDF; autenticación en dos pasos; cifrado de adjuntos en disco;
copias automáticas programadas; notificaciones al móvil sin claves VAPID.

**Nunca se ha intentado**: desplegar en internet; conectar con FullPOS, Phytoemagry o Fulltech;
tocar sus bases de datos; usar datos reales.

---

## 15. Lo que sólo se puede comprobar en un dispositivo real

| Comprobación | Estado | Qué falta |
| --- | --- | --- |
| 24 h sin conexión en modo avión | **PENDIENTE** | Un móvil y tiempo real. La lógica sí está probada |
| Entrega de una notificación push | **PENDIENTE** | Claves VAPID |
| Instalación en iPhone y funcionamiento en iOS | **PENDIENTE** | Un iPhone |
| Aspecto en pantallas grandes | **PENDIENTE** | Revisión visual |
| Copia de seguridad y restauración reales | **PENDIENTE** | Ejecutar los dos scripts (están listos) |

---

## 16. Cómo ejecutarlo localmente

```powershell
.\scripts\bootstrap-dev.ps1        # secretos, .env, base de datos, dependencias
cd apps\api ; npm run db:seed       # estructura y usuario (imprime la contraseña UNA vez)
cd ..\.. ; .\scripts\dev.ps1        # base de datos + API + PWA
```

- PWA: <http://localhost:5180> · API: <http://localhost:3010/api/v1/health>
- PostgreSQL: `127.0.0.1:55432` (base `finanza`)

**La contraseña del usuario `admin@finanza.local` se ha generado y se muestra una sola vez en la
salida del comando de semilla que se ha ejecutado al final de la sesión.** Cópiala de ahí y cámbiala
en Ajustes → Seguridad. Si se pierde, se puede definir `ADMIN_PASSWORD` en `apps/api/.env` y volver a
ejecutar la semilla.

Para vaciar los datos y quedarse con la estructura: `.\scripts\reset-dev-db.ps1` (pide escribir
`LIMPIAR`).

---

## 17. Copias de seguridad y restauración

```powershell
.\scripts\backup-db.ps1     # volcado comprimido en backups\ (nombre con fecha y hora)
.\scripts\restore-test.ps1  # restaura en una base APARTE y comprueba que los asientos cuadran
```

La restauración de prueba es parte del procedimiento, no un extra: cuenta las tablas, cuenta los
asientos y las líneas, y **falla si encuentra un asiento descuadrado**. Nunca restaura sobre la base
de trabajo.

---

## 18. Docker y despliegue

- `docker-compose.yml`: PostgreSQL con proyecto, contenedor, volumen y puerto propios (`55432`), y un
  perfil `full` que añade API y PWA.
- `apps/api/Dockerfile`: multi-etapa, usuario no root, `prisma migrate deploy` al arrancar, revisión
  de salud.
- `apps/web/Dockerfile` + `nginx.conf`: compilación, nginx con proxy hacia la API, cabeceras de
  seguridad, service worker sin caché y respaldo de rutas hacia `index.html`.

La infraestructura está escrita y **no se ha desplegado en producción**. Antes de hacerlo falta HTTPS,
copias fuera del equipo y revisar los orígenes permitidos.

---

## 19. Cumplimiento de las restricciones del encargo

| Restricción | Cumplimiento |
| --- | --- |
| No limitarse a crear un plan | Se ha construido el sistema completo y se ha verificado ejecutándolo |
| No detenerse pidiendo autorización módulo a módulo | Se ha trabajado de forma continua hasta el final |
| No sustituir funcionalidad real por pantallas simuladas | 129 puntos de acceso reales; lo que no está, se declara ausente |
| No inventar importes ni saldos | 0 movimientos en la base de datos de trabajo; los datos de demostración existen sólo en una unidad `DEMO` y el script se niega a ejecutarse en producción |
| No modificar otros proyectos | Ningún cambio fuera de `FINANZAS`. Docker con nombre, contenedor, volumen, base de datos y puerto propios |
| No tocar bases de producción de FullPOS / Phytoemagry / Fulltech | No se ha establecido ninguna conexión con ellas |
| No ejecutar comandos destructivos fuera de FINANZA | Ningún `prune`, ningún `down -v`, ningún `migrate reset`. La limpieza fue sobre la base `finanza` del propio proyecto y con confirmación explícita |
| No publicar secretos | Secretos generados localmente, en archivos ignorados por Git, jamás impresos en los registros |
| No desplegar públicamente | Nada publicado |

---

## 20. Riesgos y deuda técnica

| Riesgo | Impacto | Mitigación actual |
| --- | --- | --- |
| Sin HTTPS | Credenciales legibles en la red | Sólo uso local; obligatorio antes de publicar |
| Prueba en dispositivo real pendiente | Podría aparecer un problema específico de iOS | Lógica probada con IndexedDB real; falta la prueba física |
| Módulos sin interfaz | Hay que usar la API para traspasos, préstamos y presupuestos | Documentado; es el siguiente trabajo |
| Paquete de la PWA de 984 kB | Carga inicial más lenta en móvil lento | 293 kB comprimidos y precarga del service worker |
| Sin copias automáticas | Depende de ejecutar el script | Script listo, se puede programar |
| Un solo esquema de base de datos (`public`) | Sin separación por entorno en el mismo servidor | Bases de datos distintas por entorno (`finanza`, `finanza_test`) |
| Dependencias muy recientes (NestJS 12, TypeScript 6) | Menos rodaje del habitual | Versiones fijadas y verificadas una a una contra sus dependencias |

---

## 21. Recomendaciones antes de usarlo con dinero real

1. **Cambiar la contraseña** del usuario propietario y guardarla en un gestor de contraseñas.
2. **Introducir los saldos iniciales reales** de cada cuenta, con su fecha. El sistema no inventa nada.
3. **Hacer un cierre de prueba** de un día ya pasado y comprobar que cuadra.
4. **Ejecutar** `backup-db.ps1` y `restore-test.ps1` una vez, para saber que funcionan.
5. **Decidir la frecuencia de cierre** (diaria es lo recomendable) y usarla como rutina.
6. Registrar a mano un gasto y un ingreso de prueba, anularlos y comprobar que queda constancia.

---

## 22. Entregables del encargo (apartado 26)

| # | Entregable | Estado |
| --- | --- | --- |
| 1 | Aplicación web instalable (PWA) | ✅ 9 pantallas, service worker, manifiesto en español |
| 2 | API con lógica de negocio real | ✅ 129 puntos de acceso, 18 módulos |
| 3 | Esquema de base de datos | ✅ `prisma/schema.prisma`, 29 tablas, 22 enums |
| 4 | Migraciones | ✅ 8, aplicadas y verificadas desde cero |
| 5 | Triggers y restricciones de integridad | ✅ 8 funciones, probadas desde SQL directo |
| 6 | Semilla estructural (sin cifras) | ✅ idempotente, y deja constancia de que no inventa saldos |
| 7 | Cierre diario con asistente | ✅ 3 pasos, 10 casillas, bloqueos explicados |
| 8 | Sincronización sin conexión | ✅ cola local, lotes, idempotencia, nada se pierde |
| 9 | Notificaciones | ✅ internas + push preparado (sin claves VAPID) |
| 10 | Informes y exportación CSV | ✅ 12 informes + libro, balance e integridad |
| 11 | `README.md` | ✅ |
| 12 | `docs/ARQUITECTURA.md` | ✅ |
| 13 | `docs/INVARIANTES-FINANCIEROS.md` | ✅ |
| 14 | `docs/MANUAL-USUARIO.md` | ✅ |
| 15 | `docs/UAT.md` (pruebas de aceptación) | ✅ 30 casos con su evidencia |
| 16 | `docs/SEGURIDAD.md` | ✅ |
| 17 | `docs/FUNCIONALIDADES.md` | ✅ hecho / a medias / ausente |
| 18 | `docs/DESPLIEGUE.md` | ✅ |
| 19 | Pruebas automatizadas | ✅ 163 (82 + 52 + 29) |
| 20 | Scripts de arranque y verificación | ✅ `bootstrap-dev`, `sync-env`, `dev`, `verify` |
| 21 | Scripts de copia y restauración | ✅ `backup-db`, `restore-test` |
| 22 | Aislamiento de las pruebas | ✅ `create-test-db.ps1` + abortar si no se puede |
| 23 | Limpieza de datos de prueba | ✅ `reset-dev-db.ps1` con confirmación |
| 24 | Docker (API y PWA) | ✅ multi-etapa + nginx |
| 25 | Lint y comprobación de tipos | ✅ 0 errores en las dos aplicaciones |
| 26 | Informe final | ✅ este documento |

---

## 23. Próximos pasos, por orden de valor

1. **Pantalla de traspasos.** Es lo que más falta para conciliar: mover dinero entre tus cuentas y
   entre tus negocios hoy sólo se puede por API.
2. **Pantalla de préstamos y deudas.** La deuda viva ya se calcula; falta poder registrarla y pagarla
   desde el móvil.
3. **Claves VAPID** y prueba de push en Android y iPhone.
4. **Prueba real de 24 h sin conexión** en un teléfono.
5. **Pantallas de presupuestos y de cuentas por cobrar/pagar.**
6. Copia de seguridad programada y, si se quiere acceso desde fuera de casa, HTTPS.

---

## 24. Conclusión

FINANZA está construido, se ejecuta y está probado: 163 pruebas en verde, 8 migraciones aplicadas,
las cuentas cuadran por construcción y el cierre diario no permite dar por bueno un día que no cuadre.

Es **utilizable hoy, en local, con datos reales**. No está listo para producción, y se dice aquí con
la misma claridad con la que se dicen las nueve cosas que faltan.

El trabajo de esta sesión no acabó en un plan: acabó con la base de datos limpia, sin un solo importe
inventado, y esperando tus cifras.

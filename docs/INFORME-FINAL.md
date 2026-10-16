# INFORME FINAL — MISIÓN INTEGRAL FINANZA

**Fecha:** 16 de octubre de 2026
**Ámbito:** desarrollo local. **Nada se ha publicado en internet.** No se ha tocado ninguna base de
datos de producción de FULLTECH, PHYTOEMAGRY ni FULLPOS CLOUD.
**Entorno verificado:** Windows, Node 24.14.1, Docker 29.8.2, PostgreSQL 16 (`finanza-postgres`, puerto 55432).

---

## 1. Veredicto

| Ámbito | Veredicto |
| --- | --- |
| **GO LOCAL** | ✅ **Sí.** Aplicación completa y verificada para uso local con datos reales. 204 pruebas automatizadas en verde, integridad contable comprobada, base limpia y pruebas aisladas |
| **GO UAT** | ✅ **Sí, con salvedades.** Los flujos críticos están validados de extremo a extremo. Quedan **tres comprobaciones que exigen un dispositivo físico** (24 h en modo avión, entrega real de push, instalación en iPhone) |
| **GO PRODUCCIÓN** | ❌ **No.** Sin HTTPS, sin copias automáticas fuera del equipo y sin 2FA |
| **NO-GO** | No aplica: no hay riesgo crítico para el uso previsto en local |

En una frase: **se puede usar hoy para controlar el dinero de los cuatro negocios, y no está listo para
exponerlo a internet.**

---

## 2. Funcionalidades existentes que se reutilizaron

No se ha empezado nada de cero:

- **Libro mayor de partida doble** (`postEntry`, `reverseEntry`, `balancesForAccounts`) y sus triggers:
  los cobros, pagos y traspasos nuevos pasan por ahí, no por caminos nuevos.
- **`TransactionsService.create`**: cobros, pagos de obligaciones y pago de compromisos se registran
  por el MISMO servicio que usa «Registrar». Un solo camino para el dinero.
- **`ClosingsService.discipline`**: el semáforo de «Mi control diario» reutiliza el cálculo que ya
  existía, para no tener dos definiciones distintas de «rojo».
- **`BudgetsService.alerts`**, `AccessService`, `AuditService`, ayuda CSV, interceptor de
  serialización y filtro de excepciones: sin cambios.
- **Motor de sincronización del cliente** (`submitOrQueue`, `syncPendingOperations`) y cola en
  IndexedDB: las pantallas nuevas los usan tal cual.
- **Las 8 migraciones y el esquema**: **no ha hecho falta ninguna migración nueva**.

## 3. Funcionalidades nuevas

### API

| Nuevo | Qué hace |
| --- | --- |
| `GET /setup/status` | Dice qué está registrado y **qué falta** (cuentas, saldos iniciales, deudas, compromisos, primer cierre) |
| `POST /setup/organize` | **«Organizar mi dinero»** en un solo envío atómico: crea cuentas, préstamos, cuentas por cobrar/pagar y compromisos, y registra el asiento de apertura (patrimonio 3400) sin inflar ingresos |
| `GET /daily-control` | **«Mi control diario»**: semáforo, tareas reales con motivo y destino, constancia (días seguidos cerrando, cumplimiento semanal y mensual) |
| `GET /daily-control/streaks` | Los indicadores de constancia |
| `POST /obligations/receivables/:id/payments` | Cobros totales o **parciales**, con su movimiento y su asiento |
| `POST /obligations/payables/:id/payments` | Pagos totales o parciales, con su movimiento y su asiento |
| `POST /obligations/recurring/:id/pay` | Registra el gasto/ingreso REAL de período y **avanza el vencimiento**. Idempotente por período |
| `ledgerResultByDay()` | Ingresos y gastos calculados **desde el libro mayor**, no sumando tipos de operación |

### Los tres defectos de cálculo corregidos (los encontraron las pruebas nuevas)

1. **El interés de los préstamos no aparecía como gasto.** Panel e informes sumaban los movimientos por
   su *tipo*: una cuota es un solo movimiento `LOAN_PAYMENT`, pero su asiento lleva intereses (gasto
   real) y capital (menos deuda). **El beneficio del mes salía inflado exactamente en los intereses
   pagados.** Ahora el resultado se calcula desde los asientos.
2. **El asistente duplicaba los saldos iniciales.** El saldo de una cuenta es
   `openingBalance + movimientos`: al rellenar las dos cosas, declarar 50.000 mostraba 100.000.
   Corregido: una sola fuente de verdad, el libro mayor.
3. **La sincronización decía «APPLIED» a una operación repetida.** No duplicaba nada (lo importante),
   pero informaba mal. Ahora responde `DUPLICATE`.

### PWA

| Pantalla nueva | Ruta | Qué permite |
| --- | --- | --- |
| **Organizar mi dinero** | `/organizar` | Asistente de 5 pasos (mi dinero → lo que debo → lo que me deben y yo debo → compromisos → confirmar). Guarda el progreso en el dispositivo y avisa de lo que falta |
| **Mi control diario** | `/control` | Semáforo con motivo, tareas con enlace a donde se resuelven, constancia y comparativa por unidad |
| **Traspasos** | `/traspasos` | Entre cuentas y entre negocios, con aviso de que no cuenta como ingreso; historial; funciona sin conexión |
| **Préstamos y deudas** | `/deudas` | Alta de deudas (con o sin movimiento del dinero, para no contarlo dos veces), pago de cuotas, pago de tarjeta |
| **Obligaciones** | `/obligaciones` | Compromisos de cada mes (con pago real), por cobrar, por pagar y próximos vencimientos |
| **Presupuestos** | `/presupuestos` | Límite por categoría con consumo real, barras de avance y avisos |
| **Documentos** | `/adjuntos` | Subir facturas y recibos (cámara en el móvil), descargar y desvincular |
| **Unidades financieras** | `/unidades` | Crear negocios y fuentes de ingreso nuevas, ver su estado y qué les falta |

También: panel con aviso de conciliación pendiente y tarjeta de control diario; pestaña «Control» en la
barra inferior; «Más» reorganizado en tres bloques; aviso de **menos de 4 horas** de autorización
offline (y de caducidad); **tiempo de espera de 20 s** en las peticiones (antes una petición colgada
dejaba la pantalla «cargando» para siempre); y **PDF / Imprimir** en los informes con hoja de estilo de
impresión.

### Herramientas y pruebas

| Nuevo | Para qué |
| --- | --- |
| `test/integridad-financiera.e2e-spec.ts` | **28 pruebas** que defienden las reglas del dinero |
| `test/notificaciones-push.e2e-spec.ts` | **9 pruebas** del circuito de push hasta donde es verificable sin un teléfono |
| `apps/web/src/lib/offline.test.ts` | **4 pruebas** que recorren el ciclo completo de 24 h sin conexión |
| `scripts/generate-vapid.ps1` | Genera las claves VAPID sin imprimir la privada |
| Control de versiones | El proyecto **no tenía Git**: se ha creado y se ha guardado una línea base verificada antes de tocar nada |

## 4. Errores corregidos en esta sesión

| # | Error | Cómo se encontró | Corrección |
| --- | --- | --- | --- |
| 1 | Los intereses de préstamos no contaban como gasto | Prueba de integridad R4 | Resultado desde el libro mayor en panel e informes |
| 2 | El asistente contaba dos veces los saldos iniciales | Prueba de integridad R9 | El asiento es la única fuente; la columna queda en cero |
| 3 | La sincronización marcaba «APPLIED» una repetida | Prueba de integridad R13 | Ahora marca `DUPLICATE` |
| 4 | Una petición colgada esperaba indefinidamente | Prueba offline (paso 13) | Límite de 20 s y error reintentable |
| 5 | El script de VAPID creía configuradas claves vacías | Ejecución real del script | Comprobación línea a línea |
| 6 | Una prueba afirmaba «sin claves VAPID» | Al generar las claves reales | La prueba comprueba la coherencia del estado, no un valor fijo |
| 7 | Bloque duplicado al editar el panel (sintaxis) | `tsc` inmediatamente después | Corregido en el momento |

Siguen siendo válidos dos hallazgos de la sesión anterior: el trigger `text = uuid` que hacía fallar el
100 % de las operaciones (migración 7) y el orden de migraciones que dejaba el cierre diario roto en
instalaciones nuevas (migración 8).

## 5. Migraciones

```
npx prisma migrate status  →  8 migrations found · Database schema is up to date!
```

**Ninguna migración nueva.** Todo lo añadido encaja en el esquema existente. No se ha editado ninguna
migración ya aplicada.

## 6. Estado de la base de datos de trabajo

| Elemento | Valor |
| --- | --- |
| Movimientos financieros | **0** |
| Cierres | **0** |
| Unidades financieras | 4 (FULLTECH, PHYTOEMAGRY, FULLPOS CLOUD, PERSONALES) |
| Cuentas del catálogo contable | 72 |
| Categorías | 32 |
| Saldos iniciales | **ninguno** (los introduce el usuario) |
| Base de pruebas | `finanza_test`, aislada: las 89 pruebas e2e escriben ahí |

## 7. Pruebas — 204 en verde, 0 fallos

| Suite | Pruebas | Qué cubre |
| --- | --- | --- |
| API · unitarias | 82 | Dinero, fechas de negocio, amortización, asientos, reglas del cierre |
| API · flujo financiero (e2e) | 52 | Todo el recorrido del dinero contra PostgreSQL real |
| **API · integridad financiera (e2e)** | **28** | Las 14 reglas que protegen el dinero |
| **API · notificaciones push (e2e)** | **9** | Circuito de push hasta la entrega, incluida la honestidad al informar |
| **PWA** | **33** | Formato del dinero, cola sin conexión y ciclo completo de 24 h |

### Las 14 reglas de integridad, una a una

| Regla | Comprobación real |
| --- | --- |
| R1 | Ingreso 1.000 + traspaso 400 → el ingreso sigue en 1.000 y el dinero total no cambia |
| R1b | Traspaso entre negocios → el ingreso del destino sigue en 0,00 y la cuenta puente 1150 queda en 0 |
| R2 | Gasto 100 + retiro 200 → el gasto del período es 100; el retiro aparece aparte |
| R3 | Préstamo recibido → el disponible sube, el ingreso no cambia |
| R4 | Cuota de 1.000 (900 capital + 100 intereses) → el gasto sube **100**, no 1.000; el capital baja a 4.100 |
| R5 | 0 asientos descuadrados; intento con SQL directo → **rechazado por la base de datos** |
| R6 | Mismo identificador → devuelve el original y hay **1** fila; con otro contenido → rechazado |
| R7 | Saldo de cada cuenta comparado con la suma de sus asientos |
| R8 | Los movimientos no se cruzan entre unidades; cuenta ajena → error; consolidado sin duplicar |
| R9 | 50.000 declarados → ingreso 0,00, gasto 0,00, disponible 50.000 y patrimonio 30.000 con 20.000 de deuda |
| R10 | Diferencia sin explicar → 422 y el día **no** queda cerrado |
| R11 | Ajuste sin motivo → rechazado; con motivo → movimiento y registro de auditoría |
| R12 | Anular deja el original como VOIDED y crea el asiento inverso; borrar por SQL → **rechazado** |
| R13 | Lote con una operación ya registrada → APPLIED + **DUPLICATE**, y sigue habiendo 1 movimiento |
| R14 | Operación inválida → **REJECTED**, guardada con su motivo y visible en `/sync/issues` |

### Ciclo de 24 horas sin conexión (automatizado)

Registrar con conexión → sin cobertura → registrar 3 operaciones → consultar lo local → preparar cierre
provisional → **cerrar y reabrir la aplicación** → comprobar persistencia → recuperar conexión →
sincronizar → **verificar que cada operación se envió exactamente una vez** → simular tiempo de espera
agotado → reintentar → verificar idempotencia (DUPLICATE) → simular conflicto entre dispositivos →
verificar caducidad de la ventana → comprobar que lo rechazado sigue visible → confirmar que **no se ha
perdido nada**.

**Pendiente:** la prueba física de 24 h en un teléfono con modo avión. No se afirma que se haya hecho.

## 8. Estado real del push

| Paso | Estado |
| --- | --- |
| Claves VAPID | ✅ Generadas y guardadas en `apps/api/.env` (fuera de Git, verificado) |
| Servicio de envío | ✅ Verificado: lee las claves y las expone |
| Suscripción por dispositivo | ✅ Verificado: se guarda, no se duplica, se puede cancelar |
| Envío al proveedor | ✅ Verificado: intenta, cuenta aceptados y fallados y registra el error |
| Endpoint inválido | ✅ Verificado: no rompe nada, incrementa el contador de fallos |
| Avisos internos y recordatorios | ✅ Verificados (sin duplicar al ejecutarse dos veces) |
| **Entrega REAL a un teléfono** | ❌ **NO VERIFICADA** (depende de Apple/Google, del dispositivo y del permiso) |

La prueba usa un dominio `.invalid` a propósito: **no se afirma que haya llegado ninguna notificación.**

## 9. Seguridad

| Aspecto | Estado |
| --- | --- |
| Argon2id, refresco rotado, cierre por dispositivo | ✅ Ya existía |
| Aislamiento entre unidades (403) | ✅ Probado (R8) |
| Límite de peticiones, cabeceras, CORS | ✅ Ya existía |
| Secretos fuera de Git | ✅ Verificado con `git check-ignore` |
| Adjuntos validados por tamaño y tipo, fuera de carpeta pública | ✅ Ya existía |
| **2FA (TOTP)** | ❌ **NO implementada.** Necesita migración aditiva, desafío en el acceso y bloqueo por fuerza bruta. Se documenta como pendiente en lugar de hacerlo a medias |
| HTTPS | ❌ No. Obligatorio antes de exponer a internet |

## 10. Copias de seguridad

| Aspecto | Estado |
| --- | --- |
| Volcado comprimido (`backup-db.ps1`) | ✅ Funciona |
| Retención | ✅ Informa de las copias antiguas; **no borra nada por su cuenta** |
| Credenciales | ✅ Del `.env`, nunca impresas |
| Restauración en base aislada con verificación de asientos | ✅ `restore-test.ps1` existe y falla si hay un asiento descuadrado |
| **Restauración ejecutada en esta sesión** | ❌ **PENDIENTE** (el script está listo) |
| Almacenamiento externo y cifrado | ❌ Pendiente (ver `docs/DESPLIEGUE.md`) |

## 11. Preparación para producción

Preparado: imágenes Docker multi-etapa (API y PWA), nginx con proxy y cabeceras, usuario no root,
`migrate deploy` al arrancar, revisiones de salud, volumen persistente, aislamiento respecto a otros
proyectos y guía de despliegue.

Falta antes de desplegar: **HTTPS con dominio**, copias automáticas fuera del equipo, 2FA, revisión de
orígenes permitidos, copia de los adjuntos (no van en el volcado de la base) y mover el planificador de
recordatorios a una tarea del sistema. Guía concreta en `docs/DESPLIEGUE.md`.

## 12. Funcionalidades pendientes (nada de esto está simulado)

1. **Autenticación en dos pasos (TOTP)** con códigos de recuperación.
2. **Entrega real de push** comprobada en Android y en iPhone instalado.
3. **Prueba física de 24 h sin conexión.**
4. **Restauración de copia ejecutada** de principio a fin.
5. **Informes en PDF generados en el servidor** (hoy se usa «PDF / Imprimir» del navegador, con los
   mismos totales).
6. **Pruebas de interfaz en navegador (Playwright)**: no se han añadido. Lo cubierto son API, motor de
   sincronización y formato; la interfaz no tiene pruebas automatizadas de navegador.
7. **Cifrado de adjuntos** en disco y cifrado en reposo.

## 13. Cómo iniciar la aplicación

```powershell
.\scripts\bootstrap-dev.ps1          # base de datos, secretos y dependencias (primera vez)
cd apps\api ; npm run db:seed ; cd ..\..   # estructura y usuario (contraseña UNA vez)
.\scripts\dev.ps1                    # arrancar todo
```

- PWA: <http://localhost:5180> · API: <http://localhost:3010/api/v1/health>
- Verificación completa: `.\scripts\verify.ps1` (204 pruebas, ~35 s)
- Empezar de cero: `.\scripts\reset-dev-db.ps1` (pide escribir `LIMPIAR`)
- Notificaciones: `.\scripts\generate-vapid.ps1`

## 14. Evidencia de las verificaciones

```
.\scripts\verify.ps1
  ===== Base de datos =====                        OK  PostgreSQL disponible
  ===== Base de datos de pruebas (aislada) =====
  ===== API - typecheck, lint, pruebas y build ==== Tests: 82 passed, 82 total
                                                     Tests: 89 passed, 89 total
                                                     OK  API verificada
  ===== PWA - typecheck, lint, pruebas y build ==== Test Files  3 passed (3)
                                                     OK  PWA verificada
  VERIFICACIÓN COMPLETA: todo correcto en 35 s
```

- `tsc --noEmit` en las dos aplicaciones: **0 errores**; `eslint`: **0 errores**
- `prisma migrate status`: **8 migraciones, «up to date»**
- Base de trabajo tras la verificación completa: **0 movimientos, 0 cierres**

**Nota de fiabilidad:** en una ejecución de la verificación, la prueba del ciclo offline falló una vez y
no se ha reproducido en las 4 siguientes. Se anota a propósito: una prueba intermitente es un riesgo y
debe investigarse como si fuera un defecto real.

## 15. Recomendaciones para usarlo con dinero real

1. Cambiar la contraseña del propietario y guardarla en un gestor de contraseñas.
2. Abrir **«Organizar mi dinero»** y declarar la situación real. Sin ese paso la aplicación no sabe
   cuánto dinero hay, y lo dice en el panel.
3. Hacer el **primer cierre diario** de un día pasado para comprobar la mecánica.
4. Ejecutar una vez `backup-db.ps1` y `restore-test.ps1`.
5. Adoptar la rutina: registrar durante el día, cerrar por la noche, revisar «Mi control diario».
6. Activar las notificaciones en el móvil y comprobar si llegan (las claves ya están generadas).

## 16. Conclusión

FINANZA está **completo y verificado para uso local**: se sabe dónde está cada peso, de quién es, qué se
debe y qué falta por registrar; el cierre diario no permite dar por bueno un día que no cuadre; y hay
204 pruebas —28 dedicadas exclusivamente a impedir que el dinero se descuadre— que lo demuestran.

Las tres correcciones de cálculo de esta sesión (intereses como gasto, saldos iniciales sin duplicar,
sincronización que informa de los duplicados) salieron precisamente de esas pruebas, no de una revisión
superficial.

Lo que falta está enumerado con nombre y apellidos en la sección 12, y ninguna de esas cosas se
presenta como hecha.

# ARQUITECTURA DE FINANZA

## 1. Visión general

```
┌──────────────────────────────────────────────────────────────────────┐
│  PWA (React 19 + Vite 8)                                             │
│  · Instalable, funciona sin conexión hasta 24 h                      │
│  · Cola de operaciones en IndexedDB (Dexie)                          │
│  · Service worker: SÓLO caché de archivos estáticos                  │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ HTTPS · JSON · Bearer + X-Device-Id
┌────────────────────────▼─────────────────────────────────────────────┐
│  API (NestJS 12, ESM)                                                │
│  18 módulos · ThrottlerGuard → JwtAuthGuard → RolesGuard             │
│  Dominio puro (dinero, fechas de negocio, amortización, asientos)    │
│  Servicio Prisma con transacciones Serializable + reintentos         │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ Prisma 7 (adaptador pg, sin motor Rust)
┌────────────────────────▼─────────────────────────────────────────────┐
│  PostgreSQL 16                                                       │
│  30 tablas · 7 migraciones · triggers de integridad contable         │
│  El libro mayor es la fuente de la verdad; los saldos se calculan    │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. Por qué cada decisión

### 2.1 Dinero como Decimal, nunca como coma flotante

`0.1 + 0.2 != 0.3` en coma flotante binaria. En contabilidad eso es una diferencia de un centavo que
aparece al cuadrar el cierre, y encontrar de dónde sale cuesta horas.

- En la base de datos: `Decimal(18, 2)`.
- En el código: `Prisma.Decimal` (decimal.js) y `src/domain/money.ts` como único punto de paso.
- En el transporte: **texto** (`"1250.75"`), nunca número JSON. El `SerializationInterceptor` convierte
  cualquier `Decimal` a cadena antes de responder.
- En la interfaz: se suman céntimos enteros (`toCents`/`fromCents`) y sólo se formatea al mostrar.

Toda operación monetaria valida con `validateMoney()`: máximo 2 decimales, sin negativos (salvo donde
se permite), sin ceros, y con techo de 1 000 000 000 para que un dedazo no descuadre un saldo.

### 2.2 La contabilidad es de partida doble, y la base de datos lo impone

Cada movimiento financiero genera un **asiento** (`JournalEntry`) con **líneas** (`JournalLine`).
Un asiento tiene al menos dos líneas y la suma del debe es exactamente igual a la del haber.

La regla no vive sólo en el código: está en la base de datos mediante un
**trigger de restricción diferido** (`finanza_assert_entry_balanced`). Es diferido porque las líneas
se insertan una a una; la comprobación se lanza al confirmar la transacción, no en cada `INSERT`.
Si algún día alguien escribe directamente con SQL, la base de datos sigue cuadrando.

Además hay triggers que **prohíben**:

- modificar o borrar un asiento ya registrado y sus líneas,
- modificar un movimiento financiero confirmado,
- borrar movimientos, transferencias, pagos de préstamo o cierres.

No es rigidez por gusto: es lo que permite auditar meses después por qué un saldo es el que es.

### 2.3 Los errores se corrigen anulando, no borrando

Si un movimiento se registró mal, se **anula** con motivo obligatorio (mínimo 5 caracteres). Anular
genera un **asiento inverso** y deja el original marcado como `REVERSED`. Nada desaparece del libro.
El usuario ve ambos y el porqué.

### 2.4 Intercompany: la cuenta puente 1150

Cuando se pasa dinero de FULLTECH a PHYTOEMAGRY, no es un ingreso para la segunda. Si se registrara
como ingreso propio, el consolidado inflaría los ingresos del grupo con dinero que nunca entró.

Solución: una cuenta puente **1150 «Cuenta puente entre unidades»**. La salida sale de la cuenta
origen contra 1150 y la entrada en la otra unidad entra contra 1150, con el **mismo asiento**.
Como el asiento es el mismo, el consolidado lo compensa y nunca infla el resultado. El informe de
integridad comprueba que el saldo de 1150 sea exactamente cero.

### 2.5 Idempotencia: un reintento nunca duplica dinero

Cada operación que crea o mueve dinero lleva un `clientOperationId` único, generado en el dispositivo.
La API lo comprueba antes de escribir:

- Si ya existe **con el mismo contenido**: devuelve la operación original (`duplicate: true`). No pasa nada.
- Si ya existe **con otro contenido**: error `IdempotencyConflictError`. Se rechaza en lugar de suponer.

Sin esto, una respuesta perdida en una red móvil se convierte en un cobro duplicado.

### 2.6 Sin conexión: la cola del dispositivo

El service worker sólo cachea **archivos estáticos**. Decisión deliberada: cachear las respuestas de
la API significaría enseñar un saldo de hace tres días como si fuera el de hoy, y eso en finanzas es
peor que no enseñar nada.

Lo que sí funciona sin conexión es **registrar**:

1. La PWA guarda la operación en IndexedDB (`queuedOperations`) con su `clientOperationId`.
2. Al recuperar la conexión, `syncPendingOperations()` la envía en lotes de 200 al endpoint
   `POST /sync/push`.
3. El servidor responde por operación: `APPLIED`, `DUPLICATE`, `CONFLICT` o `REJECTED`.
   - `APPLIED`/`DUPLICATE` → se borra de la cola (ya está en el servidor).
   - `CONFLICT`/`REJECTED` → se conserva con su estado y el motivo, para que tú decidas.
   - Error de red → se conserva para reintentar. **Nada se pierde nunca.**

Ventana de operación sin conexión: 24 h por defecto, configurable. El servidor guarda
`offlineAllowedUntil` en la sesión; pasado ese plazo la PWA bloquea nuevos registros hasta volver a
validar la sesión. Es un equilibrio entre poder trabajar sin cobertura y no aceptar apuntes de un
dispositivo que podría haber sido revocado.

### 2.7 Fechas de negocio

Una operación de las 21:00 en Santo Domingo pertenece al día de Santo Domingo, no al día UTC
(que ya sería el siguiente). Por eso:

- Las fechas se calculan con `luxon` en la zona `America/Santo_Domingo` (`src/domain/business-date.ts`).
- Las columnas `@db.Date` guardan la medianoche UTC del día natural dominicano.
- Los cierres, presupuestos e informes siempre hablan de fechas de negocio.

### 2.8 Multiusuario y aislamiento entre unidades

`EntityMember` relaciona usuarios con unidades y su papel (`OWNER`, `ADMIN`, `OPERATOR`, `VIEWER`).
`AccessService` decide:

- `assertCanRead` / `assertCanWrite` / `assertCanAdminister`
- `resolveScope`: qué unidades puede ver el usuario.

Cada consulta filtra por unidad. Un usuario sin acceso a PHYTOEMAGRY recibe `403` aunque conozca el
identificador. Está cubierto por una prueba e2e de aislamiento entre usuarios.

### 2.9 Concurrencia

Las operaciones que mueven dinero corren dentro de `inMoneyTransaction()`, que usa
`isolationLevel: 'Serializable'` y reintenta hasta 3 veces con espera creciente ante conflictos de
serialización (P2034, 40001, 40P01, bloqueos). Dos personas cerrando la caja al mismo tiempo no
producen un saldo incoherente.

### 2.10 Estructura del código de la API

```
src/
├── domain/          Reglas puras, sin Nest ni base de datos (fáciles de probar)
│   ├── money.ts             aritmética decimal, validación, formato
│   ├── business-date.ts     fechas y rangos en la zona de negocio
│   ├── amortization.ts      préstamos: cuotas, intereses, imputación de pagos
│   ├── chart-of-accounts.ts catálogo contable (72 cuentas)
│   └── default-categories.ts categorías por defecto
├── ledger/          Partida doble
│   ├── ledger-core.ts   postEntry, reverseEntry, saldos, balance de comprobación
│   └── posting-rules.ts cómo se traduce cada tipo de operación en asientos
├── closings/        Reglas del cierre diario y disciplina financiera
├── common/          errores, filtro de excepciones, interceptor, validadores, CSV
├── prisma/          servicio Prisma con transacciones y reintentos
├── security/        control de acceso por unidad
└── <18 módulos>     auth, entities, accounts, categories, counterparties, ledger,
                     transactions, transfers, loans, obligations, budgets, closings,
                     dashboard, reports, sync, notifications, attachments, audit, health
```

El dominio no importa nada de NestJS ni de Express: se prueba en milisegundos y sin base de datos.
De las 82 pruebas unitarias, 82 no tocan PostgreSQL.

## 3. Pruebas

| Nivel        | Dónde                              | Qué cubre                                                                 |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| Unitarias    | `src/**/*.spec.ts` (82)            | dinero, fechas de negocio, amortización, asientos, reglas del cierre      |
| Extremo a extremo | `test/flujo-financiero.e2e-spec.ts` (52) | HTTP real contra PostgreSQL real: todo el flujo del dinero |

Las pruebas e2e se ejecutan **contra la base de datos de verdad**, no contra dobles. Fue lo que
descubrió el error `operator does not exist: text = uuid` que hacía fallar el 100 % de las operaciones
financieras: el comprobador de tipos no lo veía, porque el fallo estaba en un trigger SQL.

Y escriben en su **propia base de datos** (`finanza_test`), nunca en la de trabajo: una prueba que
crea movimientos y cierres de verdad no puede dejar rastro en las cuentas reales. Lo garantiza
`apps/api/test/setup-env.ts`, que aborta la ejecución si no puede apuntar a una base distinta.

Reconstruir la base desde el historial de migraciones (`create-test-db.ps1`) sirve además como
prueba de que las migraciones, aplicadas en orden, dejan la base en el estado correcto. Ahí apareció
el defecto del trigger del cierre descrito en `docs/DESPLIEGUE.md` y en el informe final.

## 4. Decisiones de las que no se ha renegado

| Decisión                                            | Motivo                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| El saldo se **calcula** desde el libro mayor        | Un saldo guardado se desincroniza en cuanto alguien escribe mal      |
| Nunca borrar: anular con reverso                    | Poder auditar y explicar cualquier cifra histórica                   |
| El service worker no cachea la API                  | Nunca mostrar un saldo viejo como si fuera actual                    |
| El cierre exige cero diferencias sin explicar       | Un cierre «aproximado» no sirve para conciliar                       |
| Datos de demostración en una unidad aparte          | Jamás mezclar cifras de ejemplo con las reales                       |
| Migraciones idempotentes                            | `prisma migrate` no es transaccional en PostgreSQL                   |

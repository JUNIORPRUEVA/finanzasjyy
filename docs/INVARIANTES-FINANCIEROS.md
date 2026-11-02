# INVARIANTES FINANCIEROS DE FINANZA

Estas son las reglas que el sistema **no permite romper**, ni desde la interfaz, ni desde la API,
ni escribiendo SQL directamente. Cada una está aplicada en dos capas cuando es posible: en el código
(mensaje claro para el usuario) y en la base de datos (garantía real).

Si alguien encuentra una forma de saltarse alguna, es un error grave.

---

## D1 — El dinero se representa con precisión exacta

| Aspecto            | Regla                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Tipo en la BD      | `Decimal(18,2)`, nunca `float`/`double`/`real`                          |
| Decimales          | Exactamente 2. Más decimales se rechazan; no se redondea en silencio    |
| Redondeo (cuando procede) | `HALF_UP` a 2 decimales, aplicado una sola vez en un punto conocido |
| Signo              | El importe siempre es positivo; el sentido lo da el tipo de operación   |
| Techo              | 1 000 000 000 por operación (protección contra dedazos)                 |
| Transporte         | Texto decimal (`"1250.75"`), jamás número en coma flotante              |

*Dónde:* `src/domain/money.ts`, validadores `IsMoneyString`, interceptor de serialización.

---

## D2 — Todo movimiento financiero tiene contrapartida contable

Ningún peso puede entrar o salir sin generar un asiento de partida doble.

- Un asiento tiene **como mínimo 2 líneas**.
- `SUM(debe) = SUM(haber)` **exactamente**, sin tolerancia.
- Cada línea tiene importe en el debe **o** en el haber, nunca en ambos, nunca en ninguno.
- Un movimiento confirmado **siempre** tiene un asiento asociado.

*Dónde:* `postEntry()` y, de forma independiente, el trigger diferido
`finanza_assert_entry_balanced()` en PostgreSQL. La prueba e2e intenta insertar un asiento
descuadrado con SQL directo y comprueba que la base de datos lo rechaza.

---

## D3 — El histórico no se reescribe

| Prohibido                                  | Cómo se hace bien                                  |
| ------------------------------------------ | -------------------------------------------------- |
| Editar un movimiento confirmado            | Anularlo con motivo y registrar el correcto         |
| Editar o borrar un asiento contable        | Registrar el asiento inverso (`reverseEntry`)       |
| Borrar un movimiento, una transferencia o un pago de préstamo | Anular: el original queda visible |
| Borrar un cierre finalizado                | Reabrirlo con motivo (queda registrado quién y cuándo) |

Los triggers `finanza_forbid_posted_entry_mutation`, `finanza_forbid_line_mutation`,
`finanza_protect_transaction`, `finanza_forbid_hard_delete` y `finanza_protect_closing`
lanzan un error explicativo en español. La anulación exige un motivo de al menos 5 caracteres.

---

## D4 — Cada operación se identifica una sola vez

Toda operación que crea o mueve dinero lleva un `clientOperationId` único:

- **Repetida con el mismo contenido** → se trata como duplicado y se devuelve la original. No se
  duplica dinero.
- **Repetida con otro contenido** → se rechaza con conflicto de idempotencia. Nunca se elige por ti.
- Queda registro en `SyncOperation` para auditar qué llegó y cuándo.

Cubre el caso real de la red móvil: la respuesta se pierde, el móvil reintenta, el cobro es uno.

---

## D5 — Los saldos se calculan, no se guardan

El saldo de una cuenta financiera se calcula **siempre** así:

```
saldo = saldo inicial documentado + (debe − haber) de sus asientos
```

Y el de una unidad financiera, sumando los saldos de sus cuentas.

**Consecuencia importante (defecto corregido):** el saldo inicial NO puede estar a la vez en la columna
`openingBalance` y en un asiento, porque contaría **dos veces**. La regla que sigue el sistema es:

- una cuenta creada a mano documenta su saldo inicial en la columna (`openingBalance`), y ese dinero
  **no** genera asiento;
- cualquier saldo declarado en la apertura se registra contra el patrimonio (3400) y deja la columna
  en cero cuando se usa el asiento de apertura.

En los dos casos el saldo mostrado es el correcto y sólo hay una fuente de verdad para cada cifra.

Consecuencia: si el libro cuadra, los saldos cuadran. No hay dos verdades.

---

## D6 — El dinero entre unidades no es ingreso

Un traspaso entre FULLTECH y PHYTOEMAGRY usa la cuenta puente **1150 «Cuenta puente entre unidades»**:

- La unidad origen acredita su cuenta y debita 1150.
- La unidad destino debita su cuenta y acredita 1150.
- Ambas partes comparten el **mismo asiento** (`JournalEntry`), por eso el consolidado lo compensa.

El informe de integridad comprueba que el saldo de 1150 sea **exactamente 0**. Si no lo es, algo se
registró como traspaso sin su contrapartida. Un traspaso no infla los ingresos del grupo.

---

## D7 — El cierre diario no se puede «aproximar»

Un cierre sólo se puede finalizar cuando:

1. No queda **ninguna diferencia sin explicar** (o se han ajustado, con su asiento de ajuste).
2. No hay **operaciones pendientes de sincronizar** en el dispositivo.
3. Se ha hecho **sin conexión** (un cierre exige validación contra el servidor).
4. **Todas las cuentas de efectivo** tienen su recuento.
5. La **lista de comprobación** está completa, incluidas las casillas que exigen confirmación explícita.

Si falta algo, el sistema enumera **exactamente qué** y no deja continuar. Se puede **guardar** el
recuento con diferencias (queda como «guardado con diferencias», sin cerrar) y seguir investigando:
guardar no es cerrar.

Un cierre cerrado se identifica por `closedAt` distinto de nulo. Reabrirlo exige un motivo de al
menos 10 caracteres y queda registrado en la auditoría con quién y cuándo.

---

## D8 — Los ajustes son visibles y explicados

Una diferencia de caja se ajusta con un movimiento explícito y rastreable:

- **Faltante** → cuenta **8010 «Faltante de caja»**.
- **Sobrante** → cuenta **4920 «Sobrante de caja»**.

Ambos aparecen en el informe de resultados. Los ajustes nunca se esconden dentro de otro movimiento,
y la cuenta 8020 «Ajuste por redondeo» existe separada para diferencias de céntimos.

---

## D9 — Los préstamos separan capital de intereses

Al pagar una cuota se imputa en este orden: **intereses → comisiones → recargos → capital**.
El capital baja el pasivo (2200) y los intereses son un gasto real (7100). Así el resultado del
negocio refleja el coste financiero y el pasivo refleja la deuda viva.

Un pago que supere capital pendiente + intereses + comisiones + recargos se **rechaza**: nada de
recortes silenciosos que descuadren el saldo después.

---

## D10 — Los cierres y las operaciones son reproducibles

Los informes no guardan cifras: se calculan a partir de los asientos en el momento de pedirlos.
Los mismos datos producen el mismo informe, siempre, con su período declarado.

---

## D11 — Nada de cifras inventadas

- La semilla estructural crea la estructura y **cero importes**.
- Los datos de demostración viven en una unidad aparte marcada `DEMO`, con movimientos descritos
  como `[DEMO]`, y el script se niega a ejecutarse en producción o si no se confirma expresamente.
- Las pantallas sin datos dicen «no hay datos», nunca muestran un cero que parezca un saldo real.

---

## D12 — El resultado se toma del libro, no del tipo de operación

El tipo de una operación describe su *intención*, no su efecto contable. Una cuota de préstamo es un
solo movimiento (`LOAN_PAYMENT`), pero su asiento lleva **intereses** (gasto real, cuenta 7100) y
**capital** (menos deuda, cuenta 2200).

Sumar los movimientos por su tipo hacía que los intereses pagados **desaparecieran del resultado del
mes** y el beneficio saliera inflado exactamente en esa cantidad. Por eso:

- **Ingresos** = haber − debe de las cuentas de tipo `INCOME`.
- **Gastos** = debe − haber de las cuentas de tipo `EXPENSE`.

Lo calcula `ledgerResultByDay()` (libro mayor) y lo usan el panel y los informes. Queda bien resuelto
por construcción el resto: los traspasos mueven cuentas de activo, los retiros van contra patrimonio
y el desembolso de un préstamo es un pasivo: **ninguno afecta al resultado**.

El panel, además, avisa cuando el libro incluye partidas que no son movimientos de ingreso ni gasto
(por ejemplo, intereses), en lugar de esconder la diferencia.

---

## D13 — El dinero de una empresa en una cuenta personal no es del propietario

Cuando un cobro de FULLTECH o APPYRA cae en el BHD o el Banreservas **personal**, el banco tiene ese
dinero de verdad, pero no es del propietario. El sistema lo dice con tres cifras que nunca se mezclan:

| Cifra | Qué es | De dónde sale |
| ----- | ------ | ------------- |
| **Saldo real** | Lo que dice el extracto del banco | Libro mayor de la cuenta (incluye el saldo inicial) |
| **Fondos de empresas** | Lo que sigue pendiente de liquidar | Suma de los cobros abiertos o parciales |
| **Disponible personal neto** | Lo que es suyo de verdad | Saldo real − fondos de empresas |

Reglas que se aplican siempre:

- **Dos asientos por operación, uno por unidad.** Empresa: `D 1130 / C ingreso` (o `C 1210` si la
  factura ya estaba emitida). Quien custodia: `D banco / C 2150`. El banco sube y la deuda con la
  empresa sube lo mismo: el propietario **no** gana nada.
- **Liquidar no es vender.** `D 2150 / C banco` en la unidad que custodia y `D banco / C 1130` en la
  empresa. Cero ingresos y cero gastos nuevos.
- **El dinero que YA estaba depositado antes de FINANZA se registra como apertura, no como venta.**
  Empresa `D 1130 / C 3400`; propietario `D 3400 / C 2150`. **No se debita el banco** (el saldo inicial
  ya lo contó) y **no se reconoce ningún ingreso** (esa venta ocurrió antes y volver a reconocerla
  inflaría el mes y recobraría facturas ya pagadas).
- **Nunca se declara más custodia que dinero libre hay en la cuenta.** Si el banco tiene 10 000 y ya
  hay 8 000 declarados, sólo se pueden declarar 2 000 más. Así el neto personal no sale de la nada.
- **Nunca se liquida más de lo pendiente.** El reparto es FIFO por fecha y una liquidación puede
  cubrir varios cobros (agrupada) sin dejar nunca un pendiente negativo.
- **Nada se borra.** Anular una liquidación reversa los dos asientos y devuelve el pendiente; el
  movimiento queda en el histórico con su motivo.

*Dónde:* `src/domain/custody-rules.ts` (reglas puras), `src/custody/custody.service.ts`,
`GET /api/v1/custody/summary`, pantalla `/custodia` y `apps/api/test/custodia.e2e-spec.ts`.

---

## D14 — Un traspaso no puede cruzar entre personas jurídicas sin clasificarse

Dos unidades con nombres distintos **no** son necesariamente dos sociedades. Cada unidad declara su
**persona jurídica** (`LegalEntity`: sociedad o persona física) y, opcionalmente, de qué unidad
depende (APPYRA es una marca dentro de FULLTECH).

Antes de contabilizar un movimiento entre cuentas se clasifica la relación:

| Caso | Qué es | Qué se hace |
|---|---|---|
| A · misma unidad | dos cuentas, mismo dueño | un solo asiento |
| B · misma persona jurídica | traslado interno (FULLTECH ↔ APPYRA) | dos asientos con la cuenta puente **1150**, que queda en **cero al consolidar esa sociedad** |
| C · personas jurídicas distintas | el dinero cambia de dueño | **se rechaza**: es retirada, retribución, reembolso o préstamo, y hay que clasificarlo (Fase 3) |
| D · relación sin confirmar | PHYTOEMAGRY y otras | **se rechaza** y se pide confirmarla; no se adivina |

La clasificación vive en `domain/legal-structure.ts` (puro y probado) y **no** se decide comparando
identificadores: usa la persona jurídica validada en la base de datos. El control `GET
/transfers/intercompany-check` comprueba el puente **global** y **por persona jurídica**: antes el
cero global podía esconder un movimiento entre dos sociedades.

---

## D15 — «Pagué algo del negocio con mi dinero» no es un gasto personal

El propietario paga el hosting de su empresa con su tarjeta. El gasto es **una sola vez**, el de la
empresa. En sus finanzas personales **no hay gasto**: hay un derecho de cobro.

| Hecho | Empresa | Propietario |
|---|---|---|
| Paga el gasto | `D gasto 6xxx` / `C 2350` (debe al propietario) | `D 1200` (le deben) / `C su cuenta` |
| La empresa devuelve | `D 2350` / `C banco empresa` | `D su cuenta` / `C 1200` |

- El **resultado personal no baja** al pagar: su patrimonio cambia de forma (efectivo → derecho de
  cobro), no de valor.
- La devolución **no es un gasto ni un ingreso**: cierra la deuda y el derecho.
- Si la cuenta «personal» fuera de la misma persona jurídica que la empresa, la operación se rechaza:
  entonces es un traslado interno, no un reembolso.
- Todo es reversible con asientos contrarios; y si ya hay devoluciones, primero se anulan éstas.

Implementado en `domain/reimbursement-rules.ts` y `reimbursements/reimbursements.service.ts`.

---

## D16 — El saldo contable no es el saldo disponible

`GET /accounts` devuelve tres números que no son lo mismo:

- `balance` — **saldo contable** (libro mayor + saldo inicial). Es el que cuadra con el banco.
- `custody` — parte de ese saldo que es de una empresa (fondos bajo custodia): **no se puede gastar**.
- `available` — lo que de verdad es del propietario (`balance − custody`), o `límite − deuda` en una
  tarjeta.

El **control de fondos** es por cuenta (`allowOverdraft`). Está en `true` por defecto a propósito: el
saldo del libro puede no coincidir con el banco mientras haya diferencias sin conciliar, y bloquear
impediría registrar operaciones que sí ocurrieron. Con `allowOverdraft = false` el servidor **rechaza**
cualquier gasto, retiro o aporte que deje la cuenta en negativo. El saldo histórico de PERSONAL
(−105,00) **no se toca**: se documenta y se reconcilia cuando se verifique su causa, nunca inventando
un ingreso.

---

## D17 — Una diferencia de conciliación no se convierte en gasto ni en ingreso por existir

Conciliar es comparar el saldo del banco con el del libro. **Comparar no escribe nada.**

Cuando hay diferencia, el sistema obliga a decir **por qué** (`ReconciliationCause`):

| Causa | Qué hace el sistema |
|---|---|
| Falta apuntar un movimiento | **No ajusta**: indica que se apunte en Movimientos |
| Traspaso pendiente | **No ajusta**: revisar Traspasos |
| Saldo inicial erróneo | **No ajusta**: corregir en Cuentas (si no hay movimientos) |
| Movimiento duplicado | **No ajusta**: anular el duplicado |
| Todavía no lo sé | **No ajusta**: se anota y se espera |
| Diferencia real revisada y **autorizada** | **Único caso** que genera asiento (faltante 8010 / sobrante 4920) |

Reglas que el servidor hace cumplir (no la interfaz):

- Sin causa, no hay ajuste.
- Sin `authorized: true` y sin motivo (≥10 caracteres), no hay ajuste.
- Cualquier otra causa devuelve un error explicando **dónde** se corrige de verdad.
- Guardar la revisión sin ajustar deja la diferencia registrada y **no toca ningún saldo**.
- El ajuste es un movimiento más: se ve, se audita y se anula con su reverso.
- **En una tarjeta el saldo es DEUDA**: si el banco informa más deuda no se llama «sobrante» ni se
  reconoce un ingreso; el asiento va contra `8020` (ajustes por diferencias).

---

## D18 — Una unidad sin persona jurídica confirmada se queda sin confirmar

Cada unidad declara su persona jurídica (`LegalEntity`) y, si aplica, de qué unidad depende. Se puede
revisar y confirmar desde **Unidades financieras → Personas jurídicas**, con auditoría de cada cambio.

- El sistema **no asigna sola** ninguna unidad: PHYTOEMAGRY y FULLPOS CLOUD siguen sin confirmar.
- Mover dinero hacia o desde una unidad sin confirmar está **bloqueado** con un aviso claro.
- Los vínculos imposibles se rechazan: finanzas personales dentro de una sociedad, un negocio que
  depende de las finanzas personales, un padre de otra persona jurídica, o un ciclo entre unidades.

---

## D19 — «Dinero para mí» mueve el dinero de verdad, y no es ingreso en ninguna de las dos unidades

El caso que D14 dejaba bloqueado tiene salida: sacar dinero de una empresa a la cuenta personal del
propietario. Antes el retiro bajaba el banco de la empresa y **el dinero no aparecía en ninguna parte**;
ahora se escribe un asiento en **cada** unidad, con la contrapartida que corresponde a lo que el dinero
**es**. Lo único que hay que declarar es la naturaleza (`nature`), y el servidor la exige: **no se adivina**.

| Naturaleza | Qué significa | Empresa | Personal |
|---|---|---|---|
| `WITHDRAWAL` | «es mi dinero, me lo llevo» | `D 3200` / `C banco` | `D banco` / `C 1230` |
| `LOAN` | «la empresa me lo presta y lo devolveré» (exige `documentRef`) | `D 1250` / `C banco` | `D banco` / `C 2202` |

Reglas que el servidor hace cumplir:

- **Sin naturaleza, sigue bloqueado** (D14): el mensaje pide clasificar, no se inventa una.
- Sólo va de una unidad **que no es personal** hacia una unidad **personal**. En sentido contrario, o
  dentro de la misma persona jurídica, se rechaza.
- **Ningún asiento toca cuentas de resultado** (4xxx–7xxx): sacar dinero de la empresa no es un ingreso
  del propietario ni un gasto de la empresa.
- El **patrimonio personal no cambia de valor** con un retiro: sale dinero (activo) y baja la
  participación en la empresa propia (`1230`) en la misma cuantía.
- Un préstamo crea **deuda en los dos lados** (`1250` activo en la empresa, `2202` pasivo personal) y
  **no se registra sin referencia documental**.
- Se usa `clientOperationId`: reintentar no duplica ni el asiento de la empresa ni el personal.
- **No se usan las cuentas pendientes** `3201`, `2450`, `1290` ni `1291`: siguen prohibidas.

La clasificación **definitiva** de cada retiro histórico (dividendo, nómina o préstamo) sigue pendiente
del criterio del contador; esto sólo garantiza que el dinero esté donde está y que el asiento sea
correcto para la naturaleza declarada.

Implementado en `domain/owner-funds-rules.ts`, `transfers/transfers.service.ts` y la pantalla
`/dinero-para-mi`. Comprobado en `apps/api/test/dinero-para-mi.e2e-spec.ts` y
`apps/web/e2e/dinero-para-mi.spec.ts`.

---

## Cómo se comprueba todo esto

```powershell
# Sólo reglas de dominio (sin base de datos)
cd apps\api ; npm test

# Reglas + base de datos, incluidos los triggers
npm run test:e2e

# Informe de integridad contable de los datos actuales
#   GET /api/v1/ledger/integrity  → asientos descuadrados, movimientos sin asiento,
#                                    saldo de la cuenta puente, cuentas sin recuento
#   GET /api/v1/transfers/intercompany-check → puente 1150 global y por persona jurídica
```

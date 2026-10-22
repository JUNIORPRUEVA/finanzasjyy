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

## Cómo se comprueba todo esto

```powershell
# Sólo reglas de dominio (sin base de datos)
cd apps\api ; npm test

# Reglas + base de datos, incluidos los triggers
npm run test:e2e

# Informe de integridad contable de los datos actuales
#   GET /api/v1/ledger/integrity  → asientos descuadrados, movimientos sin asiento,
#                                    saldo de la cuenta puente, cuentas sin recuento
```

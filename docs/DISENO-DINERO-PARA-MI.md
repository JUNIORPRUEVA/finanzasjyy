# FASE 3 — «DINERO PARA MÍ»: PROPUESTA CONTABLE

> **Estado: la parte operativa YA ESTÁ IMPLEMENTADA; la clasificación legal definitiva sigue pendiente.**
>
> Lo que ya funciona (ver invariante **D19** en `INVARIANTES-FINANCIEROS.md`): pantalla `/dinero-para-mi`
> que saca dinero de una empresa y lo deja **en la cuenta personal**, con dos asientos y sin tocar
> ninguna cuenta de resultado. La naturaleza se **declara**, no se adivina:
>
> - «es mi dinero, me lo llevo» → empresa `D 3200 / C banco`, personal `D banco / C 1230`;
> - «la empresa me lo presta y lo devolveré» (exige referencia documental) → empresa `D 1250 / C banco`,
>   personal `D banco / C 2202`.
>
> Lo que **sigue bloqueado a propósito**: decidir si un retiro concreto es dividendo, nómina, préstamo
> o devolución de un adelanto. Eso depende de un **acta, una nómina o un contrato**, y de la decisión del
> contador; el sistema no lo inventa. Las cuentas pendientes `3201`, `2450`, `1290` y `1291` siguen
> **prohibidas** y no se han creado.
>
> Este documento se conserva como propuesta para esa clasificación cuando se apruebe. **Lea primero el
> apartado 7 (Revisión 2)**, que corrige la propuesta original de `3201`/`2450`.

---

## 0. El problema, en una frase

Cuando el propietario saca dinero de la SRL hacia su cuenta personal ocurren **dos cosas a la vez**:
sale dinero de un banco (hecho cierto, con fecha y extracto) y cambia la relación entre la sociedad y
su dueño (hecho jurídico, que **depende de un documento**: acta de dividendo, nómina, préstamo,
devolución de un adelanto). La segunda parte no se puede adivinar.

**Requisitos que la solución debe cumplir a la vez:**

1. El **saldo del banco** tiene que quedar correcto (el dinero salió de verdad).
2. **No** se puede inventar un derecho de cobro exigible si no está documentado.
3. **No** se puede inventar una distribución de dividendos.
4. El **resultado** (ingresos/gastos) no puede moverse por esto.
5. El asiento tiene que estar **cuadrado** y ser **reversible**.
6. Lo que está pendiente tiene que **verse**, con responsable y fecha de revisión.

---

## 1. Por qué quedan descartadas las dos ideas anteriores

| Idea | Por qué no vale |
|---|---|
| **Cuentas de orden (memorándum)** | No sustituyen al asiento de una salida real de dinero: dejarían el banco descuadrado. Sirven para seguimiento, no como contrapartida. |
| **`1290` activo / `1291` pasivo** | Afirman un **derecho de cobro exigible** y una **obligación exigible**. Lo que aún no se sabe es justamente si eso es cierto. |

Esto no significa que todo se bloquee: una salida real **siempre** tiene contrapartida posible. La
cuestión es **elegir una contrapartida cuya naturaleza sea verdadera aunque la clasificación final no
se conozca todavía**.

---

## 2. Solución recomendada: dos cuentas de «pendiente», una por libro

La idea es que la contrapartida describa **lo que sí sabemos con certeza**:

- En la **sociedad** sabemos que ha entregado dinero al propietario y que **no es un gasto**: es
  patrimonio (una entrega a cuenta de lo que resulte).
- En el libro del **propietario** sabemos que ha recibido dinero de la sociedad y que **todavía no es
  suyo**: es una deuda hasta que se clasifique.

| Cuenta | Nombre | Tipo | Naturaleza justificada |
|---|---|---|---|
| **3201** | Entregas al propietario pendientes de clasificar | **PATRIMONIO** (debe) | Subdivisión de `3200 Retiros del propietario`. No es gasto, no es deuda con terceros, y no afirma que sea dividendo: sólo que ha salido del patrimonio. Debe quedar en **cero** al clasificar. |
| **2450** | Recibido de empresas pendiente de clasificar | **PASIVO** (haber) | Dinero recibido que aún no es del propietario. No es ingreso (no infla el resultado) ni es suyo (no se puede gastar como propio). Debe quedar en **cero** al clasificar. |

**Asiento del hecho, sin clasificar:**

```
FULLTECH SRL   D 3201 Entregas al propietario pendientes   … 1.000,00
               C 1102 Banco                                 … 1.000,00

PERSONAL       D 1102 Banco personal                        … 1.000,00
               C 2450 Recibido de empresas pendiente        … 1.000,00
```

- Los dos bancos quedan correctos y **cuadran con el extracto**.
- El resultado de la sociedad **no cambia** (3xxx no es 6xxx).
- El patrimonio personal **no sube** (activo y pasivo suben igual): el dinero no es suyo todavía.
- Ninguna de las dos cuentas afirma nada sobre dividendos, nómina ni préstamos.

**Requisitos de control (obligatorios si se aprueba):**

| Requisito | Dónde |
|---|---|
| Estado `PENDIENTE` en el documento, con **responsable** y **fecha de seguimiento** | campo nuevo en la operación + pantalla |
| **Evidencia** adjunta (acta, nómina, contrato de préstamo, comprobante) | adjuntos existentes |
| Lista de pendientes con su saldo y su antigüedad | pantalla «Dinero para mí» |
| **No** se puede marcar como «distribución aprobada» sin documento | validación del servidor |
| Conciliación: el saldo de `3201` (sociedad) y de `2450` (propietario) deben coincidir y llegar a cero | control de integridad |

---

## 3. Los cinco escenarios, uno por uno

Formato pedido: hecho · documentación · asiento FULLTECH · registro PERSONAL · efectivo ·
patrimonio · resultados · obligaciones · reversión.

### Escenario 1 — Distribución de dividendos autorizada

1. **Hecho económico.** La junta aprueba repartir beneficios y el propietario cobra su parte.
2. **Documentación.** Acta de asamblea con el importe y la fecha; declaración/retención que
   corresponda según la normativa aplicable.
3. **FULLTECH.** `D 3201` (o `3300 Resultados acumulados` si se contabiliza como distribución
   directa) / `C banco`.
4. **PERSONAL.** `D banco` / `C 2450` → y en el mismo acto, `D 2450` / `C 4900 Ingresos diversos`
   (o la cuenta de dividendos que se decida), **sólo con el acta**.
5. **Efectivo.** Baja en la sociedad, sube en el propietario.
6. **Patrimonio.** Baja el de la sociedad (distribución). En el propietario es renta, no aportación.
7. **Resultados.** **La sociedad no toca resultado** (se reparte beneficio ya calculado). En el libro
   del propietario se reconoce un ingreso *personal* (no afecta al resultado de la empresa).
8. **Obligaciones.** Ninguna nueva; sí la retención fiscal si aplica.
9. **Reversión.** Asiento contrario de los dos lados; si ya se declaró, requiere acta de rectificación.

### Escenario 2 — Remuneración (nómina) válida

1. **Hecho.** La sociedad retribuye al propietario por su trabajo.
2. **Documentación.** Contrato o nómina, período, retenciones y cotizaciones.
3. **FULLTECH.** `D 6100 Sueldos y salarios` / `C banco` (y `C 2300` por las retenciones si las hay).
4. **PERSONAL.** `D banco` / `C 2450`, y `D 2450` / `C 4900` (o cuenta de sueldos) con la nómina.
5. **Efectivo.** Baja en la sociedad, sube en el propietario.
6. **Patrimonio.** No es patrimonio: es gasto de la sociedad y renta del propietario.
7. **Resultados.** **Sí baja el resultado de la sociedad** (6xxx). Es la única de las cinco que lo hace.
8. **Obligaciones.** Retenciones y cotizaciones a ingresar.
9. **Reversión.** Contra-asiento; si ya se presentó, rectificación.

### Escenario 3 — Reembolso de una obligación real

1. **Hecho.** La sociedad devuelve al propietario dinero que él había adelantado (por ejemplo, un
   gasto pagado con su tarjeta).
2. **Documentación.** El propio registro del reembolso (ya existe: **Fase 4**), con su factura.
3. **FULLTECH.** `D 2350 Deuda con el propietario` / `C banco`. **No es gasto.**
4. **PERSONAL.** `D banco` / `C 1200 Derecho de cobro`. **No es ingreso.**
5. **Efectivo.** Baja en la sociedad, sube en el propietario.
6. **Patrimonio.** Ninguno de los dos cambia: se cobra lo que se debía.
7. **Resultados.** **Ninguno.** (El gasto se reconoció cuando se pagó.)
8. **Obligaciones.** Se extingue la deuda (2350) y el derecho (1200).
9. **Reversión.** Contra-asiento; ya implementado en Fase 4.

> Este escenario **ya está resuelto y probado** (`reimbursements`). No forma parte de la Fase 3.

### Escenario 4 — Préstamo documentado y legalmente permitido

1. **Hecho.** La sociedad presta dinero a su propietario con condiciones (plazo, interés o sin él).
2. **Documentación.** Contrato de préstamo firmado, con plazo y tipo; y verificación de que la
   operación es válida para una SRL y no encubre una distribución.
3. **FULLTECH.** `D 1250 Préstamos otorgados` / `C banco`. **No es gasto.**
4. **PERSONAL.** `D banco` / `C 2202 Préstamos personales por pagar`. **No es ingreso.**
5. **Efectivo.** Baja en la sociedad, sube en el propietario.
6. **Patrimonio.** Ninguno: se sustituye efectivo por un derecho de cobro (sociedad) y efectivo por
   una deuda (propietario).
7. **Resultados.** **Ninguno** al firmarlo; sólo los intereses, si los hubiera.
8. **Obligaciones.** Devolución con calendario; interés a devengar si se pactó.
9. **Reversión.** Contra-asiento; si hubo devolución parcial, se anula primero la devolución.

### Escenario 5 — Movimiento ya realizado, naturaleza pendiente

Ya descrito en el apartado 2. Es el **estado por defecto** y **no** es una clasificación: es el
registro fiel del hecho con la pregunta abierta.

---

## 4. Cómo se clasifica después (asientos de regularización)

| Se decide que era… | FULLTECH | PERSONAL | ¿Resultado? |
|---|---|---|---|
| Dividendo | `D 3200` / `C 3201` | `D 2450` / `C 4900` | No (sociedad) · Renta (propietario) |
| Nómina | `D 6100` / `C 3201` | `D 2450` / `C 4900` | **Sí** baja el de la sociedad |
| Reembolso | `D 2350` / `C 3201` | `D 2450` / `C 1200` | No |
| Préstamo | `D 1250` / `C 3201` | `D 2450` / `C 2202` | No |
| Devolución del dinero | `D banco` / `C 3201` | `D 2450` / `C banco` | No |

En todos los casos: **asiento nuevo y auditable**, nunca edición del anterior, y `3201`/`2450` vuelven a
cero.

---

## 5. Respuesta a la pregunta clave: «el dinero ya salió del banco»

Ese es exactamente el caso del apartado 2. Lo que **no** se debe hacer:

- ❌ No registrarlo «cuando se aclare» (el banco no cuadraría y el saldo mentiría).
- ❌ No dejarlo en una cuenta de orden (no sustituye a la contrapartida real).
- ❌ No llamarlo dividendo, nómina ni préstamo por defecto.
- ❌ No usar `3200` como si fuera una clasificación definitiva.

Lo que **sí**: contraponerlo a `3201`/`2450` (naturaleza verdadera mientras no haya documento),
dejarlo en la lista de pendientes con responsable y fecha, y cerrarlo con un asiento de clasificación
cuando llegue el documento. **Los estados financieros no se falsean**: el banco es correcto, el
resultado no se toca y el patrimonio refleja que no está decidido.

---

## 6. Lo que hace falta para activarla (requiere su aprobación)

1. **Aprobar** la naturaleza de `3201` y `2450` (o proponer otras dos cuentas).
2. **Añadirlas al catálogo contable** (migración de datos, idempotente).
3. Un campo de estado de clasificación + responsable + fecha de seguimiento en la operación.
4. Pantalla «Dinero para mí» con: cuenta de origen, cuenta de destino, importe y la pregunta
   progresiva sobre la naturaleza (con la opción «todavía no lo sé»).
5. Control de integridad: `3201` y `2450` deben cuadrar entre sí y nunca quedarse sin revisar más de
   X días.
6. Bloquear en el servidor que se marque como dividendos/nómina/préstamo sin documento adjunto.

**Mientras no se apruebe, la Fase 3 queda bloqueada.** «Moví dinero» entre la sociedad y el
propietario se rechaza con un mensaje claro, y el camino correcto para un gasto adelantado ya existe
(**Reembolsos**, Fase 4, completado).

---

# 7. REVISIÓN 2 — ¿Representan de verdad 3201 y 2450 la naturaleza de la operación?

Se revisa aquí la propuesta del apartado 2 con la misma exigencia que usted pide: **no aprobar nada
que afirme algo que no sabemos**.

## 7.1 Lo que hay que aceptar antes de seguir: no existe una contrapartida «neutra»

En partida doble, un movimiento en el banco **tiene que** llevar contrapartida. Para una salida de
dinero de la sociedad al propietario sólo existen **dos naturalezas posibles**:

| Contrapartida | Qué afirma | Efecto en los estados |
|---|---|---|
| **Patrimonio** (`3200`, o una subcuenta) | «Se ha entregado valor del patrimonio; falta decidir con qué nombre» | Baja el patrimonio, no toca resultado |
| **Activo** (`1200`/`1250`) | «La sociedad tiene un derecho de cobro sobre el propietario» | Sube un activo, no toca resultado |

No hay una tercera opción que no afirme nada: **eso era la cuenta de orden**, y usted la ha descartado
con razón porque no sustituye al asiento. Por tanto la pregunta real no es «¿cómo no afirmo nada?»
sino **«¿qué afirmación es la más prudente y la más reversible?»**.

## 7.2 Dónde la propuesta original se quedaba corta

| Crítica | Veredicto |
|---|---|
| `3201` como **cuenta de patrimonio «pendiente»** | ⚠️ **Parcialmente válida.** El patrimonio debe recoger decisiones, no dudas. Pero usar una **subcuenta** de `3200` (que ya existe para «entregas al propietario») sí es correcto: no crea una naturaleza nueva, sólo separa lo que falta por clasificar. **Cambio propuesto:** `3201` deja de ser una cuenta nueva «suelta» y pasa a ser explícitamente *«Entregas a cuenta de la distribución de resultados (pendiente de formalizar)»*, dependiente de `3200`. |
| `2450` como **pasivo exigible** en PERSONAL | ❌ **No es aceptable tal como estaba.** Afirma que el propietario **debe** el dinero. Si al final resulta ser nómina o dividendo, esa deuda nunca existió y su balance personal habría estado mal durante meses. |
| Que el pendiente no aparezca en ningún informe | ❌ Faltaba: una cuenta de suspenso debe estar **excluida de los informes de resultado y del dinero disponible**, no sólo «etiquetada». |

## 7.3 Propuesta corregida

**Empresa:** una subcuenta de patrimonio, no una cuenta nueva de otra naturaleza.

```
3201  Entregas al propietario a cuenta de distribución (pendiente de formalizar)   [PATRIMONIO]
```

- Depende de `3200` (misma naturaleza, mismo informe de patrimonio).
- **No** toca resultado: una entrega a cuenta nunca es gasto.
- **No** afirma que sea dividendo: sólo que ha salido del patrimonio del socio.

**Propietario:** aquí está el cambio importante. En lugar de un pasivo «exigible», el dinero recibido
se registra como **patrimonio del propio propietario pendiente de origen**:

```
3400  Saldo de apertura / patrimonio del propietario   [PATRIMONIO]
```

Es decir: `D banco personal / C patrimonio del propietario (pendiente)`.

- **No** crea ninguna deuda (no hay nadie a quien deba ese dinero).
- **No** crea ningún ingreso (no infla su resultado personal).
- **No** es dinero libremente disponible: la pantalla lo marca como *pendiente* y no cuenta para el
  «disponible» hasta que se clasifique.
- Y cuando se clasifique, se mueve a la cuenta que corresponda (ingreso por dividendo, ingreso por
  nómina, `1200` si era un reembolso, `2202` si era un préstamo).

> **Por qué esto es mejor que `2450`:** un pasivo inventado obliga a rectificar dos veces si la
> clasificación no es la esperada (dar de baja el pasivo y reconocer el ingreso). Un patrimonio
> pendiente **sólo cambia de nombre**, igual que en la empresa. Los dos lados quedan simétricos.

## 7.4 Controles obligatorios (sin ellos, no se activa)

1. **Nada se clasifica sin documento.** Dividendo exige acta; nómina exige nómina; préstamo exige
   contrato. El servidor lo comprueba: sin adjunto no hay clasificación.
2. **Estado de revisión** con **responsable**, **fecha de seguimiento** y **evidencia** por partida.
3. **Excluidas de los informes**: `3201` y el patrimonio pendiente del propietario **no** entran en
   ingresos, gastos, presupuestos ni en el «dinero disponible».
4. **Conciliación del pendiente**: `3201` (empresa) debe cuadrar con el patrimonio pendiente del
   propietario. Si no cuadran, hay un error.
5. **Antigüedad máxima** configurable: pasado el plazo, la partida aparece como vencida y no se puede
   seguir acumulando sin revisar las anteriores.
6. **Reversión**: contra-asiento de los dos lados; nunca edición.

## 7.5 La decisión que sigue sin poder tomarse internamente

**Esta es la pregunta exacta que hay que llevar a un asesor contable/legal, y la única que bloquea la
Fase 3:**

> En la República Dominicana, para una S.R.L., ¿la entrega de dinero al socio sin acta de distribución
> debe registrarse como **entrega a cuenta de resultados (patrimonio)** o como **cuenta por cobrar al
> socio (activo)**, y qué documento mínimo se exige para cada una de las cinco naturalezas
> (dividendo, nómina, reembolso, préstamo, pendiente)?

Mientras esa respuesta no exista:

- La Fase 3 **no se activa**.
- «Moví dinero» entre sociedad y propietario **se rechaza** con un mensaje claro.
- El camino legítimo que **ya funciona** para el caso más frecuente (el propietario adelanta un gasto
  de la empresa) es **Reembolsos**: gasto reconocido una sola vez y derecho de cobro documentado.

## 7.6 Coste del cambio cuando se apruebe

La clasificación no está en el código, está en una tabla de decisión. Si el asesor prefiere la lectura
de «cuenta por cobrar al socio», el cambio es sustituir dos pares de cuentas en esa tabla y añadir la
migración del catálogo: **no hay que rehacer el flujo ni la pantalla**.


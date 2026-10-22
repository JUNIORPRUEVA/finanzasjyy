# MANUAL DE USUARIO DE FINANZA

## 1. Primer arranque

Al abrir FINANZA por primera vez, la aplicación detecta que no hay ningún usuario y muestra la
pantalla de **puesta en marcha**. Ahí creas tu cuenta (nombre, correo y contraseña de al menos
10 caracteres).

Ya están esperándote las cuatro unidades financieras:

- **FULLTECH**
- **PHYTOEMAGRY**
- **FULLPOS CLOUD**
- **FINANZAS PERSONALES**

**No hay ningún importe cargado.** Si vieras cifras que no has escrito tú, algo va mal: dímelo.

Para empezar a registrar tu situación, abre **Cuentas y bancos**, pulsa **Nueva cuenta** y elige la
unidad financiera. Escribe el nombre de la cuenta y el saldo inicial que aparece hoy en el banco o en
la caja. Repite el proceso para cada cuenta; no se cargan importes automáticamente.

La pantalla está pensada para el móvil. Se puede instalar:

- **Android/Chrome:** menú → «Instalar aplicación».
- **iPhone/Safari:** compartir → «Añadir a pantalla de inicio». (Necesario para que funcionen las
  notificaciones, a partir de iOS 16.4).

---

## 2. La rutina diaria

### 2.0 Cómo se mueve uno por la aplicación

Abajo hay **cinco sitios**, siempre los mismos: **Inicio**, **Movimientos**, **Añadir** (el botón
del centro), **Control** y **Compras**. El botón del centro no cambia de pantalla: abre las acciones
rápidas (registrar un ingreso, un gasto, transferir dinero, un retiro personal, compras o cerrar el
día).

Arriba a la izquierda está el botón de tres líneas: ahí vive **todo lo demás**, en **tres bloques
plegables** —*Gestión financiera*, *Análisis y documentos* y *Configuración*—. Se abre **sólo uno a la
vez** (pulse el título para abrirlo o cerrarlo), de modo que el menú nunca se convierte en una lista
interminable. Cada opción lleva su nombre y una frase que explica para qué sirve, y **todas las
opciones de configuración están dentro de *Configuración***: perfil, apariencia, preferencias,
notificaciones, seguridad y dispositivos, y sincronización. Ya no hay una pestaña «Más».

En la cabecera también están la unidad financiera activa (para saber siempre en qué contexto estás
mirando) y un indicador de estado: te dice si todo está confirmado por el servidor, si hay algo
pendiente de enviar o si estás sin conexión. **No dice «sesión activa»**: si estás dentro, tu sesión
está bien; sólo avisa cuando hay algo que hacer.

### 2.1 Cuando entra o sale dinero: «Registrar»

1. Elige qué es: **Ingreso**, **Gasto**, **Retiro del propietario**, **Aporte del propietario**
   o **Ajuste**.
2. Escribe el importe. El campo ya está enfocado y acepta coma o punto.
3. Elige la cuenta (de dónde sale o entra el dinero).
4. Elige la categoría. Si escribes un gasto y eliges una categoría de ingreso, te avisa.
5. Fecha: por defecto hoy, en el día natural de Santo Domingo. Puedes cambiarla (por ejemplo, el
   gasto de ayer que apuntaste hoy).
6. Guarda.

La aplicación te dice **qué pasó de verdad**, sin adornos:

- «Movimiento confirmado» → ya está en el servidor y en el libro mayor.
- «Guardado en este dispositivo; se enviará al recuperar la conexión» → está en la cola local.
- Un error con el motivo → nada se ha registrado.

Retirar dinero para ti **no es un gasto del negocio**: es un retiro del propietario, y se contabiliza
aparte para que el resultado del negocio no se distorsione.

### 2.2 Al terminar el día: «Cierre» — el paso que no se salta

Este es el módulo que hace que las cuentas cuadren. Son tres pasos.

**Paso 1 — Revisar.** El sistema enseña el saldo **esperado** de cada cuenta, calculado desde el
libro mayor, y el resultado del día (ingresos, gastos, movimientos).

**Paso 2 — Contar.** Escribes el saldo **real** que has contado en cada cuenta. La aplicación
calcula la diferencia en vivo:

| Situación | Qué significa | Qué hacer |
| --- | --- | --- |
| Diferencia 0 | Cuadra | Nada |
| Diferencia negativa (falta dinero) | Hay un gasto sin registrar o falta efectivo | Buscar el gasto; si de verdad falta, explicarlo y ajustar |
| Diferencia positiva (sobra dinero) | Hay un ingreso sin registrar | Buscar la venta o el cobro; si de verdad sobra, explicarlo y ajustar |

Cada diferencia **exige una explicación escrita**. No es burocracia: dentro de tres meses, esa frase
es lo que te dirá por qué aquel día cerró con 500 pesos menos.

**Paso 3 — Cerrar.** La lista de comprobación tiene 10 pasos, y cinco de ellos son confirmaciones
tuyas (que están todos los ingresos, todos los gastos, todos los movimientos de cuentas, que
revisaste los traspasos y retiros, y la confirmación final).

El sistema **no te deja finalizar** si:

- queda alguna diferencia sin explicar,
- hay operaciones sin enviar al servidor (no se cierra sobre datos inseguros),
- no estás conectado,
- falta el recuento de alguna cuenta de efectivo,
- falta alguna confirmación.

Si no puedes cuadrarlo hoy, **guarda el cierre** con la diferencia explicada. Queda como «guardado
con diferencias» y puedes seguir mañana. Guardar no es cerrar.

Si te equivocaste al cerrar, se puede **reabrir** con un motivo (mínimo 10 caracteres). Queda
registrado quién y cuándo.

### 2.3 La disciplina: VERDE, AMARILLO, ROJO

El cierre evalúa cinco cosas y da un color con su explicación:

- ¿Se cerró el día anterior?
- ¿Se ha cerrado hoy?
- ¿Hay diferencias de caja?
- ¿Hay operaciones sin sincronizar?
- ¿Hay cuentas sin recuento?

- **VERDE** — todo en orden.
- **AMARILLO** — algo pendiente que puede resolverse hoy (por ejemplo, el cierre de ayer).
- **ROJO** — hay diferencias de dinero o cierres acumulados sin hacer. Atiéndelo hoy.

El color no es un adorno: cada punto se puede desplegar para ver exactamente qué lo provoca.

---

## 3. Consultar

### El panel

Muestra el período que elijas (hoy, ayer, semana, mes, último mes): ingresos, gastos, resultado,
cuánto dinero hay y dónde, deuda viva, retiros del propietario, consumo de presupuestos, tareas
pendientes, tus listas de compras y comparación entre unidades. Los gráficos aparecen **sólo si los
pidas** y sólo si hay datos que contar.

Si empezó hace poco verá avisos honestos en lugar de cifras vacías: «no ha registrado movimientos
en este período», «todavía no ha fijado un presupuesto», «todavía no hay cierre de hoy». **La
aplicación no dice que todo va bien cuando todavía no lo sabe.**

### Compras personales

Sirve para preparar una compra antes de gastar y, después, saber cuánto se gastó de verdad.

1. **Cree una lista** («Supermercado del sábado», «Farmacia»…) y elija la unidad financiera.
2. **Añada productos** con su cantidad, su unidad y **el precio que espera pagar**. La aplicación
   suma y le dice cuánto va a gastar antes de salir de casa.
3. Ya en la compra, **vaya marcando lo que compró**. Puede corregir el precio real si le costó otra
   cosa: ahí abajo verá el **desvío** (cuánto costó más o menos de lo previsto).
4. Cuando termine, pulse **«Registrar gasto en FINANZA»**: ahí sí sale el dinero de una cuenta, con
   su asiento contable, igual que si lo registrara a mano.

Nada de esto mueve dinero hasta ese último paso, y **una lista sólo puede generar un gasto**: si
vuelve a pulsar, no se duplica. Una compra ya registrada no se puede borrar (se archiva), para que el
histórico no se reescriba.

Se puede preparar la lista **sin conexión** (en el supermercado la cobertura falla); se enviará sola
al recuperarla. Lo que **no** se hace sin conexión es registrar el gasto: eso es dinero real y exige
el servidor.

### Movimientos

Lista con filtros de fecha, búsqueda de texto y tipo. Toca un movimiento para ver su asiento y,
si hace falta, **anularlo** (con motivo). Anular no borra: registra el asiento inverso y deja el
original a la vista.

### Informes

Doce informes, con su período y sus totales, con descarga en CSV que se abre bien en Excel
(lleva BOM para que los acentos no se rompan).

---

## 3 bis. «Fondos en custodia»: dinero de una empresa en tu cuenta personal

Se abre de tres maneras, todas a la misma pantalla:

- Menú lateral → **Fondos en custodia** (junto a «Traspasos»).
- **Movimientos** → el enlace azul «¿Dinero de una empresa en su cuenta personal?».
- **Cuentas y bancos** → el enlace de cada cuenta («Registrar dinero de una empresa aquí» o
  «Ver o liquidar estos fondos»).

La pantalla contesta tres preguntas y nunca las mezcla:

| Cifra | Qué significa |
| ----- | ------------- |
| **Saldo real** | Lo que dice el extracto del banco |
| **De empresas** | La parte de ese saldo que pertenece a Fulltech, Appyra… |
| **Suyo de verdad** | Saldo real − dinero de empresas |

### Si el dinero de Fulltech/YA estaba en el banco antes de usar FINANZA

1. Primero, en **Cuentas y bancos**, comprueba que la cuenta (BHD, Banreservas…) tiene el saldo que
   figura hoy en el banco. Si no lo tiene, corrígelo antes: es la base de todo.
2. Abre **Fondos en custodia** → pestaña **Registrar** → opción **«Ya estaba ahí»**.
3. Elige la empresa dueña del dinero, la cuenta donde está y el importe.
4. Escribe un concepto («Cobros de Fulltech ya depositados») y guarda.

Eso **no** crea una venta ni vuelve a cobrar facturas ya pagadas: sólo aclara de quién es el dinero
que ya estaba en el banco. El saldo del banco no cambia.

### Si es un cobro nuevo

Pestaña **Registrar** → **«Cobro nuevo»** (o **«Cobro de factura»** si la factura ya estaba
registrada). El banco personal sube el importe real y la empresa reconoce su ingreso **una sola vez**.

### Cuando le pasas el dinero a la empresa

Pestaña **Liquidar** → elige la empresa y la cuenta → cuenta destino (el banco de la empresa) →
importe. Puedes liquidar todo o una parte; si hay varios cobros, se pagan del más antiguo al más
nuevo en una sola liquidación.

Si te equivocas, pestaña **Historial** → **Anular** (con motivo). Se hace la reversa y nada se borra.

> **Ojo:** esto no es un «procesador de pagos». Aquí el dinero ya está en tu banco; lo que se aclara
> es de quién es.

---

## 4. Trabajar sin conexión

Puedes registrar ingresos y gastos sin cobertura. Se guardan en el dispositivo y se envían solos
al recuperar la conexión.

**Importante:** lo que se guarda sin conexión es el **registro**, no el saldo. Los saldos que ves
sin conexión son de la última vez que hubo conexión, y la aplicación te avisa con un aviso visible.
Nunca te enseña un saldo viejo como si fuera el de ahora.

Tienes **24 horas** de margen sin conexión (configurable). Pasado ese plazo, la aplicación bloquea
nuevos registros hasta que vuelvas a conectarte y se valide tu sesión. Es a propósito: evita que un
dispositivo perdido siga apuntando dinero.

En «Más → Sincronización» ves:

- las operaciones pendientes, con su estado y su motivo si fallaron,
- el botón para reintentar una concreta,
- la opción de descartar una operación (con confirmación),
- exportar a un archivo e importar (útil al cambiar de teléfono).

---

## 5. Ajustes

| Pestaña | Qué se configura |
| --- | --- |
| **Preferencias** | Perfil, zona horaria de negocio, moneda, hora del recordatorio de cierre, horas de trabajo sin conexión, umbrales de aviso y alerta de presupuesto |
| **Apariencia** | **Claro**, **Oscuro** o **Como el sistema**. Se aplica al instante, se recuerda, y la aplicación abre ya con el tema elegido (sin destellos blancos). La paleta no cambia: verde entra, rojo sale, ámbar pendiente |
| **Notificaciones** | Activar en este dispositivo, enviar una de prueba, ver las suscripciones y sus fallos |
| **Seguridad** | Cambiar contraseña (cierra las demás sesiones), ver y cerrar sesiones por dispositivo, cerrar sesión |

Si el servidor no tiene claves VAPID, la pestaña de notificaciones lo dirá con esas palabras:
«las notificaciones push están DESACTIVADAS». Las alertas internas seguirán apareciendo en
*Mi control diario* (y en *Sincronización y pendientes*, dentro del menú).

---

## 6. Reglas que la aplicación nunca romperá

1. **No se borra dinero registrado.** Se anula, con motivo, y quedan las dos partes.
2. **No se acepta un movimiento sin contrapartida contable.** Cada peso tiene su asiento.
3. **No se cierra el día con diferencias sin explicar.**
4. **No se cuenta dos veces la misma operación**, aunque el móvil reintente.
5. **Un traspaso entre negocios no es un ingreso.** Nunca inflará tus ventas.
6. **Un retiro del propietario no es un gasto del negocio.**

---

## 7. Preguntas frecuentes

**He registrado algo mal, ¿lo borro?**
No. Anúlalo con motivo (Movimientos → el movimiento → Anular) y registra el correcto. Así queda la
historia completa y el arqueo sigue cuadrando.

**¿Por qué el saldo del banco no coincide con el de la app?**
Porque la app sólo sabe lo que le has contado. Registra lo que falte y, si la diferencia es real e
inexplicable, ciérrala con un ajuste. El sistema no «arregla» saldos por su cuenta.

**Me falta apuntar un gasto de hace tres días. ¿Puedo cerrar hoy sin más?**
Puedes registrar el gasto con fecha de hace tres días. Ese día quedará con un movimiento posterior,
y el informe lo refleja. Lo que no se hace es cerrar un día sabiendo que falta algo.

**¿Puedo usar FINANZA con dos teléfonos a la vez?**
Sí. Cada dispositivo tiene su identificador y su propia cola. Lo registrado en cada uno se confirma
en el servidor con su propio identificador de operación, sin duplicarse.

**¿Qué pasa si se va la luz a mitad de un cierre?**
El recuento guardado se conserva. Al volver, el cierre sigue en el paso donde lo dejaste.

**¿Puedo ver los datos de otro negocio?**
Sólo si tienes permiso sobre esa unidad. Si no, la API responde «sin permiso» aunque conozcas el
identificador.

**Olvidé la contraseña. ¿Qué hago?**
FINANZA no envía correos de recuperación, así que no hay un enlace «he olvidado mi contraseña»: sería
un enlace que no llevaría a ninguna parte. La contraseña se restablece desde el ordenador donde está
instalada la aplicación:

```powershell
cd apps\api
npm run db:reset-password
```

El script genera una contraseña nueva, la deja **en el portapapeles** y —si se indica `--archivo`— también en un fichero
para leerla con calma, **cierra todas las sesiones abiertas** de ese usuario —si alguien hubiera entrado con la
contraseña vieja, deja de servir— y lo anota en la auditoría.
Sirve también para cambiar la contraseña de otro usuario: `npm run db:reset-password -- --email=otro@ejemplo.com`.

> El comando recompila la API (`nest build`). Si tenía el servidor de desarrollo en marcha, puede detenerse: pare el
> servidor antes de ejecutarlo o vuelva a arrancarlo después con `npm run start:dev`.

Al entrar, cámbiala por una que recuerdes en **Ajustes → Perfil**. Nadie puede consultar la contraseña
anterior: en la base de datos sólo se guarda un hash de Argon2id.

**¿Por qué me pide la contraseña otra vez si no he hecho nada?**
Sólo ocurre por tres motivos, y la pantalla te dice cuál: la sesión caducó por seguridad, se alcanzó su
duración máxima, o se cerró desde otro dispositivo. Un corte de internet o un fallo momentáneo del
servidor **no** cierran la sesión: puedes seguir trabajando y se reintenta solo.

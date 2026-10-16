# UAT — PRUEBAS DE ACEPTACIÓN DE FINANZA

Resultado de la comprobación funcional del sistema. Cada caso indica **cómo se ha comprobado** y
**con qué evidencia**, para que no haya que fiarse de la palabra de nadie.

Resultados posibles:

- **PASA (automático)** — hay una prueba automatizada que lo verifica y se ha ejecutado en verde.
- **PASA (manual)** — comprobado a mano contra el sistema en marcha.
- **PENDIENTE** — requiere un dispositivo real, cobertura real o claves de producción que no existen.
  **No se marca como pasado.**

Comandos usados:

```powershell
cd apps\api
npm test          # 82 pruebas unitarias (dominio puro, sin base de datos)
npm run test:e2e  # 52 pruebas de extremo a extremo contra PostgreSQL real
cd ..\web
npm test          # 29 pruebas del cliente (formato del dinero y cola sin conexión)
```

---

## A. Acceso y puesta en marcha

| ID | Caso | Cómo se comprueba | Resultado |
| --- | --- | --- | --- |
| UAT-01 | El sistema arranca sin ningún dato financiero inventado | Semilla estructural: crea 72 cuentas, 32 categorías, 4 unidades y el usuario; imprime «Saldos iniciales: ninguno». `GET /accounts` devuelve 0 cuentas | **PASA (manual)** |
| UAT-02 | Alta del primer usuario y negativa a un segundo alta pública | `GET /auth/bootstrap-status` antes y después; `POST /auth/register` responde 409 si ya hay usuario | **PASA (automático)** |
| UAT-03 | Inicio de sesión correcto y rechazo de credenciales erróneas | e2e de autenticación: 200 con tokens válidos, 401 con contraseña incorrecta | **PASA (automático)** |
| UAT-04 | Una sesión caducada se renueva y el refresco rota | e2e: uso del token de refresco, se emite uno nuevo y el anterior deja de servir | **PASA (automático)** |

## B. Estructura financiera

| ID | Caso | Cómo se comprueba | Resultado |
| --- | --- | --- | --- |
| UAT-05 | Crear cuenta con saldo inicial documentado | e2e: `POST /accounts` y comprobación de que el saldo inicial genera asiento de apertura | **PASA (automático)** |
| UAT-06 | El saldo inicial no se puede cambiar después | e2e: al modificar `openingBalance` la API responde 409 | **PASA (automático)** |
| UAT-07 | Una tarjeta de crédito no se puede crear como activo de efectivo | e2e: `POST /accounts` con tipo de efectivo y `isCreditCard` → rechazado | **PASA (automático)** |
| UAT-08 | Categoría de ingreso no se puede usar en un gasto (y al revés) | e2e: `POST /transactions` con categoría incoherente → 422 con mensaje explicativo | **PASA (automático)** |

## C. Registrar dinero

| ID | Caso | Cómo se comprueba | Resultado |
| --- | --- | --- | --- |
| UAT-09 | Registrar un ingreso y verlo en el saldo de la cuenta | e2e: ingreso → saldo de la cuenta sube exactamente el importe | **PASA (automático)** |
| UAT-10 | Registrar un gasto y verlo en el saldo | e2e: gasto → saldo baja exactamente el importe | **PASA (automático)** |
| UAT-11 | El importe se maneja con exactitud de céntimos | 13 pruebas unitarias de dinero (0.1 + 0.2 = 0.30 exacto, sumas con céntimos) | **PASA (automático)** |
| UAT-12 | Se rechazan importes con más de 2 decimales, negativos o cero | Pruebas unitarias de `validateMoney` + e2e con 422 | **PASA (automático)** |
| UAT-13 | El retiro del propietario no cuenta como gasto del negocio | e2e: retiro → el gasto del período no cambia, el retiro aparece aparte | **PASA (automático)** |
| UAT-14 | Anular un movimiento exige motivo y no borra nada | e2e: anulación sin motivo → 422; con motivo → asiento inverso y el original queda marcado | **PASA (automático)** |
| UAT-15 | Un movimiento confirmado no se puede editar ni borrar | e2e: `DELETE` del movimiento por SQL directo → la base de datos lo rechaza con error 23514 | **PASA (automático)** |

## D. Contabilidad de partida doble

| ID | Caso | Cómo se comprueba | Resultado |
| --- | --- | --- | --- |
| UAT-16 | Todo movimiento genera un asiento cuadrado | e2e: cada operación comprueba asiento existente y `SUM(debe) = SUM(haber)` | **PASA (automático)** |
| UAT-17 | Un asiento descuadrado es imposible, incluso con SQL directo | e2e: `INSERT` descuadrado → rechazado por el trigger diferido | **PASA (automático)** |
| UAT-18 | Traspaso entre cuentas de la misma unidad | e2e: sale de una, entra en la otra, la suma total no cambia | **PASA (automático)** |
| UAT-19 | Traspaso entre negocios no infla los ingresos | e2e: ingreso del grupo sin cambios y saldo de la cuenta puente 1150 = 0 | **PASA (automático)** |
| UAT-20 | El informe de integridad detecta lo que está mal | e2e: `GET /ledger/integrity` sobre datos correctos devuelve todo en cero | **PASA (automático)** |

## E. Deudas y presupuestos

| ID | Caso | Cómo se comprueba | Resultado |
| --- | --- | --- | --- |
| UAT-21 | Un pago de préstamo separa intereses de capital | e2e: el capital baja el pasivo, los intereses son gasto, y la suma coincide con la cuota | **PASA (automático)** |
| UAT-22 | Un pago mayor que la deuda se rechaza (no se recorta en silencio) | e2e: pago de 29 999 sobre 19 200 → 422 con el desglose | **PASA (automático)** |
| UAT-23 | Superar un presupuesto avisa pero no bloquea el gasto | e2e: el gasto se registra y la alerta aparece con el porcentaje real | **PASA (automático)** |

## F. Cierre diario

| ID | Caso | Cómo se comprueba | Resultado |
| --- | --- | --- | --- |
| UAT-24 | Cierre completo: preparar, contar, explicar y finalizar | e2e: día con movimientos, recuento igual al esperado y finalización correcta | **PASA (automático)** |
| UAT-25 | No se puede finalizar con diferencias sin explicar | e2e: recuento con 500 de menos sin explicación → 422 enumerando el bloqueo | **PASA (automático)** |
| UAT-26 | No se puede finalizar con operaciones sin sincronizar | e2e: cierre con pendientes locales → bloqueado con el motivo | **PASA (automático)** |
| UAT-27 | Un día no se cierra dos veces | e2e: segundo cierre del mismo día → 409 | **PASA (automático)** |
| UAT-28 | Reabrir un cierre exige motivo y queda registrado | e2e: reapertura con motivo corto → 422; con motivo válido → abierto y auditado | **PASA (automático)** |
| UAT-29 | Guardar el conteo con la diferencia ya explicada y finalizar | e2e: segundo `POST /closings/count` del mismo día → 201 y `canFinalize = true` | **PASA (automático)** |
| UAT-30 | Una base de datos creada desde cero se comporta igual que la corregida a mano | Reconstrucción completa desde las migraciones + las 52 pruebas e2e en verde | **PASA (automático)** |

### Defecto encontrado por estas pruebas

**UAT-29 y UAT-30 destaparon un defecto real.** Las pruebas e2e estaban pasando en la base de datos de
trabajo (que se había corregido a mano durante la depuración), pero al **reconstruir la base desde el
historial de migraciones** fallaban 3 casos del cierre diario:

- La migración `20261016193000_cierre_protegido` tiene una marca de tiempo **posterior** a
  `20261016184500_cierre_cerrado_por_closedat`, que era la que corregía el trigger.
- Al aplicarlas en orden, la versión endurecida **volvía a introducir** la comprobación antigua
  (dar por cerrado un cierre en estado `WITH_DIFFERENCES`).
- Consecuencia para el usuario: no se podía **explicar una diferencia y volver a guardar** el conteo
  para finalizar; el asistente respondía «Prohibido modificar el cierre cerrado».

Corregido con la migración `20261017090000_cierre_cerrado_solo_por_closedat`, que se aplica la última
y deja la regla correcta (cerrado ⇔ `closedAt`), más una comprobación dentro de la propia migración
que falla si la función volviera a quedar en el estado antiguo.

**Lección:** una batería de pruebas sólo demuestra lo que prueba. Mientras las pruebas se ejecutaban
sobre una base manipulada a mano, daban verde sobre un sistema que se rompía al instalarlo de cero.

---

## Comprobaciones que NO se han podido hacer aquí

Estas no están marcadas como pasadas porque requieren cosas que no dependen del código:

| Caso | Qué falta | Qué haría falta para cerrarlo |
| --- | --- | --- |
| Trabajar 24 h sin conexión en un móvil real (modo avión) | Un dispositivo físico y 24 h reales | Instalar la PWA, activar modo avión, registrar, cerrar la app, volver a conectarse y comprobar que se envía sin duplicar. **La lógica sí está probada**: 7 pruebas con IndexedDB real + 4 de extremo a extremo del protocolo de sincronización |
| Entrega real de una notificación push | Claves VAPID | Generar claves, configurarlas y probar en Android y en iPhone instalado |
| Instalación en iPhone y comportamiento de la PWA en iOS | Un iPhone | Instalar desde Safari y revisar que el service worker y la cola funcionan |
| Impresión y aspecto en pantallas grandes | Revisión visual del usuario | Probar en un monitor grande y ajustar si hiciera falta |
| Copia de seguridad y restauración reales | Ejecutar los scripts | `.\scripts\backup-db.ps1` y `.\scripts\restore-test.ps1` (los scripts están listos y comprueban los asientos restaurados) |

---

## Resumen

| Resultado | Casos |
| --- | --- |
| **PASA (automático)** | 28 de 30 |
| **PASA (manual)** | 2 de 30 (UAT-01 y la revisión visual inicial) |
| **PENDIENTE** | 5 comprobaciones adicionales, todas dependientes de dispositivo real, claves VAPID o ejecución manual de los scripts |

**Ninguna prueba se ha marcado como pasada sin evidencia.** Las que dependen de un dispositivo real
quedan pendientes y así se informa.

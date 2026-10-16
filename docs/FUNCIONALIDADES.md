# FUNCIONALIDADES DE FINANZA — lo que está, lo que no y lo que falta

Este documento es deliberadamente incómodo: separa lo que **funciona de verdad y está probado** de
lo que **está a medias** y de lo que **no existe**. No hay nada marcado como hecho que sea una
pantalla de mentira o un botón sin implementar.

Leyenda: ✅ hecho y probado · 🟡 hecho en el servidor, sin interfaz todavía · ⬜ no hecho

---

## 1. Base y acceso

| Función | Estado | Detalle |
| --- | --- | --- |
| Registro del primer usuario (puesta en marcha) | ✅ | `/auth/bootstrap-status` decide entre alta inicial e inicio de sesión |
| Inicio de sesión con correo y contraseña | ✅ | Argon2id, bloqueo por intentos, límite de peticiones |
| Sesiones con refresco de token | ✅ | `access` corto + `refresh` rotado y guardado con hash |
| Cierre de sesión y cierre de todas las sesiones | ✅ | `logout`, `logout-all` |
| Listado de sesiones y dispositivos con revocación individual | ✅ | Ajustes → Seguridad |
| Cambio de contraseña | ✅ | Cierra las demás sesiones |
| Multiusuario por unidad con papeles (OWNER/ADMIN/OPERATOR/VIEWER) | ✅ | API probada; la gestión de miembros tiene interfaz en Ajustes/Más |
| Unidades financieras (4 iniciales + las que se creen) | ✅ | Alta/edición en la API; la interfaz permite crear cuentas y ver unidades |
| Ventana de trabajo sin conexión configurable | ✅ | 24 h por defecto, se bloquea al caducar |

## 2. Estructura financiera

| Función | Estado | Detalle |
| --- | --- | --- |
| Cuentas financieras (efectivo, banco, tarjeta, billetera, otras) | ✅ | Alta desde «Cuentas», con saldo inicial documentado |
| Saldo inicial como asiento de apertura contra la cuenta 3400 | ✅ | No se escribe un saldo «a mano»: entra al libro |
| Tarjeta de crédito tratada como pasivo (no como efectivo) | ✅ | La base de datos lo impone con una restricción |
| Catálogo contable de 72 cuentas | ✅ | Creado por la semilla, ampliable |
| Categorías de ingreso y gasto (32 por defecto) | ✅ | Alta y edición en la API; desactivación en lugar de borrado |
| Contrapartes (clientes, proveedores, entidades) | ✅ | API completa; usado al registrar |
| Cuentas cerradas no admiten movimientos | ✅ | Validado en el servicio |

## 3. Dinero: registrar y corregir

| Función | Estado | Detalle |
| --- | --- | --- |
| Registrar ingresos | ✅ | Pantalla «Registrar», con categoría, método y fecha de negocio |
| Registrar gastos | ✅ | Igual, con categoría obligatoria por tipo |
| Retiros del propietario | ✅ | Cuenta 3200, separados del gasto del negocio |
| Aportes del propietario | ✅ | Cuenta 3100 |
| Ajustes manuales (debe/haber explícitos) | ✅ | Sólo con cuentas indicadas; es la vía para diferencias de caja |
| Saldo de cuenta por período | ✅ | Calculado del libro; incluye saldo inicial |
| Listado de movimientos con filtros, búsqueda y paginación | ✅ | Pantalla «Movimientos» |
| Anulación de un movimiento con motivo obligatorio | ✅ | Genera asiento inverso; el original queda visible |
| Importe exacto (Decimal, sin errores de céntimos) | ✅ | 13 pruebas de dinero |
| Cifras negativas o con más de 2 decimales rechazadas | ✅ | Mensaje claro al usuario |
| Adjuntar comprobantes (imagen/PDF) a un movimiento | 🟡 | Módulo `attachments` con API y almacenamiento en disco; sin interfaz de subida |

## 4. Traspasos entre cuentas y entre negocios

| Función | Estado | Detalle |
| --- | --- | --- |
| Traspaso entre cuentas de la misma unidad | ✅ | Un asiento con dos cuentas, un movimiento de salida y uno de entrada |
| Traspaso entre unidades (intercompany) | ✅ | Cuenta puente 1150, mismo asiento: no infla ingresos |
| El traspaso exige cuenta origen ≠ destino | ✅ | Rechazado con mensaje claro |
| Informe de comprobación intercompany | ✅ | `/transfers/intercompany-check`: el saldo de 1150 debe ser 0 |
| Pantalla para hacer traspasos | ⬜ | **No existe.** Hoy se hace por API (`POST /transfers`) |

## 5. Deudas y préstamos

| Función | Estado | Detalle |
| --- | --- | --- |
| Préstamos recibidos y otorgados | ✅ | API completa |
| Cuadro de amortización (sistema francés) y por días | ✅ | `buildSchedule`, 8 pruebas de dominio |
| Pago de cuota con separación de intereses y capital | ✅ | Intereses → comisiones → recargos → capital |
| Rechazo de pagos por encima de la deuda total | ✅ | Nunca se recorta en silencio |
| Cuentas por cobrar y por pagar | ✅ | API completa |
| Obligaciones recurrentes (alquiler, suscripciones, nómina) | ✅ | Incluye «avanzar período» |
| Resumen de deuda para el panel | ✅ | `/loans/summary` |
| Pantallas de préstamos, cuentas por cobrar/pagar y recurrentes | ⬜ | **No existen.** Sólo lectura en el panel (deuda total viva) |

## 6. Presupuestos

| Función | Estado | Detalle |
| --- | --- | --- |
| Presupuestos por período y categoría | ✅ | API completa, con asignaciones |
| Alertas al acercarse y al superar el umbral | ✅ | Umbrales configurables (80 % aviso / 100 % alerta) |
| Superar un presupuesto **no bloquea** el gasto | ✅ | Avisa, no impide: la realidad manda |
| Gasto de cada presupuesto calculado del libro | ✅ | Con porcentaje y lo que queda |
| Pantalla para definir presupuestos | ⬜ | **No existe.** El consumo se ve en el panel |

## 7. Cierre diario — el módulo central

| Función | Estado | Detalle |
| --- | --- | --- |
| Preparar el cierre de un día | ✅ | Saldo esperado por cuenta calculado del libro |
| Recuento de efectivo por cuenta | ✅ | Diferencia calculada en vivo |
| Explicación obligatoria de cada diferencia | ✅ | No se puede finalizar sin explicarla |
| Guardar el recuento sin cerrar | ✅ | Estado «guardado con diferencias»: se puede seguir investigando |
| Ajuste automático de la diferencia | ✅ | Asiento a 8010 faltante / 4920 sobrante, opcional y explícito |
| Lista de comprobación de 10 pasos (5 con confirmación expresa) | ✅ | Ingresos, gastos, movimientos, recuento, comparación, traspasos, diferencias, sincronización, confirmación final |
| Bloqueo si hay operaciones sin sincronizar | ✅ | Un cierre no puede ignorar movimientos del dispositivo |
| Bloqueo si se intenta cerrar sin conexión | ✅ | El cierre exige validación de servidor |
| Un único cierre por unidad y día (no duplicados) | ✅ | Restricción de base de datos |
| Finalizar dejando a quién y cuándo | ✅ | `closedAt`, `closedByUserId` |
| Reapertura con motivo (mínimo 10 caracteres) | ✅ | Queda en auditoría |
| Calendario de 30 días con el estado de cada día | ✅ | Pantalla «Cierre» |
| Disciplina financiera (VERDE/AMARILLO/ROJO) | ✅ | 5 comprobaciones explicadas una a una |

## 8. Panel y disciplina

| Función | Estado | Detalle |
| --- | --- | --- |
| Panel con presets (hoy, ayer, semana, mes, trimestre, año, últimos 30 días) | ✅ | |
| Ingresos, gastos, resultado del período | ✅ | Desde el libro |
| Desglose de dinero por cuenta y por tipo | ✅ | Activos frente a pasivos |
| Deuda viva y retiros del propietario | ✅ | |
| Gráficas de ingresos/gastos y gasto por categoría | ✅ | Recharts |
| Comparación entre unidades financieras | ✅ | |
| Consumo de presupuestos en porcentaje | ✅ | |
| Tareas pendientes (cierre de ayer sin hacer, cuentas sin recuento, etc.) | ✅ | Pantalla «Más» → Tareas |
| Códigos de color VERDE/AMARILLO/ROJO | ✅ | Reglas explicitadas, no decorativas |

## 9. Informes y exportación

| Función | Estado | Detalle |
| --- | --- | --- |
| 12 informes (diario, semanal, mensual, por unidad, consolidado, flujo de efectivo, gastos por categoría, retiros, estado de cuentas, obligaciones pendientes, cierres, presupuestos) | ✅ | Pantalla «Informes» |
| Exportación a CSV con BOM UTF-8 (acentos correctos en Excel) | ✅ | Descarga directa |
| Balance de comprobación y libro diario | ✅ | API del libro mayor |
| Informe de integridad contable | ✅ | Asientos descuadrados, movimientos sin asiento, 1150, cierres abiertos |
| Tendencias entre períodos | ✅ | `/reports/trends` |
| Informes en PDF | ⬜ | No está. El CSV y el informe web son la vía actual |

## 10. Sin conexión y sincronización

| Función | Estado | Detalle |
| --- | --- | --- |
| Registrar ingresos/gastos sin conexión | ✅ | Cola en IndexedDB; **probado con IndexedDB real en las pruebas** |
| Envío por lotes al recuperar la conexión | ✅ | `POST /sync/push`, lotes de 200 |
| Detección de duplicados (idempotencia) | ✅ | `APPLIED` / `DUPLICATE` / `CONFLICT` / `REJECTED` |
| Rechazo de fechas alteradas del dispositivo | ✅ | Comparación con la hora del servidor |
| Nada se pierde: los rechazos se conservan con su motivo | ✅ | Pantalla «Más» → Sincronización |
| Exportar e importar las operaciones pendientes | ✅ | Archivo JSON, útil antes de cambiar de dispositivo |
| Ventana de 24 h sin conexión y bloqueo al caducar | ✅ | Configurable |
| La API **nunca** se sirve de la caché | ✅ | Sólo se cachean archivos estáticos |
| Prueba real en un móvil con modo avión | ⬜ | **No realizada.** Ver `docs/UAT.md`, caso UAT-25 |

## 11. Notificaciones

| Función | Estado | Detalle |
| --- | --- | --- |
| Recordatorio escalonado del cierre (hora, +1 h, +3 h) | ✅ | Tarea programada; se puede lanzar a mano para probar |
| Avisos internos ante cualquier problema (asiento descuadrado, fallo de sincronización, diferencia de cierre) | ✅ | Tabla `Notification` + pantalla de tareas |
| Web Push (VAPID) con suscripción por dispositivo | ✅ en el servidor | Cliente y servidor listos; **sin claves VAPID configuradas no se envía nada y la app lo dice** |
| Informe de entrega de notificaciones | 🟡 | `/notifications/push/delivery-report` |
| Entrega real comprobada en un dispositivo | ⬜ | **No verificada.** Ver `docs/UAT.md`, caso UAT-26 |

## 12. Seguridad y control

| Función | Estado | Detalle |
| --- | --- | --- |
| Contraseñas con Argon2id | ✅ | Nunca en claro, nunca registradas en el log |
| Límite de peticiones (global y por ruta sensible) | ✅ | `ThrottlerGuard` |
| Cabeceras de seguridad | ✅ | `helmet` |
| CORS restringido al origen de la PWA | ✅ | |
| Aislamiento entre unidades (403 si no hay permiso) | ✅ | Probado en e2e |
| Auditoría de acciones sensibles | ✅ | Tabla `AuditLog` + consulta en la API |
| Secretos fuera del repositorio | ✅ | `.env` ignorado; los scripts los generan y nunca los imprimen |
| Tokens de sesión **no** guardados en IndexedDB | ✅ | Decisión explícita: la caché local no lleva credenciales |

---

## Lo que falta, en una frase

Lo que no está hecho es, sobre todo, **interfaz** para funciones que ya existen y están probadas en
el servidor: traspasos, préstamos y deudas, cuentas por cobrar/pagar, obligaciones recurrentes,
presupuestos y adjuntos. Y faltan las comprobaciones que **sólo se pueden hacer en un dispositivo
real**: la prueba de modo avión, la entrega de push y la instalación en iPhone.

Nada de lo que falta está simulado: simplemente no está, y la aplicación no finge que esté.

# Estado del sistema y lo que queda pendiente

Documento de cierre. Dice **qué está hecho y verificado**, **qué falta** y **qué decisiones son suyas**.
No repite la guía de despliegue: eso está en [DESPLIEGUE-EASYPANEL.md](DESPLIEGUE-EASYPANEL.md).

Última revisión: 20/10/2026.

---

## 1. Dónde está funcionando

| | |
| --- | --- |
| Aplicación | https://ventas-finanzaspersonalespwa.gcdndd.easypanel.host |
| Certificado | Let's Encrypt (renovación automática) |
| Base de datos | PostgreSQL del panel (`ventas_studio-db`), base `finanza`, 31 tablas |
| Servicios | `ventas_finanzaspersonalespwa` (web) y `ventas_finanzapersonales` (API), en Docker Swarm |
| Acceso local | http://localhost:5180 · `admin@finanza.local` (base con datos de demostración) |

Las claves **no** están en este repositorio ni en este documento. En el servidor:

| Ruta | Contenido | Permisos |
| --- | --- | --- |
| `/root/finanza-api.env` | Variables de la API (JWT, `DATABASE_URL`) | `600` |
| `/root/finanza-db-credentials.txt` | Usuario y contraseña de la base | `600` |
| `/root/finanza-acceso.txt` | Acceso temporal del propietario (**bórrelo al cambiar la contraseña**) | `600` |

---

## 2. Comprobado de verdad (no supuesto)

| Qué | Cómo se comprobó |
| --- | --- |
| Lógica del servidor | 87 pruebas unitarias + 116 de extremo a extremo, todas en verde |
| Lógica del navegador | 107 pruebas unitarias en verde |
| 32 pantallas en 5 tamaños | Batería de navegador (móviles Android/iOS y escritorio) |
| Contabilidad | Libro mayor cuadrado: `integrity` OK y diferencia 0,00 entre panel y libro |
| Correo de datos | Las 40 rutas que usa la interfaz responden; los 12 informes también |
| Acceso | Inicio de sesión, recarga con sesión viva, cookies `secure`/`HttpOnly` |
| Actualizaciones | La app avisa de versión nueva, la aplica y permite forzarla a mano |
| Instalación | Botón discreto en el menú, sólo cuando la app no está instalada |
| Impresión | Hoja de compra limpia (se oculta toda la app al imprimir) |
| Plantillas de compra | 5 plantillas; aplicar dos veces no duplica (17 productos, 6 pasillos) |
| Trabajo sin internet | Recorrido real con el service worker activo y el navegador en modo sin conexión: panel, movimientos, control, cuentas, deudas, presupuestos, obligaciones, traspasos, unidades y ajustes muestran las **cifras guardadas** (con su hora) en lugar de ceros o de una pantalla vacía. Un gasto registrado sin conexión quedó «SIN CONFIRMAR» y se envió solo al volver la red |

---

## 2.1 Trabajar sin internet: cómo funciona (y qué no es)

La app funciona sin conexión **durante 24 h** (ventana configurable en el servidor, `offlineWindowHours`).
No hay una «base de datos local» paralela con la que haya que conciliar nada: hay **caché con fecha**.

| Pieza | Qué hace | Dónde |
| --- | --- | --- |
| Pantallas sin red | El service worker guarda la aplicación (HTML, JS, CSS). Sin conexión la app abre igual. | `dist/sw.js` (sólo archivos propios, nunca respuestas de la API) |
| Lecturas | Cada consulta que el servidor contesta bien se guarda con su hora. Si el servidor no puede contestar (sin red, timeout, 502/503) se devuelve **esa** copia, y la cabecera dice de cuándo es. | `lib/read-cache.ts` + `lib/api.ts` |
| Copia preparada | Con conexión, la app descarga en segundo plano las consultas de las pantallas principales (panel, cuentas, deudas, presupuestos, obligaciones, control, historial, traspasos). Así no hay huecos aunque nunca se haya abierto esa pantalla. Como mucho una vez cada 10 minutos. | `lib/prewarm.ts` |
| Escrituras | Gastos, ingresos, retiros y traspasos se guardan en el dispositivo con un identificador único (idempotencia) y se envían solos al recuperar la conexión. Nada se marca como enviado hasta que el servidor lo confirma. | `lib/sync.ts` + `lib/db.ts` |
| Nunca de la caché | Escrituras (POST/PATCH/DELETE), preparación de cierres (se calcula con saldos del momento), sincronización y listas de compras (tienen su propia copia). **Un error de datos (400) tampoco se tapa con la caché.** | `rutaCacheable()` en `lib/api.ts` |
| Sin copia guardada | No se inventa un cero: la pantalla dice que hace falta una primera conexión. | Panel, Cuentas, Movimientos, Deudas, Presupuestos, Unidades, Traspasos, Ajustes, Organizar |
| Caducidad | Una respuesta guardada deja de usarse a los 7 días, y hay un tope de 400 respuestas guardadas. Al cerrar sesión se borran. | `CADUCIDAD_CACHE_MS`, `MAX_RESPUESTAS` |

Limitaciones conocidas y aceptadas: el cierre del día y la auditoría necesitan conexión (se calculan en el
servidor); la sincronía en vivo entre dos teléfonos sin red sigue pendiente (ver más abajo); si el sistema
operativo borra el almacenamiento del navegador, se pierde la copia (por eso la app pide almacenamiento
persistente al entrar y ofrece exportar los pendientes).


---

## 3. Lo que falta, por prioridad

### A. Suya, hoy (5 minutos)

1. **Cambiar la contraseña** de producción (Ajustes → Seguridad) y borrar `/root/finanza-acceso.txt`.
2. **Ejecutar «Organizar mi dinero»** en producción: hasta que declare cuánto hay y de quién es, la app
   muestra todo a cero (no inventa cifras).
3. **Instalar la app** en el teléfono desde el menú (así las actualizaciones se aplican solas).

### B. Pendientes técnicos, por valor

| # | Qué | Por qué importa | Esfuerzo |
| --- | --- | --- | --- |
| 1 | **Notificaciones push** | Faltan las claves VAPID en producción; sin ellas no se envían avisos. | Bajo |
| 2 | **Dominio propio** | Ahora usa el subdominio del panel. | Bajo (suyo: DNS) |
| 3 | **Precio recordado por producto** | Sugerir el último precio y avisar si subió. | Medio |
| 4 | **Compra en vivo entre dos teléfonos (sin internet)** | Dos personas, misma WiFi, cambios al instante. Requiere WebRTC + emparejar con dos QR; depende de que el router no bloquee el descubrimiento local. **Pendiente de decisión y presupuesto.** | Alto |

### Compras: lo que ya está y cómo funciona

- **Modo tienda** (pestaña en Compras): deja de esperar al servidor para las listas. Todo se guarda en el
  teléfono al instante y se envía solo al desactivarlo (o a las 3 horas). Pensado para cuando en el súper
  la señal va y viene. Fuera de las listas, la app no cambia de comportamiento.
- **Sin señal no se espera**: si el teléfono sabe que no hay red, la petición falla al instante (antes se
  quedaba «cargando» hasta 20 s; ahora el límite es 8 s). Las pantallas siguen con lo último conocido.
- **Repartir la compra**: parte lo que falta por comprar en dos, **por pasillos** (un pasillo nunca se
  parte entre dos personas). Cada parte se puede compartir como texto (WhatsApp, Bluetooth, nota), así
  la otra persona compra sin tener la app ni conexión. No modifica la lista.
- **Dos teléfonos con internet**: la lista abierta se vuelve a leer cada 7 s con la pantalla a la vista,
  así lo que marca uno aparece en el otro sin recargar. Con cambios propios sin enviar, no se refresca
  (esos se mandan primero).
- **Antes de salir de casa**: abra la lista una vez con conexión; queda guardada en el teléfono y en el
  súper se abre sin red.
- **Sin internet**: cada teléfono guarda lo suyo y se junta al volver la conexión. No hay sincronía en
  vivo entre dos teléfonos sin red (ver pendiente 4).

### Descartado por decisión del dueño (20/10/2026)

No se hará, y queda escrito para que nadie lo reabra por iniciativa propia:

- **Inventario / existencias.** «Compras de inventario» seguirá yendo a la cuenta 5100 (costo del
  período). No habrá control de unidades ni costo de lo vendido.
- **Compra a crédito de proveedor.** La cuenta por pagar queda como registro de deuda, sin asiento
  contable propio. **Consecuencia conocida y aceptada:** al pagarla, la cuenta 2100 puede quedar en
  negativo porque el gasto no se reconoce en el momento de la compra. Para esos casos, registre el
  gasto directamente (con la cuenta de dinero que corresponda) en vez de usar la cuenta por pagar.
- **Copias de seguridad automáticas.** No se programan por ahora.

### C. Decisiones que solo usted puede tomar

- **¿Inventario real o costo directo?** Si vende mercancía y necesita saber qué queda en almacén, hace
  falta el módulo; si le basta con «lo que compré este mes es costo», lo actual es correcto.
- **¿IA conectada a un proveedor?** El asistente de compras es local (sin enviar datos fuera). Conectar
  un modelo real exige una clave de API y aceptar que los nombres de productos salgan del dispositivo.
- **¿Usuarios adicionales?** El sistema soporta roles (administrador, operador, solo lectura) por unidad;
  falta decidir quién entra y con qué permiso.

---

## 4. Cómo se actualiza (para no volver a dudar)

```sh
bash deploy/servidor/actualizar.sh
```

Baja el último `master`, reconstruye las dos imágenes, actualiza los servicios sin cortar el acceso y
aplica las migraciones al arrancar. Si algo falla, el sistema anterior sigue en pie; para volver atrás:
`docker service rollback <servicio>`.

**En el teléfono**, a partir de ahora no hay que hacer nada: la app comprueba si hay versión nueva al
abrirse, al volver a ella y cada 30 minutos, y muestra una franja «Hay una versión nueva · Actualizar».
Si alguna vez quiere forzarlo: menú → **Buscar actualización** (y ahí mismo ve la versión y fecha que
está ejecutando ese dispositivo, para compararla con el servidor).

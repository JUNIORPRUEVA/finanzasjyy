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
| 1 | **Compra a crédito de proveedor** | Hoy crear una «cuenta por pagar» no genera asiento: el gasto no se reconoce y la cuenta 2100 queda en negativo al pagarla. Es un hueco contable real. | Medio (migración + regla de asiento) |
| 2 | **Copias de seguridad automáticas** | La base vive en un solo servidor sin respaldo programado. | Bajo |
| 3 | **Inventario** | «Compras de inventario» va a 5100 (costo del período). No hay existencias ni costo de lo vendido. | Alto (módulo) |
| 4 | **Ficha de suplidores** | La deuda guarda a quién se le debe, pero no hay historial por proveedor. | Medio |
| 5 | **Notificaciones push** | Faltan las claves VAPID en producción; sin ellas no se envían avisos. | Bajo |
| 6 | **Dominio propio** | Ahora usa el subdominio del panel. | Bajo (suyo: DNS) |
| 7 | **Plantillas de compra** | «Despensa básica», «limpieza del mes»: añadir 20 productos de un toque. | Bajo |
| 8 | **Precio recordado por producto** | Sugerir el último precio y avisar si subió. | Medio |
| 9 | **Prueba inestable** | `offline.test.ts` falló una vez de forma intermitente (no se ha reproducido). | Bajo |

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

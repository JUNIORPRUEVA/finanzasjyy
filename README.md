# FINANZA

**Control financiero personal y empresarial, sin conexión, para RD$ y en español.**

FINANZA es una aplicación web instalable (PWA) con su propia API y su propia base de datos.
Nació de un requisito concreto:

> Que ningún peso entre o salga sin quedar identificado, y poder conciliar las cuentas todos los días.

Gestiona **cuatro unidades financieras independientes pero consolidables**:

| Código          | Unidad               | Tipo     |
| --------------- | -------------------- | -------- |
| `FULLTECH`      | FULLTECH             | Negocio  |
| `PHYTOEMAGRY`   | PHYTOEMAGRY          | Negocio  |
| `FULLPOS_CLOUD` | FULLPOS CLOUD        | Negocio  |
| `PERSONAL`      | FINANZAS PERSONALES  | Personal |

Moneda **DOP (RD$)**, zona horaria **America/Santo_Domingo**, interfaz en español pensada para móvil.

---

## En 60 segundos

```powershell
# 1. Requisitos: Node 24+, Docker Desktop, PowerShell 5.1+
git clone <este-repositorio> ; cd FINANZAS

# 2. Genera secretos, crea la base de datos e instala dependencias
.\scripts\bootstrap-dev.ps1

# 3. Crea la estructura (catálogo contable, categorías, unidades, tu usuario)
cd apps\api ; npm run db:seed ; cd ..\..

# 4. Arranca todo (base de datos + API + PWA)
.\scripts\dev.ps1
```

- PWA: <http://localhost:5180>
- API: <http://localhost:3010/api/v1/health>
- La contraseña del usuario propietario se muestra **una sola vez** al ejecutar la semilla.

**La aplicación arranca sin ningún importe.** No hay saldos, ni movimientos, ni cifras de ejemplo:
las cifras reales las introduces tú. Si quieres trastear con datos de prueba, hay una unidad
`DEMO` aparte que se crea a propósito y se puede borrar (`npm run seed:demo -- --confirmar-demo`).

---

## Verificación

```powershell
.\scripts\verify.ps1
```

Ejecuta, sin preguntar nada:

| Comprobación          | API                | PWA                |
| --------------------- | ------------------ | ------------------ |
| Tipos (`tsc`)         | ✅                 | ✅                 |
| Lint (ESLint)         | ✅ 0 errores       | ✅ 0 errores       |
| Pruebas               | 82 unitarias + 89 e2e | 54 (formato, sin conexión, sincronización y **sesión**) |
| Compilación producción | ✅ `nest build`   | ✅ `vite build` + service worker |

**225 pruebas automatizadas** de aplicación, más **123 pruebas de navegador** (Playwright) en cinco
tamaños de móvil y escritorio. De ellas, **28 defienden las reglas del dinero**
(`apps/api/test/integridad-financiera.e2e-spec.ts`) y 4 recorren el ciclo completo de 24 h sin
conexión (`apps/web/src/lib/offline.test.ts`).

Las pruebas de extremo a extremo **no escriben en la base de datos de trabajo**: se ejecutan contra
`finanza_test`, que el propio script prepara. Ver `docs/UAT.md`.

Las pruebas de navegador levantan su propia API (3310) y su propia PWA (5280) contra `finanza_test`,
con capturas de pantalla en `docs/capturas/`. Ver `docs/INFORME-MOVIL-Y-SESION.md`.

```powershell
.\scripts\e2e-web.ps1                                  # navegador: todas las pantallas y tamaños
.\scripts\e2e-web.ps1 -Project android-390x844 -Grep sesi   # sólo la sesión
```

### Scripts

| Script | Para qué |
| --- | --- |
| `scripts\bootstrap-dev.ps1` | Genera secretos, crea los `.env`, levanta la base e instala dependencias |
| `scripts\sync-env.ps1` | Propaga los `.env` sin imprimir secretos |
| `scripts\dev.ps1` | Arranca base de datos + API + PWA |
| `scripts\verify.ps1` | Verificación completa de las dos aplicaciones |
| `scripts\generate-vapid.ps1` | Genera las claves de las notificaciones push |
| `scripts\create-test-db.ps1` | Prepara `finanza_test` (aislada): migra y siembra |
| `npm run db:reset-password` (en `apps/api`) | Restablece la contraseña de acceso y la deja en el portapapeles |
| `scripts\e2e-web.ps1` | Pruebas de navegador (Playwright) con capturas de pantalla |
| `scripts\reset-dev-db.ps1` | Deja limpia la base de trabajo (pide escribir `LIMPIAR`) |
| `scripts\backup-db.ps1` | Copia de seguridad comprimida |
| `scripts\restore-test.ps1` | Restaura en una base aparte y comprueba que los asientos cuadran |

---

## Documentación

| Documento                                                    | Contenido                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)                 | Cómo está construido y por qué                                    |
| [docs/INVARIANTES-FINANCIEROS.md](docs/INVARIANTES-FINANCIEROS.md) | Las reglas que el sistema impone para que las cuentas cuadren |
| [docs/MANUAL-USUARIO.md](docs/MANUAL-USUARIO.md)             | Guía de uso diario: registrar, cerrar el día, conciliar           |
| [docs/FUNCIONALIDADES.md](docs/FUNCIONALIDADES.md)           | Qué está hecho, qué no y qué falta                                |
| [docs/SEGURIDAD.md](docs/SEGURIDAD.md)                       | Contraseñas, sesiones, aislamiento entre unidades y datos         |
| [docs/UAT.md](docs/UAT.md)                                   | Pruebas de aceptación: 28 casos con su resultado                  |
| [docs/INFORME-MOVIL-Y-SESION.md](docs/INFORME-MOVIL-Y-SESION.md) | Diseño móvil, sesión persistente y qué NO se ha probado       |
| [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md)                     | Docker, copias de seguridad, restauración y despliegue            |

---

## Estructura

```
FINANZAS/
├── apps/
│   ├── api/            NestJS 12 + TypeScript 6 + Prisma 7 + PostgreSQL 16
│   │   ├── prisma/     30 modelos, 7 migraciones, triggers de integridad contable
│   │   ├── src/        dominio, libro mayor, 18 módulos de funcionalidad
│   │   └── test/       pruebas de extremo a extremo contra PostgreSQL real
│   └── web/            React 19 + Vite 8 + Tailwind 4 + Dexie (IndexedDB)
│       └── src/        pantallas, cola de operaciones sin conexión, service worker
├── docs/               documentación del sistema
├── scripts/            arranque, verificación, copias de seguridad, iconos
└── docker-compose.yml  PostgreSQL aislado (proyecto «finanza», puerto 55432)
```

---

## Aislamiento respecto a otros proyectos

Esta máquina tiene otros proyectos en marcha. FINANZA usa **su propio** nombre de proyecto Docker
(`finanza`), contenedor (`finanza-postgres`), volumen (`finanza_pgdata`), base de datos (`finanza`)
y puerto de host (**55432**, no 5432). Ningún script de este repositorio toca contenedores que no
sean los suyos, y ninguno hace `prune`, `down -v` ni `migrate reset`.

---

## Estado

- **Local:** funciona de extremo a extremo, verificado contra PostgreSQL real.
- **Producción:** no desplegado. No se ha publicado nada en internet ni se ha tocado ninguna base
  de datos de producción de FULLTECH, PHYTOEMAGRY o FULLPOS CLOUD.
- **Notificaciones push:** el servidor tiene claves VAPID y el circuito está probado hasta el envío.
  **La llegada a un dispositivo real no está verificada.**
- **Informe completo:** [docs/INFORME-FINAL.md](docs/INFORME-FINAL.md)

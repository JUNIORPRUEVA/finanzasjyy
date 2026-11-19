# Compras con IA (leer facturas y recibir consejos)

Este documento explica la parte de **Compras** que usa inteligencia artificial: para qué sirve,
cómo se activa, qué se envía fuera del servidor y qué garantías financieras mantiene.

## 1. Qué hace

1. **Leer una factura**: haces una foto (o subes el PDF) de un ticket de supermercado, farmacia o
   ferretería y la IA escribe **todos los productos** con su cantidad y su precio.
2. **Revisar antes de guardar**: la app muestra las líneas detectadas con su importe por línea y el
   total seleccionado. Puedes cambiar el nombre, la cantidad o el precio, y desmarcar lo que no
   quieras. Nada se guarda hasta que pulsas **«Añadir N productos a la lista»**.
3. **Registrar la compra como siempre**: los productos entran en la lista ya marcados como comprados
   y con su precio real. El gasto se registra con **«Registrar gasto en FINANZA»**, que pasa por el
   mismo camino contable que cualquier otro movimiento (partida doble, auditoría, idempotencia).
4. **Sugerencias**: con el historial de compras, el servidor calcula sin IA:
   - gasto total, número de compras y ticket medio;
   - productos que más se repiten;
   - **precios que subieron** (comparando la última compra con la anterior);
   - equilibrio por grupos de alimentos (frutas, verduras, proteínas, lácteos, cereales, legumbres,
     grasas, ultraprocesados) y una puntuación de 0 a 100;
   - consejos concretos de mejora y de aprovechamiento (congelar, conservar, cocinar de más).

   Si la IA está configurada, hay además un botón **«Pedir consejo a la IA»** que redacta una
   explicación y propone una lista para la próxima compra.

## 2. Cómo se activa

Sin clave, **la app funciona igual**: la lectura de factura responde con un aviso claro y el resto de
Compras (listas, productos, precios, gasto, sugerencias por reglas) sigue disponible.

Para activarla, añade al archivo `apps/api/.env`:

```
OPENAI_API_KEY=tu-clave-de-openai
OPENAI_MODEL=gpt-4o-mini
```

Opcionales:

```
# Otro proveedor compatible con la API de OpenAI (Azure OpenAI, servidor local…)
OPENAI_BASE_URL=https://api.openai.com/v1
# Tiempo máximo de espera de la lectura (ms)
OPENAI_TIMEOUT_MS=45000
# Tamaño máximo de la factura (MB)
AI_MAX_INVOICE_MB=8
```

Después, reinicia la API. En el registro de arranque aparece:

```
Lectura de facturas con IA activa (modelo gpt-4o-mini)
```

o bien

```
Lectura de facturas con IA desactivada (falta OPENAI_API_KEY)
```

> La clave **nunca** se registra en los logs ni se devuelve al cliente. El modelo se elige en el
> servidor; el navegador no puede cambiarlo.

### En el servidor (EasyPanel / Docker)

La clave se pone **en el entorno del servicio `api`**, no en la imagen ni en el repositorio:

1. EasyPanel → su proyecto → servicio **api** → pestaña **Environment**.
2. Añada `OPENAI_API_KEY` con su valor (`OPENAI_MODEL` ya tiene `gpt-4o-mini` por defecto).
3. Guarde y **redespliegue** el servicio. En el registro debe aparecer
   `Lectura de facturas con IA activa`.

Los tres `docker-compose` del repositorio (`docker-compose.yml` con perfil `full`,
`docker-compose.produccion.yml` y `docker-compose.produccion.base-existente.yml`) ya pasan
`OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_TIMEOUT_MS` y `AI_MAX_INVOICE_MB` al
contenedor; basta con definirlas en el `.env` del servidor. `deploy/easypanel/env.ejemplo` las lista.

> No hay que contratar ChatGPT. Es una **clave de API** de OpenAI con pago por uso; sin saldo o con
> facturación desactivada, el proveedor responde 429/401 y la app muestra «La clave de IA no es válida
> o caducó».

## 3. Qué se envía y qué no

- **Se envía**: la imagen o el PDF de la factura, únicamente para leerla.
- **No se envía**: movimientos, saldos, cuentas, datos personales ni nada del historial financiero.
- Para los consejos se envía un **resumen agregado** (productos, precios, grupos y porcentajes), no
  las listas completas ni los importes de tus cuentas.
- El servidor llama al proveedor con `store: false` (OpenAI no conserva la petición para entrenar).

## 4. Garantías financieras

- La IA **no crea listas, ni productos, ni gastos**. Solo propone texto que el usuario revisa.
- Si un dato no se lee, se devuelve **vacío** en lugar de inventarlo; la pantalla lo marca para que lo
  completes.
- Si la suma de las líneas no coincide con el total impreso, la pantalla **avisa antes de guardar**.
- El gasto sigue entrando por un único sitio: el servicio de transacciones con su asiento contable.
- Las listas siguen siendo idempotentes: dos pulsaciones (o dos reintentos) no duplican el gasto.

## 5. Endpoints

| Método | Ruta | Para qué |
| --- | --- | --- |
| `GET` | `/shopping-lists/insights?entityId=` | Análisis del historial (sin IA). |
| `POST` | `/shopping-lists/invoice-scan` | Leer una factura (base64 + tipo). No guarda nada. |
| `POST` | `/shopping-lists/advice` | Consejos redactados por la IA a partir del análisis. |

`invoice-scan` comprueba el permiso de **escritura** sobre la unidad (es donde va a terminar la
compra). `insights` y `advice` respetan el alcance de las unidades del usuario.

Errores con mensaje para el usuario:

- `503 AI_NOT_CONFIGURED`: falta la clave en el servidor.
- `502 AI_PROVIDER_ERROR`: el proveedor no respondió, tardó demasiado o devolvió algo ilegible.
- `400 VALIDATION_ERROR`: formato no admitido (solo JPG, PNG, WebP, HEIC y PDF).

## 6. Coste y control

- Cada lectura de factura es **una** llamada al modelo con la imagen. Con `gpt-4o-mini` el coste es de
  fracciones de centavo por factura; con modelos mayores sube.
- Los consejos son una llamada de texto pequeña con el resumen.
- Hay un límite de tamaño (`AI_MAX_INVOICE_MB`) y un tiempo máximo (`OPENAI_TIMEOUT_MS`) para evitar
  facturas enormes o esperas eternas.
- Se puede desactivar en cualquier momento borrando la clave y reiniciando: la app vuelve al modo sin
  IA sin tocar datos.

## 7. Pruebas

- **Unitarias**: `apps/api/src/shopping/shopping-insights.spec.ts` (clasificación de alimentos,
  precios que suben, consejos) y `apps/api/src/ai/invoice-parser.spec.ts` (importes como «RD$
  1,234.50», fechas imposibles, líneas sin precio).
- **e2e del API**: `apps/api/test/compras.e2e-spec.ts` comprueba que el análisis no mueve dinero,
  que el aislamiento por unidad se respeta y que, **sin clave**, la lectura responde `503` con un
  mensaje claro y sin guardar nada.
- **e2e del navegador**: `apps/web/e2e/compras.spec.ts` abre el lector, sube una imagen, comprueba el
  aviso de IA no configurada y, con una respuesta simulada, revisa las líneas, corrige un precio y
  verifica que los productos entran en la lista **sin registrar el gasto**.

## 8. Finalizar una compra (el recorrido completo)

1. En la lista: **«Finalizar compra con factura»**.
2. Se abre la hoja: foto o PDF de la factura (o **«Continuar sin factura»**).
3. La IA escribe los productos con su precio; tú corriges y desmarcas lo que no entre.
4. **«Guardar y registrar el gasto»**: los productos entran en la lista ya comprados, el catálogo
   aprende los precios y se abre el panel para elegir **la cuenta de donde salió el dinero** con el
   importe ya puesto. Se registra el gasto (con su asiento) cuando lo confirmas.

Nada de esto registra dinero por sí solo: el gasto sigue siendo el último paso, el único que mueve
cuentas.

## 9. Catálogo de productos (qué comprar y cómo comprar)

Cada producto comprado deja ficha: **nombre normalizado, unidad, último precio, mínimo, máximo,
cuántas veces se compró, proveedor y última fecha**. Se llena:

- al leer una factura (todas sus líneas con precio);
- al marcar un producto como comprado con su precio.

Se consulta desde **Compras → «Catálogo»** (también desde el enlace de cada compra), en su propia
pantalla con buscador: cada producto muestra su último precio y, al abrirlo, el mínimo, el máximo,
cuántas veces se compró y las **últimas compras con fecha y precio**. Sirve para:

- **autocompletar el precio** al añadir un producto (aparece «Ya lo compró: X · usar»);
- ver de un vistazo si lo que estás pagando está por encima de lo habitual;
- alimentar las sugerencias de compra y el aviso de precios que suben.

Una tabla, `ProductCatalogEntry`, con índice único por unidad y nombre normalizado: «Arroz 5 lb» y
«arroz 5 LB» son la misma ficha. **No** es un documento contable: no mueve dinero ni crea asientos.

## 10. Almacenamiento: dónde quedan las imágenes

Tres cosas distintas, que conviene no mezclar:

1. **La foto que se lee con IA**: viaja del teléfono al servidor en base64 y de ahí al proveedor de IA.
   **No se guarda en el servidor** para leerla: se descarta al terminar. OpenAI no la conserva para
   entrenar (`store: false`).
2. **El catálogo**: vive en PostgreSQL (`ProductCatalogEntry`). Son nombres y precios, no imágenes.
3. **La factura como documento**: si dejas marcado «Guardar la factura en Documentos», el archivo se
   guarda en el servidor de FINANZA, en `ATTACHMENTS_DIR` (por defecto `./.datos-locales/adjuntos`),
   **fuera de cualquier carpeta pública**, con el nombre igual a su hash SHA-256. Se descarga solo con
   permiso sobre esa unidad y queda vinculado al gasto. No hace falta S3, ni Drive, ni ningún servicio
   extra: es una carpeta del propio servidor. Si algún día se quiere respaldo externo, se copia esa
   carpeta.
4. **El borrado**: desvincular un documento no borra el archivo; se conserva para auditoría.

### ¿Hay que contratar ChatGPT?

No. ChatGPT (la web) es un producto aparte y no se usa aquí. Lo que hace falta es una **API key de
OpenAI**, que se paga **por uso**: cada factura leída es una llamada y con `gpt-4o-mini` cuesta
fracciones de centavo. Sin clave, la app funciona igual salvo la lectura y los consejos redactados,
que avisan de que no están activados.


/**
 * CONFIGURACIÓN DE CORS EN UN ÚNICO SITIO
 * =======================================
 * La política de origen cruzado se declara aquí y la usan DOS sitios:
 *   · `main.ts`, al arrancar la API.
 *   · `test/cors-sesion.e2e-spec.ts`, que comprueba que la PWA puede hablar con
 *     la API desde otro origen.
 *
 * Está junto a propósito. Antes cada sitio tenía su propia lista de cabeceras y
 * el resultado fue un fallo real: la PWA empezó a enviar `X-Session-Mode` y
 * `X-CSRF-Token` (parte del diseño de sesión por cookie) y la API no las
 * autorizaba, así que el NAVEGADOR bloqueaba el acceso y en la pantalla se veía
 * como «No se pudo contactar con el servidor».
 *
 * REGLA: si la PWA empieza a enviar una cabecera nueva, se añade aquí y la prueba
 * `cors-sesion.e2e-spec.ts` dirá si falta algo.
 */

/** Orígenes permitidos: lista explícita, o cualquiera mientras se desarrolla. */
export function parseCorsOrigins(): string[] | boolean {
  const raw = process.env.CORS_ORIGINS;
  if (!raw || raw.trim() === '*') {
    // En desarrollo se permite cualquier origen local; en producción se exige lista explícita.
    return process.env.NODE_ENV === 'production' ? false : true;
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Cabeceras propias que la PWA envía y que el navegador pregunta antes
 * («preflight»). Si una NO está en esta lista, el navegador **bloquea la
 * petición**: el servidor nunca llega a enterarse y el usuario ve un error de
 * conexión que no es tal.
 */
export const ALLOWED_REQUEST_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Device-Id',
  'X-Client-Operation-Id',
  // Sesión por cookie: pide la entrega por cookie y protege contra CSRF.
  'X-Session-Mode',
  'X-CSRF-Token',
];

export interface CorsOptions {
  origin: string[] | boolean;
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
  maxAge: number;
}

export function buildCorsOptions(): CorsOptions {
  return {
    origin: parseCorsOrigins(),
    // Necesario para que el navegador envíe y reciba la cookie HttpOnly de sesión.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    // El navegador puede recordar la respuesta de preflight 10 minutos.
    maxAge: 600,
  };
}

import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * TAMAÑO MÁXIMO DE LAS PETICIONES
 * ===============================
 * Una foto de factura viaja como «data URL» en base64: una foto normal de móvil
 * ocupa varios MB y, al codificarla, crece un tercio más. Express pone 100 kB
 * por defecto, así que la petición moría con un 413 antes de llegar a la IA y el
 * usuario sólo veía «error del servidor».
 *
 * El tope se alinea con nginx (`client_max_body_size 12m`) y con el límite de la
 * factura (`AI_MAX_INVOICE_MB`, 8 MB por defecto). El navegador además reduce la
 * imagen antes de enviarla, de modo que en la práctica llegan unos cientos de kB.
 *
 * Vive en un archivo aparte para que las pruebas creen la aplicación igual que
 * `main.ts`: si cada una configura el límite a su manera, se vuelve a colar el
 * mismo fallo sin que nadie lo note.
 */
export function applyBodyLimit(app: NestExpressApplication): void {
  const limit = `${Math.max(12, Number(process.env.AI_MAX_INVOICE_MB ?? 8) + 4)}mb`;
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', { limit, extended: true });
}

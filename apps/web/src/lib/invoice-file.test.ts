import { describe, expect, it } from 'vitest';
import { fileToDataUrl, nombreJpeg, prepareInvoiceFile } from './invoice-file';

describe('preparar la factura antes de enviarla', () => {
  it('renombra a .jpg cuando se recomprime', () => {
    expect(nombreJpeg('factura.png')).toBe('factura.jpg');
    expect(nombreJpeg('IMG_20261119.JPEG')).toBe('IMG_20261119.jpg');
    expect(nombreJpeg('sin-extension')).toBe('sin-extension.jpg');
  });

  it('usa un nombre por defecto si no hay nombre', () => {
    expect(nombreJpeg('')).toBe('factura.jpg');
    expect(nombreJpeg('   ')).toBe('factura.jpg');
  });

  it('lee el archivo como data URL, que es lo que espera la API', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'factura.png', { type: 'image/png' });
    const dataUrl = await fileToDataUrl(file);

    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(20);
  });

  it('un PDF se envía tal cual: no se puede recomprimir en el navegador', async () => {
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], 'factura.pdf', { type: 'application/pdf' });
    await expect(prepareInvoiceFile(pdf)).resolves.toBe(pdf);
  });
});

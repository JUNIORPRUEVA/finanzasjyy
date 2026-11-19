/**
 * PREPARAR UNA FACTURA PARA ENVIARLA
 * ==================================
 * Una foto hecha con el móvil pesa entre 3 y 10 MB. Enviarla tal cual tiene dos
 * problemas: tarda muchísimo con datos móviles y el servidor la rechaza por
 * tamaño. Aquí se reduce a un JPEG razonable (lado mayor 1800 px, calidad 0,82),
 * que sigue siendo perfectamente legible para la IA y suele quedar por debajo de
 * 600 kB.
 *
 * Los PDF no se tocan: no se pueden recomprimir en el navegador y suelen pesar
 * poco. Si algo falla (navegador antiguo, imagen corrupta), se devuelve el
 * archivo original: es mejor intentarlo que impedir la subida.
 */

/** Tope del archivo original antes de comprimir (igual que AI_MAX_INVOICE_MB). */
export const MAX_FACTURA_MB = 8;

/** Lado mayor de la imagen que se envía. Suficiente para leer una factura. */
const LADO_MAXIMO = 1800;
const CALIDAD_JPEG = 0.82;

/** Convierte a un nombre .jpg coherente con el contenido comprimido. */
export function nombreJpeg(nombre: string): string {
  const base = nombre.replace(/\.[^.]+$/, '').trim();
  return `${base === '' ? 'factura' : base}.jpg`;
}

/** Lee el archivo como `data:` URL (lo que espera la API). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

function cargarImagen(file: File): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const imagen = new Image();
    /*
     * Si el navegador ni carga ni rechaza la imagen, la pantalla se quedaría
     * para siempre en «Leyendo la factura…». Pasado un tiempo prudencial se
     * abandona y se envía el archivo original.
     */
    const limite = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      reject(new Error('La imagen tardó demasiado en abrirse'));
    }, 6000);
    imagen.onload = () => {
      window.clearTimeout(limite);
      URL.revokeObjectURL(url);
      resolve(imagen);
    };
    imagen.onerror = () => {
      window.clearTimeout(limite);
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo abrir la imagen'));
    };
    imagen.src = url;
  });
}

/**
 * Reduce la foto antes de subirla. Devuelve el original si no es una imagen, si
 * ya es pequeño o si el navegador no permite hacerlo.
 */
export async function prepareInvoiceFile(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) {
    return file;
  }

  try {
    const imagen = await cargarImagen(file);
    const escala = Math.min(1, LADO_MAXIMO / Math.max(imagen.width, imagen.height));
    const ancho = Math.max(1, Math.round(imagen.width * escala));
    const alto = Math.max(1, Math.round(imagen.height * escala));

    const canvas = document.createElement('canvas');
    canvas.width = ancho;
    canvas.height = alto;
    const contexto = canvas.getContext('2d');
    if (!contexto) {
      return file;
    }
    contexto.drawImage(imagen, 0, 0, ancho, alto);

    const reducido = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', CALIDAD_JPEG);
    });

    // Si no se pudo comprimir o el resultado no mejora, se queda el original.
    if (!reducido || reducido.size === 0 || reducido.size >= file.size) {
      return file;
    }

    return new File([reducido], nombreJpeg(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

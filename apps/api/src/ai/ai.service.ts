import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError } from '../common/errors.js';
import { InvoiceParseError, parseInvoiceDraft, type InvoiceDraft } from './invoice-parser.js';

/**
 * ASISTENTE DE COMPRAS (IA)
 * =========================
 * Dos tareas concretas, ninguna toca el dinero:
 *   1. LEER UNA FACTURA: imagen o PDF → lista de productos con cantidad y precio.
 *   2. PROPONER CONSEJOS a partir de los datos de compras que ya existen.
 *
 * Reglas de esta capa:
 *  · Sin `OPENAI_API_KEY` no se inventa nada: `isConfigured()` es false y la
 *    pantalla ofrece el registro manual. Nada más se rompe.
 *  · La clave y el contenido de la factura NUNCA se escriben en los logs.
 *  · La respuesta del modelo se valida y se normaliza antes de devolverla; si
 *    viene mal, se informa del motivo y no se guarda nada.
 *  · Nada se escribe en la base de datos aquí: el usuario revisa y confirma.
 *
 * Proveedor: cualquier API compatible con OpenAI mediante `OPENAI_BASE_URL`
 * (Azure OpenAI, servidores locales compatibles, etc.).
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

/** Tipos que se aceptan para leer (los mismos que en Adjuntos). */
const INVOICE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);

export class AiNotConfiguredError extends DomainError {
  constructor() {
    super(
      'La lectura de facturas con IA no está configurada. Agregue OPENAI_API_KEY en el servidor.',
      'AI_NOT_CONFIGURED',
      503,
    );
  }
}

export class AiProviderError extends DomainError {
  constructor(message: string) {
    super(message, 'AI_PROVIDER_ERROR', 502);
  }
}

export interface AdviceSuggestion {
  title: string;
  tips: string[];
  suggestedList: Array<{ name: string; reason: string }>;
}

/** Esquema estricto de una factura. `strict` obliga al modelo a cumplirlo. */
const INVOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier', 'date', 'currency', 'total', 'taxAmount', 'lines'],
  properties: {
    supplier: { type: ['string', 'null'], description: 'Nombre del comercio tal como aparece en la factura' },
    date: { type: ['string', 'null'], description: 'Fecha de la factura en formato YYYY-MM-DD' },
    currency: { type: ['string', 'null'], description: 'Moneda ISO de 3 letras (DOP, USD…) si se deduce' },
    total: { type: ['string', 'null'], description: 'Total pagado, solo dígitos y punto decimal' },
    taxAmount: { type: ['string', 'null'], description: 'Impuesto (ITBIS/IVA) si aparece, solo dígitos y punto' },
    lines: {
      type: 'array',
      description: 'Todos los productos de la factura, uno por línea',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'quantity', 'unit', 'unitPrice', 'total', 'category'],
        properties: {
          name: { type: 'string', description: 'Nombre del producto, sin códigos internos' },
          quantity: { type: 'string', description: 'Cantidad, solo dígitos y punto decimal. 1 si no se indica' },
          unit: { type: ['string', 'null'], description: 'Unidad: unidad, kg, lb, litro, caja…' },
          unitPrice: { type: ['string', 'null'], description: 'Precio por unidad, solo dígitos y punto decimal' },
          total: { type: ['string', 'null'], description: 'Importe de la línea, solo dígitos y punto decimal' },
          category: {
            type: ['string', 'null'],
            description:
              'Categoría de gasto del producto: Alimentación, Aseo y limpieza, Combustible, Salud, Hogar, Otros gastos',
          },
        },
      },
    },
  },
} as const;

const ADVICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'tips', 'suggestedList'],
  properties: {
    title: { type: 'string', description: 'Título corto (máximo 8 palabras)' },
    tips: { type: 'array', items: { type: 'string' }, description: 'Entre 3 y 5 consejos concretos' },
    suggestedList: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'reason'],
        properties: {
          name: { type: 'string' },
          reason: { type: 'string', description: 'Por qué conviene comprarlo (una frase corta)' },
        },
      },
    },
  },
} as const;

const INVOICE_INSTRUCTIONS = `Eres un asistente que digitaliza facturas de compra (supermercado, farmacia, ferretería) para una app de finanzas personales en República Dominicana.

Reglas:
- Devuelve TODOS los renglones de productos de la factura, en el mismo orden.
- Copia el nombre del producto limpio, sin códigos de barras ni abreviaturas internas.
- Los importes van como texto con punto decimal y sin símbolo de moneda ("1250.50"). Nunca uses coma decimal.
- Si un dato no se lee con claridad, devuelve null. NUNCA inventes precios ni cantidades.
- Si la factura trae descuentos o impuestos como línea aparte, inclúyelos con su nombre real.
- La moneda habitual es DOP; usa la que aparezca impresa si se distingue.
- No añadas comentarios: sólo el JSON pedido.`;

const ADVICE_INSTRUCTIONS = `Eres un asistente de compras para una familia en República Dominicana. Recibes un resumen REAL de sus compras (productos, precios, grupos de alimentos y gasto).

Reglas:
- Habla en español, cercano y directo, sin regañar.
- No des consejo médico ni afirmes propiedades curativas de alimentos.
- Los consejos deben apoyarse en los datos recibidos (repeticiones, subidas de precio, grupos que faltan, proporción de ultraprocesados).
- Incluye aprovechamiento real: congelar, conservar, cocinar de más, reutilizar sobras.
- La lista sugerida debe tener entre 3 y 8 productos que encajen con lo que ya compra y con lo que le falta.
- No inventes cifras que no estén en el resumen.`;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxInvoiceBytes: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = (config.get<string>('OPENAI_API_KEY') ?? '').trim();
    this.model = (config.get<string>('OPENAI_MODEL') ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    this.baseUrl = ((config.get<string>('OPENAI_BASE_URL') ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = Number(config.get<string>('OPENAI_TIMEOUT_MS') ?? 45_000) || 45_000;
    this.maxInvoiceBytes = (Number(config.get<string>('AI_MAX_INVOICE_MB') ?? 8) || 8) * 1024 * 1024;

    if (this.apiKey.length === 0) {
      this.logger.log('Lectura de facturas con IA desactivada (falta OPENAI_API_KEY)');
    } else {
      this.logger.log(`Lectura de facturas con IA activa (modelo ${this.model})`);
    }
  }

  /** ¿Hay clave configurada? La pantalla lo usa para mostrar u ocultar el botón. */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Modelo en uso, para mostrarlo en la pantalla (nunca la clave). */
  modelName(): string | null {
    return this.isConfigured() ? this.model : null;
  }

  /**
   * Lee una factura y devuelve las líneas normalizadas. NO guarda nada.
   * Lanza `AiNotConfiguredError` si falta la clave y `AiProviderError` si el
   * proveedor falla o responde algo que no se entiende.
   */
  async readInvoice(input: { filename: string; mimeType: string; contentBase64: string }): Promise<{
    invoice: InvoiceDraft;
    model: string;
  }> {
    if (!this.isConfigured()) {
      throw new AiNotConfiguredError();
    }

    const mimeType = (input.mimeType ?? '').toLowerCase();
    if (!INVOICE_TYPES.has(mimeType)) {
      throw new AiProviderError('Formato no admitido para leer la factura. Use una foto (JPG, PNG, WebP) o un PDF.');
    }

    const base64 = input.contentBase64.includes(',')
      ? input.contentBase64.slice(input.contentBase64.indexOf(',') + 1)
      : input.contentBase64;

    const bytes = Math.floor((base64.length * 3) / 4);
    if (base64.length === 0) {
      throw new AiProviderError('El archivo llegó vacío');
    }
    if (bytes > this.maxInvoiceBytes) {
      throw new AiProviderError(
        `La factura supera el máximo permitido (${Math.round(this.maxInvoiceBytes / 1024 / 1024)} MB).`,
      );
    }

    const dataUrl = `data:${mimeType};base64,${base64}`;
    const attachment =
      mimeType === 'application/pdf'
        ? { type: 'file' as const, file: { filename: input.filename || 'factura.pdf', file_data: dataUrl } }
        : { type: 'image_url' as const, image_url: { url: dataUrl, detail: 'high' as const } };

    const raw = await this.callJson({
      schemaName: 'factura_compra',
      schema: INVOICE_SCHEMA as unknown as Record<string, unknown>,
      instructions: INVOICE_INSTRUCTIONS,
      content: [{ type: 'text', text: 'Lee esta factura y devuelve todos sus productos con precios.' }, attachment],
    });

    try {
      return { invoice: parseInvoiceDraft(raw), model: this.model };
    } catch (error) {
      if (error instanceof InvoiceParseError) {
        throw new AiProviderError(`La IA no pudo leer los productos: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Pide consejos a partir del resumen ya calculado en el servidor. Si algo
   * falla, la pantalla conserva los consejos por reglas: esto sólo los mejora.
   */
  async suggestAdvice(summary: unknown): Promise<{ advice: AdviceSuggestion; model: string }> {
    if (!this.isConfigured()) {
      throw new AiNotConfiguredError();
    }

    const raw = await this.callJson({
      schemaName: 'consejos_compra',
      schema: ADVICE_SCHEMA as unknown as Record<string, unknown>,
      instructions: ADVICE_INSTRUCTIONS,
      content: [
        {
          type: 'text',
          text: `Resumen real de compras (JSON):\n${JSON.stringify(summary).slice(0, 12_000)}`,
        },
      ],
    });

    const source = raw as Record<string, unknown>;
    const tips = Array.isArray(source.tips)
      ? source.tips.filter((tip): tip is string => typeof tip === 'string' && tip.trim().length > 0).map((tip) => tip.trim().slice(0, 400))
      : [];
    const list = Array.isArray(source.suggestedList)
      ? source.suggestedList
          .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
          .map((row) => ({
            name: String(row.name ?? '').trim().slice(0, 120),
            reason: String(row.reason ?? '').trim().slice(0, 200),
          }))
          .filter((row) => row.name.length > 0)
      : [];

    if (tips.length === 0) {
      throw new AiProviderError('La IA no devolvió consejos utilizables');
    }

    return {
      advice: {
        title: String(source.title ?? 'Ideas para la próxima compra').trim().slice(0, 120),
        tips: tips.slice(0, 6),
        suggestedList: list.slice(0, 10),
      },
      model: this.model,
    };
  }

  /**
   * Llamada única al proveedor con salida JSON estricta. Un reintento corto
   * para 429/5xx: son fallos transitorios y no tiene sentido molestar al usuario.
   */
  private async callJson(input: {
    schemaName: string;
    schema: Record<string, unknown>;
    instructions: string;
    content: Array<Record<string, unknown>>;
  }): Promise<unknown> {
    const body = {
      model: this.model,
      temperature: 0,
      store: false,
      messages: [
        { role: 'system', content: input.instructions },
        { role: 'user', content: input.content },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: input.schemaName, strict: true, schema: input.schema },
      },
    };

    let lastError: string | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.ok) {
          const payload = (await response.json()) as {
            choices?: Array<{ message?: { content?: string | null } }>;
          };
          const text = payload.choices?.[0]?.message?.content ?? '';
          if (typeof text !== 'string' || text.trim().length === 0) {
            throw new AiProviderError('El proveedor de IA devolvió una respuesta vacía');
          }
          try {
            return JSON.parse(text);
          } catch {
            throw new AiProviderError('El proveedor de IA no devolvió un JSON válido');
          }
        }

        // 4xx salvo 429: el problema es de la petición, no se reintenta.
        if (response.status !== 429 && response.status < 500) {
          const detail = await response.text().catch(() => '');
          this.logger.warn(`Proveedor de IA rechazó la petición (${response.status})`);
          throw new AiProviderError(
            response.status === 401
              ? 'La clave de IA no es válida o caducó. Revise OPENAI_API_KEY en el servidor.'
              : response.status === 404
                ? 'El modelo configurado no existe o no admite imágenes. Revise OPENAI_MODEL.'
                : `El proveedor de IA rechazó la petición (${response.status}). ${detail.slice(0, 160)}`.trim(),
          );
        }

        lastError = `estado ${response.status}`;
      } catch (error) {
        if (error instanceof AiProviderError) {
          throw error;
        }
        if (error instanceof Error && error.name === 'TimeoutError') {
          lastError = 'tiempo de espera agotado';
        } else {
          lastError = error instanceof Error ? error.message : 'error de red';
        }
      }

      // Espera corta antes del único reintento.
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    this.logger.warn(`Proveedor de IA no disponible: ${lastError ?? 'sin detalle'}`);
    throw new AiProviderError(
      lastError === 'tiempo de espera agotado'
        ? 'La IA tardó demasiado en responder. Inténtelo de nuevo con una foto más pequeña.'
        : 'No se pudo hablar con el proveedor de IA. Inténtelo de nuevo en un momento.',
    );
  }
}

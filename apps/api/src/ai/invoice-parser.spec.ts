import { InvoiceParseError, parseInvoiceDraft, toDateText, toMoneyText, toQuantityText } from './invoice-parser.js';

/**
 * NORMALIZACIÓN DE FACTURAS LEÍDAS POR IA
 * ======================================
 * Los modelos devuelven números, comas decimales, símbolos de moneda y fechas
 * como les parece. Lo que se comprueba aquí es que nada de eso llegue a la
 * pantalla como un importe raro y que, si falta un dato, quede vacío en lugar de
 * inventado.
 */

describe('importes', () => {
  it('acepta números y los deja con dos decimales', () => {
    expect(toMoneyText(1250.5)).toBe('1250.50');
    expect(toMoneyText(0)).toBe('0.00');
  });

  it('entiende los formatos que salen en una factura real', () => {
    expect(toMoneyText('RD$ 1,234.50')).toBe('1234.50');
    expect(toMoneyText('1.234,50')).toBe('1234.50');
    expect(toMoneyText('  95 ')).toBe('95.00');
    expect(toMoneyText('1,234')).toBe('1234.00');
  });

  it('devuelve null cuando no hay un número', () => {
    expect(toMoneyText('')).toBeNull();
    expect(toMoneyText('n/a')).toBeNull();
    expect(toMoneyText(null)).toBeNull();
    expect(toMoneyText(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('cantidades y fechas', () => {
  it('normaliza cantidades y cae en 1 cuando no son válidas', () => {
    expect(toQuantityText('1,5')).toBe('1.5');
    expect(toQuantityText(2)).toBe('2');
    expect(toQuantityText(0)).toBe('1');
    expect(toQuantityText('-3')).toBe('1');
    expect(toQuantityText(null)).toBe('1');
  });

  it('sólo acepta fechas ISO que existan de verdad', () => {
    expect(toDateText('2026-11-19')).toBe('2026-11-19');
    expect(toDateText('2026-02-30')).toBeNull();
    expect(toDateText('19/11/2026')).toBeNull();
  });
});

describe('factura completa', () => {
  const facturaDelModelo = {
    supplier: 'Supermercado Nacional',
    date: '2026-11-18',
    currency: 'dop',
    total: '2,300.00',
    taxAmount: '317.24',
    lines: [
      { name: 'Arroz 5 lb', quantity: '2', unit: 'unidad', unitPrice: '250', total: '500', category: 'Alimentación' },
      { name: 'Pechuga de pollo', quantity: '3', unit: 'lb', unitPrice: '300', total: null, category: 'Alimentación' },
      { name: 'Detergente', quantity: '1', unit: 'unidad', unitPrice: null, total: null, category: 'Aseo y limpieza' },
    ],
  };

  it('normaliza líneas, calcula el total que falta y avisa de lo que no trae precio', () => {
    const draft = parseInvoiceDraft(facturaDelModelo);

    expect(draft.supplier).toBe('Supermercado Nacional');
    expect(draft.date).toBe('2026-11-18');
    expect(draft.currency).toBe('DOP');
    expect(draft.total).toBe('2300.00');
    expect(draft.lines).toHaveLength(3);

    // La línea sin total se calcula con cantidad × precio unitario.
    expect(draft.lines[1]).toMatchObject({ name: 'Pechuga de pollo', quantity: '3', total: '900.00' });

    // La línea sin precio se queda vacía y se avisa: no se inventa nada.
    expect(draft.lines[2]).toMatchObject({ name: 'Detergente', unitPrice: null, total: null, suggestedCategory: 'Aseo y limpieza' });
    expect(draft.warnings.some((warning) => warning.includes('Detergente'))).toBe(true);
  });

  it('avisa si la suma de las líneas no coincide con el total impreso', () => {
    const draft = parseInvoiceDraft(facturaDelModelo);
    expect(draft.warnings.some((warning) => /no coincide con el total/i.test(warning))).toBe(true);
  });

  it('acepta las claves en español y descarta filas sin nombre', () => {
    const draft = parseInvoiceDraft({
      proveedor: 'Colmado',
      fecha: '2026-11-10',
      lineas: [
        { nombre: 'Habichuelas', cantidad: 2, precioUnitario: 80 },
        { nombre: '   ', cantidad: 1, precioUnitario: 10 },
        { descripcion: 'Aceite', precio: 210 },
      ],
    });

    expect(draft.supplier).toBe('Colmado');
    expect(draft.lines.map((line) => line.name)).toEqual(['Habichuelas', 'Aceite']);
    expect(draft.lines[0]?.total).toBe('160.00');
  });

  it('falla con un mensaje claro cuando no hay productos', () => {
    expect(() => parseInvoiceDraft({ lines: [] })).toThrow(InvoiceParseError);
    expect(() => parseInvoiceDraft({ lines: [] })).toThrow(/no se reconoció ningún producto/i);
    expect(() => parseInvoiceDraft(null)).toThrow(InvoiceParseError);
  });
});

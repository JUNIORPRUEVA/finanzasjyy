/**
 * REVISIÓN DE LAS LÍNEAS DE UNA FACTURA
 * =====================================
 * La IA propone y la persona decide. Este bloque es el mismo en los dos sitios
 * donde se lee una factura (dentro de una compra y al crear una compra nueva),
 * para que corregir un producto se comporte igual en ambos.
 *
 * Cada línea se puede incluir o no, renombrar, cambiar la cantidad y corregir el
 * precio. Debajo de la cantidad y el precio se muestra el importe de esa línea,
 * que es lo que de verdad va a entrar en la compra.
 */

export interface FacturaLinea {
  name: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  include: boolean;
}

interface Props {
  lineas: FacturaLinea[];
  onChange: (lineas: FacturaLinea[]) => void;
}

export function FacturaLineasEditor({ lineas, onChange }: Props) {
  const actualizar = (index: number, cambio: Partial<FacturaLinea>) => {
    const siguiente = [...lineas];
    siguiente[index] = { ...siguiente[index], ...cambio };
    onChange(siguiente);
  };

  return (
    <div className="space-y-2">
      {lineas.map((line, index) => (
        <div key={`${line.name}-${index}`} className="border border-border-soft p-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={line.include}
              onChange={(event) => actualizar(index, { include: event.target.checked })}
              aria-label={`Incluir ${line.name}`}
              className="h-5 w-5 shrink-0 accent-[var(--color-brand)]"
            />
            <input
              value={line.name}
              onChange={(event) => actualizar(index, { name: event.target.value })}
              aria-label={`Producto ${index + 1}`}
              className="min-w-0 flex-1 border border-border-soft bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-brand"
            />
          </div>
          <div className="mt-1.5 flex items-center gap-2 pl-7">
            <div className="w-20 shrink-0">
              <label className="block text-[0.65rem] uppercase tracking-wide text-faint">
                Cantidad
                <input
                  value={line.quantity}
                  inputMode="decimal"
                  aria-label={`Cantidad ${index + 1}`}
                  onChange={(event) => actualizar(index, { quantity: event.target.value })}
                  className="mt-0.5 w-full border border-border-soft bg-surface-2 px-2 py-1 text-sm text-ink outline-none focus:border-brand"
                />
              </label>
            </div>
            <div className="min-w-0 flex-1">
              <label className="block text-[0.65rem] uppercase tracking-wide text-faint">
                Precio por unidad
                <input
                  value={line.unitPrice}
                  inputMode="decimal"
                  aria-label={`Precio ${index + 1}`}
                  placeholder="sin precio"
                  onChange={(event) => actualizar(index, { unitPrice: event.target.value })}
                  className="mt-0.5 w-full border border-border-soft bg-surface-2 px-2 py-1 text-sm text-ink outline-none focus:border-brand"
                />
              </label>
              {line.quantity !== '' && line.unitPrice !== '' && Number(line.quantity) > 0 && Number(line.unitPrice) > 0 ? (
                <p className="mt-0.5 text-[0.68rem] text-faint">
                  = {(Number(line.quantity) * Number(line.unitPrice)).toFixed(2)}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

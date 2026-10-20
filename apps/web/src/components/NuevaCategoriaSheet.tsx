import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Field, Notice, Sheet } from './ui';
import { toast } from './Toast';

/**
 * CREAR LA CATEGORÍA QUE FALTA, SIN SALIR DE DONDE ESTÁ
 * ====================================================
 * Pasa a menudo: se está apuntando un gasto y la categoría que se necesita no
 * está en la lista. Antes había que salir, ir a Ajustes, crearla y volver a
 * empezar el movimiento.
 *
 * Aquí se crea en el momento, con el nombre que se escriba, y queda seleccionada
 * en el formulario que la pidió. Se usa igual al registrar un movimiento y al
 * pagar una compra.
 */

/** El enlace «+ Nueva» que va al lado del nombre del campo. */
export function BotonNuevaCategoria({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-lg px-1 py-0.5 text-xs font-semibold text-brand transition hover:bg-brand-soft"
    >
      + Nueva
    </button>
  );
}

export function NuevaCategoriaSheet({
  abierto,
  kind,
  entityId,
  onCerrar,
  onCreada,
}: {
  abierto: boolean;
  kind: 'INCOME' | 'EXPENSE';
  entityId?: string;
  onCerrar: () => void;
  onCreada: (categoria: { id: string; name: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (texto: string) =>
      api.post<{ id: string; name: string }>('/categories', {
        name: texto.trim(),
        kind,
        ...(entityId ? { entityId } : {}),
      }),
    onSuccess: (creada) => {
      setNombre('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
      toast.success(`Categoría «${creada.name}» creada y seleccionada.`);
      onCreada(creada);
    },
    onError: (fallo) => {
      setError(fallo instanceof ApiError ? fallo.message : 'No se pudo crear la categoría.');
    },
  });

  const cerrar = () => {
    setNombre('');
    setError(null);
    onCerrar();
  };

  if (!abierto) {
    return null;
  }

  // En un portal a `body`: así no queda un formulario dentro de otro.
  return createPortal(
    <Sheet
      open
      onClose={cerrar}
      title={kind === 'INCOME' ? 'Nueva categoría de ingreso' : 'Nueva categoría de gasto'}
    >
      <form
        className="space-y-3 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (nombre.trim().length >= 2 && !mutation.isPending) {
            mutation.mutate(nombre);
          }
        }}
      >
        <Field
          label="Nombre de la categoría"
          value={nombre}
          onChange={setNombre}
          placeholder={kind === 'INCOME' ? 'Ej.: Venta de accesorios' : 'Ej.: Comida del perro'}
          enterKeyHint="done"
        />
        {error ? <Notice tone="negative">{error}</Notice> : null}
        <p className="text-xs leading-snug text-faint">
          Se creará como categoría de {kind === 'INCOME' ? 'ingreso' : 'gasto'} y quedará seleccionada. Podrá
          renombrarla o desactivarla luego en Ajustes.
        </p>
        <Button type="submit" className="w-full" size="lg" disabled={nombre.trim().length < 2 || mutation.isPending}>
          {mutation.isPending ? 'Creando…' : 'Crear y usar'}
        </Button>
      </form>
    </Sheet>,
    document.body,
  );
}

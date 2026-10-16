import type { QueryClient } from '@tanstack/react-query';
import { upsertCachedAccounts, upsertCachedCategories } from './db';

/**
 * ESPEJO LOCAL DE LOS DATOS QUE SE USAN SIN CONEXIÓN
 * --------------------------------------------------
 * FINANZA promete que se puede registrar un movimiento sin conexión. Para eso no
 * basta con tener la pantalla: hacen falta las CUENTAS y las CATEGORÍAS en el
 * dispositivo. Si no están, el usuario abre «Registrar», encuentra la lista
 * vacía y no puede anotar nada justo cuando no tiene datos móviles.
 *
 * Esta pieza escucha las respuestas correctas de la API y guarda una copia local:
 *  · `accounts`    → cuentas con su saldo (para poder elegir dónde entra o sale)
 *  · `categories`  → categorías de ingreso y gasto
 *
 * Se guarda SÓLO lo que el servidor ha confirmado, se añade sin borrar lo demás y
 * NUNCA se inventan saldos: si una cuenta no se ha descargado, no aparece.
 */

type ApiAccount = {
  id: string;
  entityId: string;
  name: string;
  type: string;
  currency?: string;
  isCreditCard?: boolean;
  balance?: string;
};

type ApiCategory = {
  id: string;
  name: string;
  kind: 'INCOME' | 'EXPENSE';
  defaultLedgerCode?: string | null;
  entityId?: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isApiAccount = (value: unknown): value is ApiAccount =>
  isRecord(value) && typeof value.id === 'string' && typeof value.entityId === 'string' && typeof value.name === 'string';

const isApiCategory = (value: unknown): value is ApiCategory =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  (value.kind === 'INCOME' || value.kind === 'EXPENSE');

/**
 * Empieza a escuchar. Devuelve la función para dejar de escuchar (se usa al
 * desmontar, sobre todo en las pruebas).
 */
export function mirrorApiDataToLocalCache(queryClient: QueryClient): () => void {
  const cache = queryClient.getQueryCache();

  return cache.subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') {
      return;
    }

    const key = event.query.queryKey;
    const head = Array.isArray(key) && key.length > 0 ? String(key[0]) : '';
    const data = event.query.state.data;

    if (head === 'accounts') {
      // La respuesta puede venir como lista o envuelta en `{ data: [...] }`.
      const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.data) ? data.data : [];
      const accounts = rows.filter(isApiAccount).map((account) => ({
        id: account.id,
        entityId: account.entityId,
        name: account.name,
        type: account.type,
        currency: account.currency ?? 'DOP',
        isCreditCard: account.isCreditCard ?? false,
        // El saldo sólo se guarda si viene del servidor; nunca se estima.
        balance: account.balance ?? '0.00',
        cachedAt: new Date().toISOString(),
      }));
      if (accounts.length > 0) {
        void upsertCachedAccounts(accounts);
      }
      return;
    }

    if (head === 'categories') {
      const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.data) ? data.data : [];
      const categories = rows.filter(isApiCategory).map((category) => ({
        id: category.id,
        name: category.name,
        kind: category.kind,
        defaultLedgerCode: category.defaultLedgerCode ?? null,
        entityId: category.entityId ?? null,
        cachedAt: new Date().toISOString(),
      }));
      if (categories.length > 0) {
        void upsertCachedCategories(categories);
      }
    }
  });
}

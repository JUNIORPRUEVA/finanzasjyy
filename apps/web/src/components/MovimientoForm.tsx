import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, OfflineError } from '../lib/api';
import { getCachedAccounts, getCachedCategories } from '../lib/db';
import { canOperateOffline, submitOrQueue } from '../lib/sync';
import { useAuth } from '../store/auth';
import { Button, Field, MoneyInput, Notice, Select, Tabs } from './ui';
import { IconChevronDown } from './icons';
import { todayBusinessDate } from '../lib/format';

/**
 * FORMULARIO DE UN MOVIMIENTO
 * ===========================
 * Es el corazón de la aplicación: apuntar un gasto o un ingreso tiene que costar
 * segundos y no requerir pensar. Por eso:
 *
 *  · Lo único obligatorio son tres cosas: importe, descripción y cuenta. Todo lo
 *    demás tiene un valor razonable puesto de antemano (hoy, efectivo, primera
 *    cuenta de la unidad).
 *  · Los campos que casi nunca se cambian (fecha, forma de pago, unidad) viven
 *    detrás de «Más opciones», cerrados. Antes estaban todos a la vista y el
 *    formulario parecía más trabajo de lo que es.
 *  · Se quitaron los textos de ayuda largos: un formulario con seis párrafos de
 *    explicación no se lee, se abandona.
 *
 * El mismo formulario se usa dentro del panel del botón «+» y en la pantalla
 * `/registrar` (enlaces directos y marcadores), para que no haya dos versiones
 * que se comporten distinto.
 */

export type EntryKind = 'INCOME' | 'EXPENSE' | 'OWNER_WITHDRAWAL' | 'OWNER_CONTRIBUTION' | 'ADJUSTMENT';

export const KIND_TABS: Array<{ id: EntryKind; label: string }> = [
  { id: 'INCOME', label: 'Ingreso' },
  { id: 'EXPENSE', label: 'Gasto' },
  { id: 'OWNER_WITHDRAWAL', label: 'Retiro' },
  { id: 'OWNER_CONTRIBUTION', label: 'Aporte' },
  { id: 'ADJUSTMENT', label: 'Ajuste' },
];

/** Los cuatro movimientos del día a día: sin el ajuste contable. */
export const KINDS_DIARIOS: EntryKind[] = ['INCOME', 'EXPENSE', 'OWNER_WITHDRAWAL', 'OWNER_CONTRIBUTION'];

const METHOD_OPTIONS = ['EFECTIVO', 'TRANSFERENCIA', 'TARJETA', 'BIZUM', 'CHEQUE', 'DEPOSITO', 'CREDITO', 'OTRO'];

const PREGUNTA_IMPORTE: Record<EntryKind, string> = {
  INCOME: '¿Cuánto entró?',
  EXPENSE: '¿Cuánto salió?',
  OWNER_WITHDRAWAL: '¿Cuánto retiró?',
  OWNER_CONTRIBUTION: '¿Cuánto aportó?',
  ADJUSTMENT: 'Importe del ajuste',
};

const EJEMPLO_DESCRIPCION: Record<EntryKind, string> = {
  INCOME: 'Ej.: Venta del día',
  EXPENSE: 'Ej.: Combustible',
  OWNER_WITHDRAWAL: 'Ej.: Retiro para la casa',
  OWNER_CONTRIBUTION: 'Ej.: Aporte de capital',
  ADJUSTMENT: 'Ej.: Faltante en el cierre',
};

interface Account {
  id: string;
  entityId: string;
  name: string;
  type: string;
  isCreditCard: boolean;
  balance: string;
}

interface Category {
  id: string;
  name: string;
  kind: 'INCOME' | 'EXPENSE';
}

export interface MovimientoFormProps {
  /** Qué se está registrando al abrirlo. */
  initialKind: EntryKind;
  /** Unidad con la que empieza (enlaces directos con `?entityId=`). */
  initialEntityId?: string;
  /** Qué se puede elegir. En el panel del «+» son los cuatro del día a día. */
  kinds?: EntryKind[];
  /** Se llama al terminar bien: el panel que lo contiene se cierra. */
  onSaved?: () => void;
}

export function MovimientoForm({
  initialKind,
  initialEntityId,
  kinds = KINDS_DIARIOS,
  onSaved,
}: MovimientoFormProps) {
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<EntryKind>(initialKind);
  const [entityId, setEntityId] = useState(initialEntityId || entities[0]?.id || '');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [businessDate, setBusinessDate] = useState(todayBusinessDate(preferences?.timezone));
  const [method, setMethod] = useState('EFECTIVO');
  const [ajusteCargo, setAjusteCargo] = useState('');
  const [ajusteAbono, setAjusteAbono] = useState('');
  const [ajusteMotivo, setAjusteMotivo] = useState('');
  const [masOpciones, setMasOpciones] = useState(false);
  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);

  const [cuentasLocales, setCuentasLocales] = useState<Account[]>([]);
  const [categoriasLocales, setCategoriasLocales] = useState<Category[]>([]);
  const [sinConexion, setSinConexion] = useState<{ allowed: boolean; reason: string } | null>(null);

  // Si el panel abre directamente «Retiro» y luego se cambia a «Gasto», el
  // formulario tiene que reflejarlo: es el mismo estado, no una copia.
  useEffect(() => {
    setKind(initialKind);
  }, [initialKind]);

  const accountsQuery = useQuery<Account[]>({
    queryKey: ['accounts', entityId],
    queryFn: () => api.get<Account[]>(`/accounts?entityId=${entityId}`),
    enabled: Boolean(entityId),
  });

  const categoriesQuery = useQuery<Category[]>({
    queryKey: ['categories', entityId, kind],
    queryFn: () =>
      api.get<Category[]>(
        `/categories?entityId=${entityId}&kind=${kind === 'INCOME' ? 'INCOME' : kind === 'EXPENSE' ? 'EXPENSE' : ''}`,
      ),
    enabled: Boolean(entityId) && (kind === 'INCOME' || kind === 'EXPENSE'),
  });

  // Sin red se trabaja con las copias locales: registrar no puede depender de la
  // señal del teléfono.
  useEffect(() => {
    void (async () => {
      setCuentasLocales(await getCachedAccounts(entityId));
      setCategoriasLocales(await getCachedCategories());
      setSinConexion(await canOperateOffline());
    })();
  }, [entityId, accountsQuery.dataUpdatedAt, categoriesQuery.dataUpdatedAt]);

  const accounts = accountsQuery.data ?? cuentasLocales;
  const categories = useMemo(() => {
    const source = categoriesQuery.data ?? categoriasLocales;
    if (kind === 'INCOME') {
      return source.filter((category) => category.kind === 'INCOME');
    }
    if (kind === 'EXPENSE') {
      return source.filter((category) => category.kind === 'EXPENSE');
    }
    return [];
  }, [categoriesQuery.data, categoriasLocales, kind]);

  useEffect(() => {
    if (!accountId && accounts.length > 0) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const entity = entities.find((item) => item.id === entityId);
      const payload: Record<string, unknown> = {
        entityId,
        kind,
        accountId,
        amount,
        businessDate,
        description: description.trim(),
      };

      if (kind === 'INCOME' || kind === 'EXPENSE') {
        payload.categoryId = categoryId || undefined;
        payload.method = method;
      }
      if (kind === 'ADJUSTMENT') {
        payload.adjustmentDebitCode = ajusteCargo;
        payload.adjustmentCreditCode = ajusteAbono;
        payload.adjustmentReason = ajusteMotivo;
      }

      return submitOrQueue({
        type: 'TRANSACTION',
        payload,
        summary: description.trim() || kind,
        amount,
        entityId,
        entityName: entity?.name ?? null,
      });
    },
    onSuccess: (result) => {
      const resultado = result.sentNow
        ? { tone: 'positive' as const, text: 'Movimiento registrado y confirmado.' }
        : result.error
          ? {
              tone: 'negative' as const,
              text: `El servidor lo rechazó: ${result.error} Quedó guardado en el dispositivo para corregirlo.`,
            }
          : {
              tone: 'warning' as const,
              text: 'Guardado en este dispositivo SIN CONFIRMAR. Se enviará solo cuando haya conexión.',
            };

      setMessage(resultado);
      setAmount('');
      setDescription('');
      setCategoryId('');

      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });

      // Si el servidor lo confirmó, la operación está terminada y el panel se
      // cierra. Si quedó SIN CONFIRMAR o fue rechazado, el panel se queda
      // abierto con el motivo a la vista: cerrarlo de golpe escondería lo único
      // que importa en ese momento (que el dinero aún no está registrado).
      if (result.sentNow) {
        onSaved?.();
      }
    },
    onError: (error) => {
      if (error instanceof OfflineError) {
        setMessage({ tone: 'negative', text: error.message });
        return;
      }
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo registrar el movimiento.',
      });
    },
  });

  const listo =
    Boolean(entityId && accountId && amount) &&
    description.trim().length >= 2 &&
    (kind !== 'ADJUSTMENT' ||
      (ajusteCargo.length === 4 && ajusteAbono.length === 4 && ajusteMotivo.length >= 5));

  const pestañas = KIND_TABS.filter((tab) => kinds.includes(tab.id));
  const resumenOpciones = [businessDate === todayBusinessDate(preferences?.timezone) ? 'Hoy' : businessDate, method]
    .join(' · ')
    .toLowerCase();

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (listo && !createMutation.isPending) {
          createMutation.mutate();
        }
      }}
    >
      {pestañas.length > 1 ? (
        <Tabs tabs={pestañas} active={kind} onChange={(id) => { setKind(id); setMessage(null); }} />
      ) : null}

      {sinConexion && !sinConexion.allowed ? (
        <Notice tone="warning" title="Sin conexión no se puede registrar">
          {sinConexion.reason}
        </Notice>
      ) : null}

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <MoneyInput label={PREGUNTA_IMPORTE[kind]} value={amount} onChange={setAmount} autoFocus />

      <Field
        label="Descripción"
        value={description}
        onChange={setDescription}
        placeholder={EJEMPLO_DESCRIPCION[kind]}
        enterKeyHint="done"
      />

      <Select
        label="Cuenta"
        value={accountId}
        onChange={setAccountId}
        options={accounts.map((account) => ({
          value: account.id,
          label: `${account.name}${account.isCreditCard ? ' (tarjeta)' : ''} · ${account.balance}`,
        }))}
      />

      {kind === 'INCOME' || kind === 'EXPENSE' ? (
        categories.length > 0 ? (
          <Select
            label="Categoría"
            value={categoryId}
            onChange={setCategoryId}
            options={categories.map((category) => ({ value: category.id, label: category.name }))}
            placeholder="Sin categoría"
          />
        ) : null
      ) : null}

      {kind === 'ADJUSTMENT' ? (
        <div className="space-y-3 rounded-xl border border-border-soft bg-surface-2/60 p-3">
          <p className="text-xs leading-snug text-muted">
            Un ajuste corrige un saldo dejando rastro: qué cuenta se carga, cuál se abona y por qué.
          </p>
          <Field label="Cuenta que se carga (4 dígitos)" value={ajusteCargo} onChange={setAjusteCargo} placeholder="8010" />
          <Field label="Cuenta que se abona (4 dígitos)" value={ajusteAbono} onChange={setAjusteAbono} placeholder="1010" />
          <Field
            label="Motivo del ajuste"
            value={ajusteMotivo}
            onChange={setAjusteMotivo}
            placeholder="Ej.: Faltante detectado en el cierre"
          />
        </div>
      ) : null}

      {/* Lo que casi nunca se toca: cerrado por defecto. */}
      <button
        type="button"
        onClick={() => setMasOpciones((abierto) => !abierto)}
        aria-expanded={masOpciones}
        className="flex w-full items-center justify-between rounded-xl px-1 py-2 text-left text-xs text-muted transition hover:text-ink"
      >
        <span>
          Más opciones <span className="text-faint">· {resumenOpciones}</span>
        </span>
        <IconChevronDown
          size={16}
          className={`shrink-0 text-faint transition-transform ${masOpciones ? 'rotate-180' : ''}`}
        />
      </button>

      {masOpciones ? (
        <div className="space-y-3">
          <Field label="Fecha" value={businessDate} onChange={setBusinessDate} type="date" />
          {kind === 'INCOME' || kind === 'EXPENSE' ? (
            <Select
              label="Forma de pago"
              value={method}
              onChange={setMethod}
              options={METHOD_OPTIONS.map((option) => ({ value: option, label: option.toLowerCase() }))}
            />
          ) : null}
          {entities.length > 1 ? (
            <Select
              label="Unidad financiera"
              value={entityId}
              onChange={setEntityId}
              options={entities.map((entity) => ({ value: entity.id, label: `${entity.name} (${entity.code})` }))}
            />
          ) : null}
        </div>
      ) : null}

      <Button type="submit" className="w-full" size="lg" disabled={!listo || createMutation.isPending}>
        {createMutation.isPending ? 'Registrando…' : 'Registrar movimiento'}
      </Button>
    </form>
  );
}

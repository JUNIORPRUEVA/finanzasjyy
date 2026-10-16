import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, downloadFile } from '../lib/api';
import { Badge, Button, Card, EmptyState, Notice, SectionTitle, Select, Spinner } from '../components/ui';
import { useAuth } from '../store/auth';
import { formatBusinessDate, formatMoney } from '../lib/format';

interface ReportResult {
  type: string;
  title: string;
  period: { from: string; to: string };
  columns: Array<{ key: string; header: string }>;
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string>;
  warnings: string[];
  generatedAt: string;
}

const REPORT_OPTIONS = [
  { value: 'DAILY', label: 'Diario' },
  { value: 'WEEKLY', label: 'Semanal' },
  { value: 'MONTHLY', label: 'Mensual' },
  { value: 'BY_ENTITY', label: 'Por negocio' },
  { value: 'CONSOLIDATED', label: 'Consolidado (todas las unidades)' },
  { value: 'CASH_FLOW', label: 'Flujo de efectivo' },
  { value: 'EXPENSES_BY_CATEGORY', label: 'Gastos por categoría' },
  { value: 'OWNER_WITHDRAWALS', label: 'Retiros del propietario' },
  { value: 'ACCOUNT_STATUS', label: 'Estado de cuentas' },
  { value: 'PENDING_OBLIGATIONS', label: 'Obligaciones pendientes' },
  { value: 'CLOSINGS', label: 'Cierres y diferencias' },
  { value: 'BUDGETS', label: 'Presupuestos' },
];

/** Etiquetas legibles para los totales que devuelve cada informe. */
const TOTAL_LABELS: Record<string, string> = {
  income: 'Ingresos',
  expense: 'Gastos',
  result: 'Resultado',
  movements: 'Movimientos',
  withdrawals: 'Retiros',
  contributions: 'Aportes',
  net: 'Neto',
  inflows: 'Entradas',
  outflows: 'Salidas',
  total: 'Total',
  assets: 'Activos',
  liabilities: 'Pasivos',
  toPay: 'Por pagar',
  toCollect: 'Por cobrar',
  closings: 'Cierres',
  finalized: 'Finalizados',
  withDifference: 'Con diferencias',
  totalDifference: 'Diferencia total',
  limit: 'Presupuesto',
  spent: 'Gastado',
  exceeded: 'Excedidos',
};

/**
 * INFORMES Y EXPORTACIÓN
 * ----------------------
 * Cada informe declara su período y avisa si hay datos provisionales. La
 * exportación es CSV (se abre directamente en Excel o Google Sheets) con BOM
 * UTF-8 para que los acentos no se corrompan.
 */
export function ReportsPage() {
  const [params] = useSearchParams();
  const { preferences } = useAuth();
  const entityId = params.get('entityId') ?? '';
  const currency = preferences?.currency ?? 'DOP';

  const [type, setType] = useState('CONSOLIDATED');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [downloading, setDownloading] = useState(false);

  const reportQuery = useQuery<ReportResult>({
    queryKey: ['report', type, entityId, from, to],
    queryFn: () => {
      const search = new URLSearchParams({
        ...(entityId ? { entityId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }).toString();
      return api.get<ReportResult>(`/reports/${type}?${search}`);
    },
  });

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const search = new URLSearchParams({
        ...(entityId ? { entityId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }).toString();
      await downloadFile(`/reports/${type}/csv?${search}`, `finanza-${type.toLowerCase()}.csv`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <Select label="Informe" value={type} onChange={setType} options={REPORT_OPTIONS} placeholder="— Seleccione —" />
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm text-ink">Desde</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="w-full rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-ink">Hasta</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="w-full rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-sm text-ink"
            />
          </label>
        </div>
        <p className="text-xs text-faint">
          Si no indica fechas, cada informe usa su período natural (hoy, semana o mes en curso).
        </p>
      </Card>

      {reportQuery.isLoading ? <Spinner label="Generando el informe…" /> : null}

      {reportQuery.isError ? (
        <Notice tone="warning" title="No se pudo generar el informe">
          Los informes se calculan en el servidor con los movimientos confirmados. Compruebe su conexión.
        </Notice>
      ) : null}

      {reportQuery.data ? (
        <Card>
          <SectionTitle
            title={reportQuery.data.title}
            hint={`Del ${formatBusinessDate(reportQuery.data.period.from)} al ${formatBusinessDate(reportQuery.data.period.to)}`}
            right={
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  onClick={() => window.print()}
                  title="Imprimir o guardar el informe como PDF con el diálogo del navegador"
                >
                  PDF / Imprimir
                </Button>
                <Button variant="secondary" disabled={downloading} onClick={() => void handleDownload()}>
                  {downloading ? 'Generando…' : 'Descargar CSV'}
                </Button>
              </div>
            }
          />

          {reportQuery.data.warnings.length > 0 ? (
            <div className="mb-3">
              <Notice tone="warning">
                <ul className="list-inside list-disc space-y-1">
                  {reportQuery.data.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Notice>
            </div>
          ) : null}

          {Object.keys(reportQuery.data.totals).length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {Object.entries(reportQuery.data.totals).map(([key, value]) => (
                <Badge key={key} tone="neutral">
                  {TOTAL_LABELS[key] ?? key}: {formatMoney(value, currency)}
                </Badge>
              ))}
            </div>
          ) : null}

          {reportQuery.data.rows.length === 0 ? (
            <EmptyState title="Este informe no tiene datos en el período" hint="Pruebe a cambiar las fechas." />
          ) : (
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border-soft text-left text-xs uppercase text-muted">
                    {reportQuery.data.columns.map((column) => (
                      <th key={column.key} className="whitespace-nowrap px-2 py-2">
                        {column.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reportQuery.data.rows.map((row, index) => (
                    <tr key={index} className="border-b border-border-soft">
                      {reportQuery.data!.columns.map((column) => {
                        const value = row[column.key];
                        const isMoneyColumn = /amount|income|expense|result|balance|limit|spent|remaining|pending|difference|total|withdrawals|contributions|assets|liabilities|toPay|toCollect|inflows|outflows|net/i.test(
                          column.key,
                        );
                        return (
                          <td key={column.key} className="whitespace-nowrap px-2 py-2 text-ink">
                            {value === null || value === undefined
                              ? '—'
                              : isMoneyColumn && String(value) !== ''
                                ? formatMoney(String(value), currency)
                                : String(value)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-3 text-xs text-faint">
            Informe generado el {formatBusinessDate(reportQuery.data.generatedAt)}. Reproducible: los mismos datos
            producen el mismo informe. «PDF / Imprimir» abre el diálogo del navegador, desde donde se puede guardar
            como PDF con los mismos totales que ve aquí.
          </p>
        </Card>
      ) : null}
    </div>
  );
}

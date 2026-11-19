/**
 * PERÍODOS DEL PANEL
 * ==================
 * El filtro de fechas del panel vive en la cabecera azul (no dentro de la
 * página) para que esté siempre a la vista. Para que la cabecera y el panel no
 * puedan discrepar, el período se guarda en la dirección (`?periodo=MONTH`) y
 * las dos partes leen de ahí.
 */
export type PeriodoPanel = 'TODAY' | 'YESTERDAY' | 'WEEK' | 'MONTH' | 'LAST_30_DAYS';

export const PERIODOS_PANEL: Array<{ id: PeriodoPanel; label: string }> = [
  { id: 'TODAY', label: 'Hoy' },
  { id: 'YESTERDAY', label: 'Ayer' },
  { id: 'WEEK', label: 'Semana' },
  { id: 'MONTH', label: 'Mes' },
  { id: 'LAST_30_DAYS', label: '30 días' },
];

export const PERIODO_POR_DEFECTO: PeriodoPanel = 'TODAY';

/** Devuelve un período válido aunque la dirección traiga basura. */
export function normalizePeriodo(value: string | null | undefined): PeriodoPanel {
  return PERIODOS_PANEL.some((periodo) => periodo.id === value) ? (value as PeriodoPanel) : PERIODO_POR_DEFECTO;
}

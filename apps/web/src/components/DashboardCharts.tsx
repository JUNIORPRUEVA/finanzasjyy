import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, SectionTitle } from './ui';
import { formatMoney } from '../lib/format';

/**
 * GRÁFICOS DEL PANEL
 * ------------------
 * Se cargan aparte (no en el arranque de la aplicación) porque son la parte más
 * pesada y no siempre se miran: así la pantalla de inicio aparece antes.
 *
 * Los colores se toman del tema, de modo que los gráficos son legibles en claro
 * y en oscuro sin duplicar código.
 */

const PIE_COLORS = [
  'var(--negative)',
  'var(--warning)',
  'var(--info)',
  'var(--positive)',
  '#a78bfa',
  '#fb923c',
  '#22d3ee',
  '#f472b6',
];

export function DashboardCharts({
  dailySeries,
  expenseByCategory,
  currency,
}: {
  dailySeries: Array<{ date: string; income: string; expense: string }>;
  expenseByCategory: Array<{ categoryName: string; amount: string }>;
  currency: string;
}) {
  const chartData = dailySeries.map((row) => ({
    date: row.date.slice(5),
    Ingresos: Number(row.income),
    Gastos: Number(row.expense),
  }));

  const pieData = expenseByCategory.slice(0, 8).map((row) => ({
    name: row.categoryName,
    value: Number(row.amount),
  }));

  const tooltipStyle = {
    background: 'var(--surface)',
    border: '1px solid var(--border-soft)',
    borderRadius: 12,
    color: 'var(--text)',
  } as const;

  return (
    <>
      {chartData.length > 0 ? (
        <Card>
          <SectionTitle title="Ingresos y gastos (30 días)" hint="Las transferencias entre cuentas no aparecen aquí" />
          <div className="h-52 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="var(--border-soft)" vertical={false} />
                <XAxis dataKey="date" stroke="var(--text-faint)" fontSize={11} interval={4} tickLine={false} />
                <YAxis stroke="var(--text-faint)" fontSize={11} width={54} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatMoney(String(value ?? '0'), currency)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Ingresos" fill="var(--positive)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Gastos" fill="var(--negative)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}

      {pieData.length > 0 ? (
        <Card>
          <SectionTitle title="En qué se está gastando" hint="Gastos reales del período por categoría" />
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={86} paddingAngle={2}>
                  {pieData.map((entry, index) => (
                    <Cell key={entry.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatMoney(String(value ?? '0'), currency)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}
    </>
  );
}

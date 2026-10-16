import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Skeleton } from './components/ui';
import { LoginPage } from './pages/Login';
import { useAuth } from './store/auth';

/**
 * RUTAS DE FINANZA
 * ----------------
 * Todo lo que hay detrás de «/» exige sesión: si no la hay, no se muestra ningún
 * dato financiero y se pide identificarse.
 *
 * Las pantallas se cargan **bajo demanda** (código dividido). Así el arranque en
 * el móvil no descarga los gráficos, los informes ni los formularios largos que
 * quizá no se usen en esa sesión. Mientras llega una pantalla se muestra un
 * esqueleto con la misma forma, para que no haya saltos ni pantallas en blanco.
 */
const DashboardPage = lazy(() => import('./pages/Dashboard').then((module) => ({ default: module.DashboardPage })));
const QuickEntryPage = lazy(() => import('./pages/QuickEntry').then((module) => ({ default: module.QuickEntryPage })));
const TransactionsPage = lazy(() =>
  import('./pages/Transactions').then((module) => ({ default: module.TransactionsPage })),
);
const AccountsPage = lazy(() => import('./pages/Accounts').then((module) => ({ default: module.AccountsPage })));
const ClosingPage = lazy(() => import('./pages/Closing').then((module) => ({ default: module.ClosingPage })));
const MorePage = lazy(() => import('./pages/More').then((module) => ({ default: module.MorePage })));
const ReportsPage = lazy(() => import('./pages/Reports').then((module) => ({ default: module.ReportsPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((module) => ({ default: module.SettingsPage })));
const SetupPage = lazy(() => import('./pages/Setup').then((module) => ({ default: module.SetupPage })));
const DailyControlPage = lazy(() =>
  import('./pages/DailyControl').then((module) => ({ default: module.DailyControlPage })),
);
const TransfersPage = lazy(() => import('./pages/Transfers').then((module) => ({ default: module.TransfersPage })));
const DebtsPage = lazy(() => import('./pages/Debts').then((module) => ({ default: module.DebtsPage })));
const ObligationsPage = lazy(() =>
  import('./pages/Obligations').then((module) => ({ default: module.ObligationsPage })),
);
const BudgetsPage = lazy(() => import('./pages/Budgets').then((module) => ({ default: module.BudgetsPage })));
const AttachmentsPage = lazy(() =>
  import('./pages/Attachments').then((module) => ({ default: module.AttachmentsPage })),
);
const EntitiesPage = lazy(() => import('./pages/Entities').then((module) => ({ default: module.EntitiesPage })));

/** Esqueleto de pantalla: misma silueta que las pantallas reales. */
function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Cargando pantalla">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-32" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  );
}

/** Pantalla de arranque: se muestra mientras se comprueba si la sesión sigue viva. */
function Splash({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6">
      <div className="flex h-16 w-16 animate-pop items-center justify-center rounded-2xl bg-brand text-2xl font-bold text-white shadow-elevated">
        F
      </div>
      <div className="text-center">
        <p className="text-lg font-semibold text-ink">FINANZA</p>
        <p className="mt-1 text-sm text-muted">{message}</p>
      </div>
    </div>
  );
}

export default function App() {
  const { ready, sessionState, user, sessionExpiredMessage, dismissSessionExpired } = useAuth();

  if (!ready || sessionState === 'starting') {
    return <Splash message={sessionState === 'starting' ? 'Recuperando su sesión…' : 'Preparando FINANZA…'} />;
  }

  if (!user) {
    return (
      <LoginPage
        sessionExpired={sessionState === 'expired'}
        sessionMessage={sessionExpiredMessage}
        onDismissExpired={dismissSessionExpired}
      />
    );
  }

  return (
    <AppShell>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/registrar" element={<QuickEntryPage />} />
          <Route path="/movimientos" element={<TransactionsPage />} />
          <Route path="/cuentas" element={<AccountsPage />} />
          <Route path="/cierres" element={<ClosingPage />} />
          <Route path="/mas" element={<MorePage />} />
          <Route path="/informes" element={<ReportsPage />} />
          <Route path="/ajustes" element={<SettingsPage />} />
          <Route path="/organizar" element={<SetupPage />} />
          <Route path="/control" element={<DailyControlPage />} />
          <Route path="/traspasos" element={<TransfersPage />} />
          <Route path="/deudas" element={<DebtsPage />} />
          <Route path="/obligaciones" element={<ObligationsPage />} />
          <Route path="/presupuestos" element={<BudgetsPage />} />
          <Route path="/adjuntos" element={<AttachmentsPage />} />
          <Route path="/unidades" element={<EntitiesPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

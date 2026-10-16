import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './store/auth';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { QuickEntryPage } from './pages/QuickEntry';
import { TransactionsPage } from './pages/Transactions';
import { AccountsPage } from './pages/Accounts';
import { ClosingPage } from './pages/Closing';
import { MorePage } from './pages/More';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';

/**
 * RUTAS DE FINANZA
 * ----------------
 * Todo lo que hay detrás de `/` exige sesión: si no hay usuario, se redirige al
 * acceso (y no se muestra ningún dato financiero).
 */
export default function App() {
  const { ready, user, sessionExpired, dismissSessionExpired } = useAuth();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Preparando FINANZA…" />
      </div>
    );
  }

  if (!user || sessionExpired) {
    return <LoginPage sessionExpired={sessionExpired} onDismissExpired={dismissSessionExpired} />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/registrar" element={<QuickEntryPage />} />
        <Route path="/movimientos" element={<TransactionsPage />} />
        <Route path="/cuentas" element={<AccountsPage />} />
        <Route path="/cierres" element={<ClosingPage />} />
        <Route path="/mas" element={<MorePage />} />
        <Route path="/informes" element={<ReportsPage />} />
        <Route path="/ajustes" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

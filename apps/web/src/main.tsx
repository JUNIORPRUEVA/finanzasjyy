import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './store/auth';
import './index.css';

/**
 * Cliente de datos. Se configura con criterio para una app financiera:
 *  · Los datos financieros NO se consideran "frescos" durante mucho tiempo en
 *    segundo plano; al volver a la app se refrescan.
 *  · No se reintenta cuando no hay conexión: en su lugar se muestra el aviso de
 *    "sin conexión" y se usan los datos locales (que se marcan como tales).
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (failureCount, error) => {
        if (!navigator.onLine) {
          return false;
        }
        if (error instanceof Error && error.name === 'ApiError') {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

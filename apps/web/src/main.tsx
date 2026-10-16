import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './store/auth';
import { mirrorApiDataToLocalCache } from './lib/cache-mirror';
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
      // SIN CONEXIÓN NO SE PAUSA NADA (`networkMode: 'always'`).
      //
      // Con el valor por defecto ('online'), React Query deja las peticiones «en
      // espera» cuando el navegador está sin conexión: no las envía, no fallan y
      // no avisan. El resultado era doble y grave:
      //   · El panel se quedaba con el esqueleto de carga para siempre.
      //   · Al registrar un gasto sin conexión, el botón se quedaba en
      //     «Registrando…» indefinidamente y el movimiento NUNCA llegaba a la
      //     cola del dispositivo.
      // Con 'always' la petición se intenta y falla rápido (sin conexión), y
      // entonces la aplicación hace lo que tiene previsto: guardar en el
      // dispositivo y marcarlo como «sin confirmar».
      networkMode: 'always',
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
      // Igual que arriba: sin conexión, la operación debe ejecutarse para poder
      // guardarse en la cola local. Pausarla equivalía a perderla.
      networkMode: 'always',
      retry: false,
    },
  },
});

/**
 * Copia local de cuentas y categorías: es lo que permite registrar un movimiento
 * sin conexión (ver `lib/cache-mirror.ts`).
 */
mirrorApiDataToLocalCache(queryClient);

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

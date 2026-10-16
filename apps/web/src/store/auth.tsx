import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, deviceInfo, tokenStore } from '../lib/api';
import { cacheEntities, clearReadCache, getCachedEntities, requestPersistentStorage, setMeta } from '../lib/db';

/**
 * SESIÓN DEL USUARIO
 * ------------------
 * Guarda el token de acceso y la sesión, y mantiene el aviso de "sesión
 * caducada" para que la app vuelva al acceso en lugar de mostrar datos vacíos
 * como si fueran válidos.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface SessionEntity {
  id: string;
  code: string;
  name: string;
  type: string;
  currency: string;
  isActive: boolean;
}

export interface SessionPreferences {
  timezone: string;
  currency: string;
  theme: string;
  closingReminderHour: number;
  closingReminderMinute: number;
  offlineWindowHours: number;
  budgetWarnPct: number;
  budgetAlertPct: number;
  pushEnabled: boolean;
}

interface MeResponse {
  user: SessionUser;
  preferences: SessionPreferences;
  entities: SessionEntity[];
  session: { id: string; deviceId: string | null; offlineAllowedUntil: string | null; offlineWindowHours: number };
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  offlineAllowedUntil: string;
  user: SessionUser;
}

interface AuthState {
  ready: boolean;
  user: SessionUser | null;
  entities: SessionEntity[];
  preferences: SessionPreferences | null;
  offlineAllowedUntil: string | null;
  sessionExpired: boolean;
  login: (email: string, password: string) => Promise<void>;
  registerFirstUser: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  dismissSessionExpired: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [entities, setEntities] = useState<SessionEntity[]>([]);
  const [preferences, setPreferences] = useState<SessionPreferences | null>(null);
  const [offlineAllowedUntil, setOfflineAllowedUntil] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const reload = useCallback(async () => {
    if (!tokenStore.getAccessToken()) {
      setUser(null);
      setEntities([]);
      setReady(true);
      return;
    }

    try {
      const me = await api.get<MeResponse>('/auth/me');
      setUser(me.user);
      setEntities(me.entities);
      setPreferences(me.preferences);
      setOfflineAllowedUntil(me.session.offlineAllowedUntil);
      setSessionExpired(false);

      // La ventana offline viaja con la sesión: la app la guarda para saber
      // hasta cuándo puede registrar movimientos sin conexión.
      if (me.session.offlineAllowedUntil) {
        await setMeta('offlineAllowedUntil', me.session.offlineAllowedUntil);
      }
      await cacheEntities(
        me.entities.map((entity) => ({
          id: entity.id,
          code: entity.code,
          name: entity.name,
          type: entity.type,
          currency: entity.currency,
          cachedAt: new Date().toISOString(),
        })),
      );
    } catch {
      // Sin conexión: se usan las unidades guardadas para poder navegar.
      const cached = await getCachedEntities();
      if (cached.length > 0) {
        setEntities(
          cached.map((entity) => ({
            id: entity.id,
            code: entity.code,
            name: entity.name,
            type: entity.type,
            currency: entity.currency,
            isActive: true,
          })),
        );
      }
    } finally {
      setReady(true);
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const response = await api.post<LoginResponse>('/auth/login', {
        email,
        password,
        deviceId: deviceInfo.deviceId(),
        deviceName: deviceInfo.deviceName(),
        platform: deviceInfo.platform(),
      });

      tokenStore.set(response.accessToken, response.refreshToken);
      await setMeta('offlineAllowedUntil', response.offlineAllowedUntil);
      setOfflineAllowedUntil(response.offlineAllowedUntil);
      await requestPersistentStorage();
      await reload();
    },
    [reload],
  );

  const registerFirstUser = useCallback(
    async (name: string, email: string, password: string) => {
      const response = await api.post<LoginResponse>('/auth/register', {
        name,
        email,
        password,
        deviceId: deviceInfo.deviceId(),
        deviceName: deviceInfo.deviceName(),
        platform: deviceInfo.platform(),
      });
      tokenStore.set(response.accessToken, response.refreshToken);
      await setMeta('offlineAllowedUntil', response.offlineAllowedUntil);
      setOfflineAllowedUntil(response.offlineAllowedUntil);
      await requestPersistentStorage();
      await reload();
    },
    [reload],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Aunque el servidor no responda, la sesión local se cierra.
    }
    tokenStore.clear();
    setUser(null);
    setEntities([]);
    setPreferences(null);
    await clearReadCache();
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const handleExpired = () => setSessionExpired(true);
    window.addEventListener('finanza:session-expired', handleExpired);
    return () => window.removeEventListener('finanza:session-expired', handleExpired);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      user,
      entities,
      preferences,
      offlineAllowedUntil,
      sessionExpired,
      login,
      registerFirstUser,
      logout,
      reload,
      dismissSessionExpired: () => setSessionExpired(false),
    }),
    [ready, user, entities, preferences, offlineAllowedUntil, sessionExpired, login, registerFirstUser, logout, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  }
  return context;
}

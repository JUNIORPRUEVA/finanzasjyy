import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiError,
  OfflineError,
  SessionTemporarilyUnavailableError,
  api,
  deviceInfo,
  endSession,
  hasSessionCookieHint,
  refreshSession,
  startSession,
  tokenStore,
} from '../lib/api';
import {
  cacheEntities,
  clearReadCache,
  getMeta,
  requestPersistentStorage,
  setMeta,
} from '../lib/db';

/**
 * SESIÓN DEL USUARIO
 * ------------------
 * Objetivo principal: **no volver a pedir la contraseña al reabrir la PWA**
 * mientras la sesión siga siendo válida.
 *
 * Cómo se consigue:
 *  1. El refresh token vive en una cookie HttpOnly: sobrevive al cierre de la
 *     aplicación sin ser accesible desde JavaScript.
 *  2. El access token vive en memoria (se pierde al recargar, y se recupera con
 *     una renovación silenciosa).
 *  3. Al arrancar: si hay sesión en el servidor se renueva y se entra directo.
 *  4. Si el servidor NO responde (sin red, timeout, 502/503) la sesión NO se
 *     cierra: se entra en modo «sin conexión» con lo último conocido, y se
 *     reintenta al recuperar la conexión.
 *  5. Sólo se vuelve a la pantalla de acceso cuando el servidor dice con un
 *     código explícito que la sesión ya no sirve (caducada, revocada, cerrada
 *     por inactividad o duración máxima).
 *  6. Los movimientos pendientes de sincronizar NO se tocan nunca al cerrar
 *     sesión: si el usuario vuelve a entrar, seguirán ahí.
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

/** Estado de la sesión tal y como lo ve la interfaz. */
export type SessionState = 'starting' | 'authenticated' | 'offline' | 'anonymous' | 'expired';

interface MeResponse {
  user: SessionUser;
  preferences: SessionPreferences;
  entities: SessionEntity[];
  session: { id: string; deviceId: string | null; offlineAllowedUntil: string | null; offlineWindowHours: number };
}

interface CachedSessionProfile {
  user: SessionUser;
  entities: SessionEntity[];
  preferences: SessionPreferences | null;
  offlineAllowedUntil: string | null;
  cachedAt: string;
}

interface AuthState {
  ready: boolean;
  /** Distingue «arrancando», «dentro», «dentro sin conexión» y «fuera». */
  sessionState: SessionState;
  user: SessionUser | null;
  entities: SessionEntity[];
  preferences: SessionPreferences | null;
  offlineAllowedUntil: string | null;
  sessionExpired: boolean;
  sessionExpiredMessage: string | null;
  login: (email: string, password: string) => Promise<void>;
  registerFirstUser: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  dismissSessionExpired: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** El perfil cacheado NO contiene credenciales: sólo lo necesario para abrir la app sin conexión. */
const PROFILE_META_KEY = 'sessionProfile';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState>('starting');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [entities, setEntities] = useState<SessionEntity[]>([]);
  const [preferences, setPreferences] = useState<SessionPreferences | null>(null);
  const [offlineAllowedUntil, setOfflineAllowedUntil] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  /** Guarda el perfil para poder abrir la aplicación sin conexión. */
  const persistProfile = useCallback(async (profile: CachedSessionProfile) => {
    await setMeta(PROFILE_META_KEY, JSON.stringify(profile));
  }, []);

  const applyProfile = useCallback(
    (profile: { user: SessionUser; entities: SessionEntity[]; preferences: SessionPreferences | null; offlineAllowedUntil: string | null }) => {
      setUser(profile.user);
      setEntities(profile.entities);
      setPreferences(profile.preferences);
      setOfflineAllowedUntil(profile.offlineAllowedUntil);
    },
    [],
  );

  /**
   * Carga la sesión desde el servidor. Devuelve el estado alcanzado.
   * Nunca lanza: el arranque de la aplicación no puede quedarse colgado.
   */
  const loadSession = useCallback(async (): Promise<SessionState> => {
    const fetchMe = async (): Promise<MeResponse | 'unauthorized' | 'temporary' | 'unexpected'> => {
      try {
        return await api.get<MeResponse>('/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          return 'unauthorized';
        }
        if (error instanceof OfflineError || error instanceof SessionTemporarilyUnavailableError) {
          return 'temporary';
        }
        if (error instanceof ApiError && error.status >= 500) {
          return 'temporary';
        }
        return 'unexpected';
      }
    };

    let me = await fetchMe();

    // Sin access token en memoria (es lo normal al abrir la aplicación) o
    // caducado: se renueva con la cookie. Si el servidor no responde, NO se
    // cierra la sesión.
    if (me === 'unauthorized') {
      const outcome = await refreshSession();
      if (outcome.status === 'refreshed') {
        me = await fetchMe();
      } else if (outcome.status === 'temporary') {
        return 'offline';
      } else if (outcome.status === 'no-session' || outcome.code === 'SESSION_MISSING') {
        // Primera visita o sesión ya borrada: no hay nada que explicar, sólo
        // pedir las credenciales.
        return 'anonymous';
      } else {
        // El servidor ha dicho CON SU CÓDIGO que la sesión terminó (caducada,
        // revocada, cerrada por inactividad o superó su duración máxima). El
        // usuario tiene derecho a saber por qué se le pide la contraseña otra
        // vez, así que se guarda el motivo para mostrarlo en la pantalla de
        // acceso.
        setSessionExpiredMessage(outcome.message);
        setSessionExpired(true);
        return 'expired';
      }
    }

    if (me === 'temporary') {
      return 'offline';
    }

    if (me === 'unauthorized') {
      return 'anonymous';
    }

    if (me === 'unexpected') {
      return 'offline';
    }

    applyProfile({
      user: me.user,
      entities: me.entities,
      preferences: me.preferences,
      offlineAllowedUntil: me.session.offlineAllowedUntil,
    });
    setSessionExpired(false);
    setSessionExpiredMessage(null);

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
    await persistProfile({
      user: me.user,
      entities: me.entities,
      preferences: me.preferences,
      offlineAllowedUntil: me.session.offlineAllowedUntil,
      cachedAt: new Date().toISOString(),
    });

    return 'authenticated';
  }, [applyProfile, persistProfile]);

  /**
   * Abre la aplicación sin conexión: sólo si hay un perfil guardado Y la ventana
   * de trabajo offline sigue vigente. Si ya caducó, se pide conexión. Pasado el
   * límite no se permite seguir registrando movimientos.
   */
  const enterOfflineWithCache = useCallback(async (): Promise<SessionState> => {
    const stored = await getMeta(PROFILE_META_KEY);
    if (!stored) {
      return 'anonymous';
    }

    let profile: CachedSessionProfile;
    try {
      profile = JSON.parse(stored) as CachedSessionProfile;
    } catch {
      return 'anonymous';
    }

    const untilIso = profile.offlineAllowedUntil ?? (await getMeta('offlineAllowedUntil'));
    const until = untilIso ? new Date(untilIso).getTime() : 0;

    if (!until || until < Date.now()) {
      // La ventana caducó: no se finge que la sesión sigue viva.
      return 'anonymous';
    }

    applyProfile({
      user: profile.user,
      entities: profile.entities,
      preferences: profile.preferences,
      offlineAllowedUntil: profile.offlineAllowedUntil,
    });
    return 'offline';
  }, [applyProfile]);

  const reload = useCallback(async () => {
    const state = await loadSession();
    if (state === 'offline') {
      setSessionState(await enterOfflineWithCache());
    } else {
      setSessionState(state);
    }
    setReady(true);
  }, [loadSession, enterOfflineWithCache]);

  const login = useCallback(
    async (email: string, password: string) => {
      const response = await startSession('/auth/login', {
        email,
        password,
        deviceId: deviceInfo.deviceId(),
        deviceName: deviceInfo.deviceName(),
        platform: deviceInfo.platform(),
      });
      await setMeta('offlineAllowedUntil', response.offlineAllowedUntil);
      setOfflineAllowedUntil(response.offlineAllowedUntil);
      await requestPersistentStorage();
      setSessionExpired(false);
      setSessionExpiredMessage(null);
      await reload();
    },
    [reload],
  );

  const registerFirstUser = useCallback(
    async (name: string, email: string, password: string) => {
      const response = await startSession('/auth/register', {
        name,
        email,
        password,
        deviceId: deviceInfo.deviceId(),
        deviceName: deviceInfo.deviceName(),
        platform: deviceInfo.platform(),
      });
      await setMeta('offlineAllowedUntil', response.offlineAllowedUntil);
      setOfflineAllowedUntil(response.offlineAllowedUntil);
      await requestPersistentStorage();
      await reload();
    },
    [reload],
  );

  const logout = useCallback(async () => {
    // Cierre VOLUNTARIO: se revoca la sesión en el servidor y se limpia el estado
    // local. La cola de operaciones pendientes NO se borra: si el usuario vuelve
    // a entrar, sus movimientos seguirán ahí sin duplicarse.
    await endSession();
    setUser(null);
    setEntities([]);
    setPreferences(null);
    setSessionState('anonymous');
    await clearReadCache();
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const handleExpired = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setSessionExpired(true);
      setSessionExpiredMessage(detail?.message ?? null);
      setSessionState('expired');
    };
    window.addEventListener('finanza:session-expired', handleExpired);
    return () => window.removeEventListener('finanza:session-expired', handleExpired);
  }, []);

  // Al recuperar la conexión, si estábamos sin conexión se vuelve a comprobar la
  // sesión de verdad y se sincroniza lo pendiente.
  useEffect(() => {
    if (sessionState !== 'offline' && sessionState !== 'expired') {
      return;
    }
    const handleOnline = () => {
      void reload();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [sessionState, reload]);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      sessionState,
      user,
      entities,
      preferences,
      offlineAllowedUntil,
      sessionExpired,
      sessionExpiredMessage,
      login,
      registerFirstUser,
      logout,
      reload,
      dismissSessionExpired: () => {
        setSessionExpired(false);
        setSessionExpiredMessage(null);
      },
    }),
    [
      ready,
      sessionState,
      user,
      entities,
      preferences,
      offlineAllowedUntil,
      sessionExpired,
      sessionExpiredMessage,
      login,
      registerFirstUser,
      logout,
      reload,
    ],
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

/** ¿Hay indicios de sesión guardada? Lo usa la pantalla de acceso para decidir si esperar. */
export function sessionMayExist(): boolean {
  return tokenStore.hasSession() || hasSessionCookieHint();
}

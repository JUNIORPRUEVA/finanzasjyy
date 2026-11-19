import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { DRAWER_FOOTER_IDS, visibleDrawerEntries, type NavEntry } from '../navigation/registry';
import { IconArrowDown, IconChart, IconChevronDown, IconClose } from './icons';
import { Sheet } from './ui';
import type { InstalacionApp } from '../lib/install';

/**
 * MENÚ LATERAL (DRAWER)
 * =====================
 * Accesible desde el botón de tres líneas del encabezado. Reúne todo lo que no
 * cabe —ni debe caber— en la barra inferior, agrupado por para qué sirve.
 *
 * Lo que se ha cuidado, porque es lo que distingue un menú cómodo de uno que
 * molesta:
 *  · Se abre y se cierra con suavidad, sin saltos.
 *  · Se cierra al tocar fuera, con la tecla Escape y al elegir una opción.
 *  · Mientras está abierto, el fondo no se desplaza y no se puede tocar.
 *  · El foco entra en el menú al abrirlo y VUELVE al botón que lo abrió al
 *    cerrarlo: quien navega con el teclado no se pierde.
 *  · Respeta las áreas seguras (notch y barra de gestos).
 *  · En pantalla grande no ocupa todo el ancho; en móvil deja ver que hay algo
 *    detrás (que es lo que hace entender que se puede cerrar).
 *  · El desplazamiento es interno: la lista puede crecer sin romper nada.
 */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Rol del usuario: decide qué entradas se ven. */
  role: string | null | undefined;
  /** Nombre del usuario, para la cabecera del menú. */
  userName?: string | null;
  /** Unidad financiera activa, para que quede claro en qué contexto se navega. */
  entityName?: string | null;
  /** Acción de cerrar sesión (se confirma aparte). */
  onLogout: () => void;
  /** Elemento que tenía el foco antes de abrir el menú. */
  returnFocusTo?: HTMLElement | null;
  /** Instalación en el teléfono: decide si se ofrece y qué hace el botón. */
  instalacion?: InstalacionApp;
}

export function Drawer({ open, onClose, role, userName, entityName, onLogout, returnFocusTo, instalacion }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const sections = visibleDrawerEntries(role);

  // Ajustes y Cerrar sesión no van en la lista que se desplaza: se quedan fijos
  // al pie para que siempre estén a la vista.
  const footerIds = new Set(DRAWER_FOOTER_IDS);
  const navSections = sections
    .map((section) => ({ ...section, entries: section.entries.filter((entry) => !footerIds.has(entry.id)) }))
    .filter((section) => section.entries.length > 0);
  const footerEntries = sections
    .flatMap((section) => section.entries)
    .filter((entry) => footerIds.has(entry.id));
  // El pie es UNA línea: Configuración a la izquierda y el botón de salir a la
  // derecha, sin texto. Dos filas para dos cosas era más de lo necesario.
  const configEntry = footerEntries.find((entry) => entry.id === 'ajustes');
  const logoutEntry = footerEntries.find((entry) => entry.action === 'logout');

  /** Gesto para cerrar: deslizar el propio menú hacia la izquierda. */
  const gestoCierre = useRef<{ x: number; y: number } | null>(null);

  // Estado del botón «Instalar» y del desplegable de Análisis.
  const [pedirInstrucciones, setPedirInstrucciones] = useState(false);
  const [analisisAbierto, setAnalisisAbierto] = useState(false);

  // Escape cierra; el foco entra en el menú y se encierra dentro (dialog modal).
  useEffect(() => {
    if (!open) {
      return;
    }

    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);

    // El primer elemento con foco es el botón de cerrar: se entiende al instante.
    (focusable()[0] ?? panel)?.focus();

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const elements = focusable();
      if (elements.length === 0) {
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
      const target = returnFocusTo ?? previousFocus;
      target?.focus?.();
    };
  }, [open, onClose, returnFocusTo]);

  // Al cambiar de pantalla, el menú se cierra solo.
  useEffect(() => {
    if (open) {
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search]);

  if (!open) {
    return null;
  }

  /**
   * Marca la opción que corresponde a la pantalla actual.
   * Sin esto, el menú era una lista ciega: no se sabía dónde estaba uno.
   */
  const isActiveEntry = (to: string) => {
    const path = to.split('?')[0];
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  /** Una fila del menú: icono, nombre y, si es la pantalla actual, resaltado. */
  const renderEntry = (entry: NavEntry) => {
    const Icon = entry.icon;
    const active = entry.to ? isActiveEntry(entry.to) : false;

    if (entry.action === 'logout') {
      return (
        <li key={entry.id}>
          <button
            type="button"
            onClick={() => {
              onClose();
              onLogout();
            }}
            className="flex min-h-[2.75rem] w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-negative transition hover:bg-negative/10"
          >
            <span className="shrink-0">
              <Icon size={19} />
            </span>
            <span className="truncate text-[0.9rem] font-medium">{entry.label}</span>
          </button>
        </li>
      );
    }

    return (
      <li key={entry.id}>
        <Link
          to={entry.to ?? '/'}
          aria-current={active ? 'page' : undefined}
          className={`flex min-h-[3rem] items-center gap-3 rounded-xl px-2.5 py-1.5 transition ${
            active ? 'bg-brand-soft font-semibold text-brand' : 'text-ink hover:bg-surface-2 active:bg-surface-3'
          }`}
        >
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${
              active ? 'bg-brand text-white' : 'bg-brand-soft text-brand'
            }`}
          >
            <Icon size={21} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[0.95rem]">{entry.label}</span>
          {active ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" /> : null}
        </Link>
      </li>
    );
  };

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="Menú de FINANZA">
      {/* Fondo: se puede tocar para cerrar y no deja tocar nada de detrás. Va con
          un nombre distinto al de la «X»: son dos controles diferentes y, para
          quien usa un lector de pantalla, dos botones con el mismo nombre son
          una trampa. */}
      <button
        type="button"
        aria-label="Cerrar el menú tocando fuera"
        onClick={onClose}
        className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-[2px]"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        onTouchStart={(event) => {
          const punto = event.touches[0];
          gestoCierre.current = { x: punto.clientX, y: punto.clientY };
        }}
        onTouchEnd={(event) => {
          const desde = gestoCierre.current;
          gestoCierre.current = null;
          if (!desde) {
            return;
          }
          const punto = event.changedTouches[0];
          const dx = punto.clientX - desde.x;
          const dy = punto.clientY - desde.y;
          // Hacia la izquierda y claramente horizontal: se cierra.
          if (dx < -60 && Math.abs(dy) < 60) {
            onClose();
          }
        }}
        className="absolute inset-y-0 left-0 flex w-[86%] max-w-[20rem] animate-rise flex-col bg-bg-elevated shadow-elevated outline-none"
        style={{ paddingLeft: 'var(--safe-left)' }}
      >
        {/* Cabecera mínima: quién está dentro y en qué unidad. Sin la marca
            «FINANZA»: la marca ya está en el encabezado de la aplicación y aquí
            sólo era una línea de ruido. */}
        <div className="flex items-start justify-between gap-2 border-b border-border-soft px-4 pb-3 pt-[calc(var(--safe-top)+0.6rem)]">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{userName ?? 'Su cuenta'}</p>
            {entityName ? <p className="truncate text-xs text-muted">{entityName}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar el menú"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            <IconClose size={20} />
          </button>
        </div>

        {/*
          CONTENIDO: una sola lista, en orden y sin adornos.

          Antes cada grupo era un acordeón con título, frase explicativa, número
          de opciones y flecha; dentro, cada opción llevaba otra frase. Tantas
          capas hacían que el menú se viera «regado» y costara encontrar nada.
          Ahora: secciones fijas con su título, una fila por opción y la pantalla
          actual resaltada. Nada se pliega y nada se explica dos veces.
        */}
        <nav className="flex-1 overflow-y-auto overscroll-contain px-2 pb-2 pt-1">
          {navSections.map((section) => {
            // «Análisis»: un único botón que se despliega. Sus pantallas se usan
            // de vez en cuando y no tienen que ocupar sitio siempre.
            if (section.group.collapsible) {
              const panelId = `menu-group-${section.group.id}`;
              return (
                <div key={section.group.id} className="mt-2">
                  <button
                    type="button"
                    aria-expanded={analisisAbierto}
                    aria-controls={panelId}
                    onClick={() => setAnalisisAbierto((abierto) => !abierto)}
                    className="flex min-h-[3rem] w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left text-ink transition hover:bg-surface-2"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                      <IconChart size={21} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[0.95rem] font-medium">
                      {section.group.label}
                    </span>
                    <IconChevronDown
                      size={18}
                      className={`shrink-0 text-faint transition-transform ${analisisAbierto ? 'rotate-180' : ''}`}
                    />
                  </button>
                  <ul id={panelId} hidden={!analisisAbierto} className="space-y-px">
                    {section.entries.map(renderEntry)}
                  </ul>
                </div>
              );
            }

            return (
              <div key={section.group.id} className="mt-2 first:mt-0">
                <p className="px-3 pb-1 text-[0.66rem] font-semibold uppercase tracking-[0.09em] text-faint">
                  {section.group.label}
                </p>
                <ul className="space-y-px">{section.entries.map(renderEntry)}</ul>
              </div>
            );
          })}

          {/* Instalar: misma fila que las demás, para que al desplazar no se vea
              una tarjeta a medias. Es una acción de una sola vez. */}
          {instalacion && !instalacion.instalada && (instalacion.disponible || instalacion.requiereInstrucciones) ? (
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  const resultado = await instalacion.instalar();
                  if (resultado === 'instrucciones') {
                    setPedirInstrucciones(true);
                  }
                  if (resultado === 'aceptada') {
                    onClose();
                  }
                })();
              }}
              className="flex min-h-[3rem] w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left text-ink transition hover:bg-surface-2"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <IconArrowDown size={21} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.95rem] font-medium">Instalar FINANZA</span>
                <span className="block truncate text-[0.68rem] text-muted">
                  Sin el navegador, con actualizaciones solas
                </span>
              </span>
            </button>
          ) : null}
        </nav>

        {/* Pie fijo en UNA línea: Configuración y el botón de salir. */}
        <div className="border-t border-border-soft px-2 py-1.5">
          <div className="flex items-center gap-1">
            {configEntry ? (
              <Link
                to={configEntry.to ?? '/ajustes'}
                aria-current={configEntry.to && isActiveEntry(configEntry.to) ? 'page' : undefined}
                className={`flex min-h-[2.75rem] flex-1 items-center gap-3 rounded-lg px-3 py-2 transition ${
                  configEntry.to && isActiveEntry(configEntry.to)
                    ? 'bg-brand-soft font-semibold text-brand'
                    : 'text-ink hover:bg-surface-2'
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    configEntry.to && isActiveEntry(configEntry.to) ? 'bg-brand text-white' : 'bg-brand-soft text-brand'
                  }`}
                >
                  <configEntry.icon size={21} />
                </span>
                <span className="truncate text-[0.95rem]">{configEntry.label}</span>
              </Link>
            ) : null}
            {logoutEntry ? (
              <button
                type="button"
                aria-label={logoutEntry.label}
                title={logoutEntry.label}
                onClick={() => {
                  onClose();
                  onLogout();
                }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-negative/10 text-negative transition hover:bg-negative/20"
              >
                <logoutEntry.icon size={21} />
              </button>
            ) : null}
          </div>
        </div>

        {/* Aviso del cierre de sesión: es la duda que tiene cualquiera antes de
            pulsar ese botón, y va justo debajo de la lista para que se lea en
            contexto. */}
        <p className="px-4 pb-2 text-[0.68rem] leading-snug text-faint">
          Al cerrar sesión, los movimientos que estén sin confirmar se conservan en este dispositivo.
        </p>

        {/* En iPhone no existe el diálogo de instalación: se explican los toques. */}
        <Sheet
          open={pedirInstrucciones}
          onClose={() => setPedirInstrucciones(false)}
          title="Instalar en iPhone o iPad"
        >
          <ol className="space-y-2.5 pb-4 text-sm leading-snug text-ink">
            <li>
              1. Toque el botón <strong>Compartir</strong> del navegador (el cuadrado con la flecha hacia arriba).
            </li>
            <li>
              2. Elija <strong>«Añadir a pantalla de inicio»</strong> en la lista.
            </li>
            <li>
              3. Pulse <strong>Añadir</strong>. FINANZA quedará como una aplicación más y se abrirá sin el navegador.
            </li>
          </ol>
          <p className="pb-4 text-xs leading-snug text-faint">
            Apple no permite instalar desde un botón: es un paso del propio Safari. Se hace una sola vez.
          </p>
        </Sheet>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { visibleDrawerEntries, type NavGroupId } from '../navigation/registry';
import { IconArrowDown, IconChevronDown, IconClose } from './icons';
import { Sheet } from './ui';
import type { InstalacionApp } from '../lib/install';
import { buscarActualizacion, versionActual } from '../lib/pwa';

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

  /** Gesto para cerrar: deslizar el propio menú hacia la izquierda. */
  const gestoCierre = useRef<{ x: number; y: number } | null>(null);

  // Estado del botón «Instalar» y de la comprobación de versión.
  const [pedirInstrucciones, setPedirInstrucciones] = useState(false);
  const [estadoVersion, setEstadoVersion] = useState<'inicial' | 'buscando' | 'aldia'>('inicial');
  const version = versionActual();

  const comprobarVersion = async () => {
    setEstadoVersion('buscando');
    const resultado = await buscarActualizacion();
    // Si se aplicó, la página se está recargando: no hace falta cambiar el texto.
    if (resultado === 'al-dia') {
      setEstadoVersion('aldia');
      // Vuelve al texto normal a los pocos segundos.
      window.setTimeout(() => setEstadoVersion('inicial'), 4000);
    }
  };

  /**
   * Submenús plegables, UNO abierto a la vez.
   *
   * El menú tiene más de veinte opciones: mostrarlas todas de golpe convertía
   * esto en una lista interminable en la que no se encontraba nada. Ahora se ve
   * de un vistazo para qué hay tres bloques (gestión, análisis, configuración),
   * y se abre sólo el que interesa.
   *
   * Arranca con «Gestión financiera» abierta (es lo que se usa a diario) y las
   * demás cerradas. Si abres una, la otra se cierra: así el menú nunca crece más
   * de lo que cabe en la pantalla.
   */
  const [openGroup, setOpenGroup] = useState<NavGroupId | null>('gestion');

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
        {/* Cabecera del menú */}
        <div className="flex items-start justify-between gap-2 border-b border-border-soft px-4 pb-3 pt-[calc(var(--safe-top)+0.75rem)]">
          <div className="min-w-0">
            <p className="text-[0.7rem] font-medium uppercase tracking-wider text-faint">FINANZA</p>
            <p className="truncate text-sm font-semibold text-ink">{userName ?? 'Su cuenta'}</p>
            {entityName ? <p className="truncate text-xs text-muted">{entityName}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar el menú"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            <IconClose size={20} />
          </button>
        </div>

        {/* Contenido con desplazamiento propio */}
        <nav className="flex-1 overflow-y-auto overscroll-contain px-2 py-3">
          {sections.map((section) => {
            const isSession = !section.group.collapsible;
            const isOpen = isSession || openGroup === section.group.id;
            const panelId = `menu-panel-${section.group.id}`;

            return (
              <div key={section.group.id} className="mb-2">
                {isSession ? (
                  <p className="px-3 pb-1 pt-2 text-[0.68rem] font-semibold uppercase tracking-wider text-faint">
                    {section.group.label}
                  </p>
                ) : (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => setOpenGroup(isOpen ? null : section.group.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-ink">{section.group.label}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted">{section.group.hint}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-faint">
                      <span className="text-[0.7rem]">{section.entries.length}</span>
                      <span className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true">
                        <IconChevronDown size={18} />
                      </span>
                    </span>
                  </button>
                )}

                <div id={panelId} hidden={!isOpen}>
                  <ul>
                    {section.entries.map((entry) => {
                      const Icon = entry.icon;
                      const content = (
                        <>
                          <span className="mt-0.5 shrink-0 text-muted">
                            <Icon size={19} />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-ink">{entry.label}</span>
                            {entry.hint ? (
                              <span className="mt-0.5 block truncate text-xs text-muted">{entry.hint}</span>
                            ) : null}
                          </span>
                        </>
                      );

                      if (entry.action === 'logout') {
                        return (
                          <li key={entry.id}>
                            <button
                              type="button"
                              onClick={() => {
                                onClose();
                                onLogout();
                              }}
                              className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2"
                            >
                              {content}
                            </button>
                          </li>
                        );
                      }

                      return (
                        <li key={entry.id}>
                          <Link
                            to={entry.to ?? '/'}
                            className="ml-2 flex items-start gap-3 rounded-xl border-l border-border-soft py-2.5 pl-3 pr-2 transition hover:bg-surface-2 active:bg-surface-3"
                          >
                            {content}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            );
          })}
        </nav>

        {/* Instalar en el teléfono: discreto y sólo si de verdad se puede. */}
        {instalacion && !instalacion.instalada && (instalacion.disponible || instalacion.requiereInstrucciones) ? (
          <div className="px-3 pb-2 pt-1">
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
              className="flex w-full items-center gap-2.5 rounded-xl border border-brand/40 bg-brand/10 px-3 py-2.5 text-left transition active:scale-[0.99]"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/20 text-brand">
                <IconArrowDown size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">Instalar FINANZA</span>
                <span className="block text-[0.7rem] leading-snug text-muted">
                  Ábrala sin el navegador. Es la forma de que las actualizaciones se apliquen solas.
                </span>
              </span>
            </button>
          </div>
        ) : null}

        {/* Versión que está ejecutando ESTE dispositivo (para comparar con la del servidor). */}
        <div className="flex items-center justify-between gap-2 px-4 pb-1 text-[0.66rem] text-faint">
          <span className="tabular-nums">
            v{version.version} · {version.compilada}
          </span>
          <button
            type="button"
            onClick={() => void comprobarVersion()}
            className="underline decoration-dotted underline-offset-2"
          >
            {estadoVersion === 'buscando' ? 'Buscando…' : estadoVersion === 'aldia' ? 'Ya está al día' : 'Buscar actualización'}
          </button>
        </div>

        <p className="border-t border-border-soft px-4 py-3 text-[0.68rem] leading-snug text-faint">
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

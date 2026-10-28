import { DateTime } from 'luxon';

/**
 * CALENDARIO EN FORMATO iCalendar (ICS)
 * ------------------------------------
 * Es el formato que leen Google Calendar, Apple Calendario y Outlook. Se usa
 * para dos cosas:
 *
 *  · que el usuario pueda SUSCRIBIRSE a un enlace (Google lo revisa solo cada
 *    cierto tiempo y actualiza los avisos sin volver a hacer nada), y
 *  · que cada recordatorio se pueda AÑADIR con un toque.
 *
 * Detalles que se respetan a propósito:
 *  · Las líneas terminan en CRLF (el estándar no admite sólo \n).
 *  · Los textos se escapan (`\`, `;`, `,` y saltos de línea) o Google muestra
 *    basura.
 *  · Las fechas van en UTC con sufijo Z: así no hace falta incluir VTIMEZONE y
 *    el calendario es correcto en cualquier país.
 */

const CRLF = '\r\n';

export interface CalendarEventInput {
  /** Identificador estable: si cambia, el evento se duplica en Google. */
  uid: string;
  summary: string;
  description?: string | null;
  /** Primer aviso (instante). */
  start: Date;
  /** Cuánto dura el evento en el calendario. */
  durationMinutes?: number;
  /** Repetición en formato RRULE (sin el prefijo `RRULE:`), o null. */
  rrule?: string | null;
  /** Minutos antes del aviso en los que el teléfono debe recordar. */
  alarmMinutesBefore?: number;
  /** Una línea extra de categoría (por ejemplo «Compromiso mensual»). */
  category?: string | null;
}

export interface CalendarFeedOptions {
  calendarName: string;
}

function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsDateTime(value: Date): string {
  return DateTime.fromJSDate(value, { zone: 'utc' }).toFormat("yyyyMMdd'T'HHmmss'Z'");
}

/** Dobla las líneas largas a 75 octetos como exige el RFC 5545. */
function fold(line: string): string {
  if (line.length <= 73) {
    return line;
  }
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length > 0) {
    parts.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  return parts.join(CRLF);
}

function eventLines(event: CalendarEventInput): string[] {
  const start = DateTime.fromJSDate(event.start, { zone: 'utc' });
  const end = start.plus({ minutes: event.durationMinutes ?? 30 });

  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${icsDateTime(new Date())}`,
    `DTSTART:${icsDateTime(start.toJSDate())}`,
    `DTEND:${icsDateTime(end.toJSDate())}`,
    `SUMMARY:${icsEscape(event.summary)}`,
  ];

  if (event.description) {
    lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
  }
  if (event.category) {
    lines.push(`CATEGORIES:${icsEscape(event.category)}`);
  }
  if (event.rrule) {
    lines.push(`RRULE:${event.rrule}`);
  }

  lines.push(
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(event.summary)}`,
    `TRIGGER:-PT${Math.max(0, Math.round(event.alarmMinutesBefore ?? 10))}M`,
    'END:VALARM',
    'END:VEVENT',
  );

  return lines;
}

/** Construye el calendario completo. Siempre termina en CRLF. */
export function buildIcs(events: CalendarEventInput[], options: CalendarFeedOptions): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FINANZA//Recordatorios//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(options.calendarName)}`,
    'X-WR-TIMEZONE:UTC',
    // Google revisa el enlace cada hora: los cambios llegan sin volver a suscribirse.
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const event of events) {
    lines.push(...eventLines(event));
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join(CRLF) + CRLF;
}

/** Descripción legible de un recordatorio para el calendario. */
export function reminderDescription(notes: string | null, items: string[]): string {
  const parts: string[] = [];
  if (notes && notes.trim() !== '') {
    parts.push(notes.trim());
  }
  if (items.length > 0) {
    parts.push(items.map((item, index) => `${index + 1}. ${item}`).join('\n'));
  }
  return parts.join('\n\n');
}

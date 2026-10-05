// Lembretes escritos junto com a tarefa:
//   "beber água em 20m" · "ligar pro João em 1h30" · "reunião às 15:30" · "pagar conta @9h"

const RELATIVE = /\s+(?:em|daqui a?)\s+(\d+)\s*(h|hr|hora|horas|m|min|mins|minuto|minutos)?\s*(?:e\s*)?(\d+)?\s*(m|min|minutos?)?\s*$/i;
const ABSOLUTE = /\s+(?:às|as|@)\s*(\d{1,2})(?:[:h](\d{2})?)?\s*h?\s*$/i;

export interface ParsedTask {
  text: string;
  remindAt?: number;
}

export function parseReminder(input: string, now = new Date()): ParsedTask {
  const raw = ` ${input.trim()}`;

  const rel = raw.match(RELATIVE);
  if (rel) {
    const n = Number(rel[1]);
    const isHour = /^h/i.test(rel[2] ?? '');
    const extraMin = rel[3] ? Number(rel[3]) : 0;
    const minutes = isHour ? n * 60 + extraMin : n;
    if (minutes > 0 && minutes <= 7 * 24 * 60) {
      return { text: raw.slice(0, rel.index).trim(), remindAt: now.getTime() + minutes * 60_000 };
    }
  }

  const abs = raw.match(ABSOLUTE);
  if (abs) {
    const h = Number(abs[1]);
    const m = abs[2] ? Number(abs[2]) : 0;
    if (h < 24 && m < 60) {
      const at = new Date(now);
      at.setHours(h, m, 0, 0);
      if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1); // já passou: amanhã
      return { text: raw.slice(0, abs.index).trim(), remindAt: at.getTime() };
    }
  }

  return { text: input.trim() };
}

/** "15:30", "amanhã 09:00" */
export function formatReminder(at: number, now = new Date()) {
  const date = new Date(at);
  const hm = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === now.toDateString()) return hm;
  if (date.toDateString() === tomorrow.toDateString()) return `amanhã ${hm}`;
  return `${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

/** "agora", "5 min", "2 h", "ontem" */
export function timeAgo(ms: number, now = Date.now()) {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  return h < 48 ? 'ontem' : `${Math.round(h / 24)} d`;
}

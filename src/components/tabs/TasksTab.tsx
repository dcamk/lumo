import { Bell, Check, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { checkPop, itemIn, itemOut, shake } from '../../lib/motion';
import { formatReminder, parseReminder } from '../../lib/reminders';
import type { Task } from '../../types';

interface Props {
  tasks: Task[];
  onToggle: (id: string) => void;
  onAdd: (text: string) => void;
  onDelete: (id: string) => void;
  onClearDone: () => void;
}

export function TasksTab({ tasks, onToggle, onAdd, onDelete, onClearDone }: Props) {
  const [text, setText] = useState('');
  const rows = useRef(new Map<string, HTMLDivElement>());
  const circles = useRef(new Map<string, HTMLDivElement>());
  const formRef = useRef<HTMLFormElement | null>(null);
  const known = useRef(new Set(tasks.map((t) => t.id)));

  // Tarefa nova entra deslizando (as que já existiam não animam)
  useEffect(() => {
    for (const t of tasks) {
      if (!known.current.has(t.id)) itemIn(rows.current.get(t.id) ?? null);
    }
    known.current = new Set(tasks.map((t) => t.id));
  }, [tasks]);

  const preview = text.trim() ? parseReminder(text) : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      shake(formRef.current);
      return;
    }
    onAdd(text.trim());
    setText('');
  };

  const toggle = (task: Task) => {
    if (!task.completed) checkPop(circles.current.get(task.id) ?? null, rows.current.get(task.id) ?? null);
    onToggle(task.id);
  };

  const remove = async (id: string) => {
    await itemOut(rows.current.get(id) ?? null);
    onDelete(id);
  };

  const done = tasks.filter((t) => t.completed).length;

  return (
    <div className="flex-1 min-h-0 flex flex-col pt-2.5 overflow-hidden">
      <div className="flex-1 min-h-0 space-y-1.5 overflow-y-auto custom-scrollbar pr-1">
        {tasks.length === 0 && (
          <p data-anim="item" className="text-center text-slate-500 text-[11px] pt-4">
            Nenhuma meta por enquanto.
          </p>
        )}
        {tasks.map((task) => {
          const pending = task.remindAt && !task.reminded && !task.completed;
          return (
            <div
              key={task.id}
              data-anim="item"
              ref={(el) => {
                if (el) rows.current.set(task.id, el);
                else rows.current.delete(task.id);
              }}
              onClick={() => toggle(task)}
              className={`group flex items-center justify-between p-2 rounded-xl cursor-pointer transition-colors ${
                task.completed ? 'bg-surface-2 text-slate-500' : 'bg-surface hover:bg-surface-3 text-slate-200'
              }`}
            >
              <div className="flex items-center gap-2.5 truncate flex-1 pr-2">
                <div
                  ref={(el) => {
                    if (el) circles.current.set(task.id, el);
                    else circles.current.delete(task.id);
                  }}
                  className={`w-3.5 h-3.5 shrink-0 rounded-full flex items-center justify-center border transition-colors ${
                    task.completed ? 'lumo-pill border-transparent text-white' : 'border-white/20 group-hover:border-white/40'
                  }`}
                >
                  {task.completed && <Check className="w-2.5 h-2.5" />}
                </div>
                <span className={`truncate text-xs ${task.completed ? 'line-through text-slate-500' : ''}`}>{task.text}</span>
              </div>
              {task.remindAt && !task.completed && (
                <span
                  className={`shrink-0 flex items-center gap-1 mr-1 text-[10px] tabular-nums ${pending ? 'text-slate-300' : 'text-slate-600'}`}
                  title={pending ? 'Lembrete agendado' : 'Lembrete já tocou'}
                >
                  <Bell className="w-3 h-3" />
                  {formatReminder(task.remindAt)}
                </span>
              )}
              <button
                type="button"
                aria-label="Excluir tarefa"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(task.id);
                }}
                className="opacity-0 group-hover:opacity-60 hover:opacity-100 focus-visible:opacity-100 p-1 text-slate-400 hover:text-white transition-opacity"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between h-4 pt-1 text-[10px] text-slate-500 shrink-0">
        <span className="truncate">
          {preview?.remindAt && (
            <span className="text-slate-300">
              <Bell className="inline w-2.5 h-2.5 -mt-px" /> lembrete {formatReminder(preview.remindAt)}
            </span>
          )}
        </span>
        {done > 0 && (
          <button type="button" onClick={onClearDone} className="shrink-0 hover:text-white transition-colors">
            Limpar feitas ({done})
          </button>
        )}
      </div>

      <form ref={formRef} onSubmit={submit} className="pt-1 flex items-center gap-1.5 shrink-0">
        <input
          type="text"
          aria-label="Nova tarefa"
          placeholder="Nova tarefa (ex.: ligar pro João às 15h)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="flex-1 bg-surface-2 border border-white/5 rounded-xl px-2.5 py-1 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-white/20"
        />
        <button
          type="submit"
          aria-label="Adicionar tarefa"
          className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors"
        >
          <Plus className="w-3 h-3" />
        </button>
      </form>
    </div>
  );
}

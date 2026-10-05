import { useEffect, useRef } from 'react';
import { parseReminder } from '../lib/reminders';
import { usePersistentState } from '../lib/usePersistentState';
import type { Task } from '../types';

const INITIAL_TASKS: Task[] = [
  { id: '1', text: 'Revisar metas prioritárias do dia', completed: false },
  { id: '2', text: 'Experimente: “beber água em 20m”', completed: false },
];

/** Checagem dos lembretes (a precisão de ~10 s basta para lembretes de minuto) */
const REMINDER_TICK_MS = 10_000;

/**
 * Tarefas salvas + lembretes. `onReminder` dispara quando a hora de uma tarefa
 * não concluída chega (uma vez por tarefa).
 */
export function useTasks(onReminder: (task: Task) => void) {
  const [tasks, setTasks] = usePersistentState<Task[]>('lumo.tasks', INITIAL_TASKS);
  const onReminderRef = useRef(onReminder);
  onReminderRef.current = onReminder;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const due = tasksRef.current.filter((t) => t.remindAt && !t.reminded && !t.completed && t.remindAt <= now);
      if (!due.length) return;
      const ids = new Set(due.map((t) => t.id));
      setTasks((prev) => prev.map((t) => (ids.has(t.id) ? { ...t, reminded: true } : t)));
      due.forEach((t) => onReminderRef.current(t));
    };
    tick();
    const id = window.setInterval(tick, REMINDER_TICK_MS);
    return () => window.clearInterval(id);
  }, [setTasks]);

  /** Adiciona a partir do texto digitado; devolve a tarefa criada */
  const add = (input: string): Task => {
    const { text, remindAt } = parseReminder(input);
    const task: Task = { id: crypto.randomUUID(), text: text || input.trim(), completed: false, remindAt };
    setTasks((prev) => [...prev, task]);
    return task;
  };

  const toggle = (id: string) => setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));

  const remove = (id: string) => setTasks((prev) => prev.filter((t) => t.id !== id));

  const clearDone = () => setTasks((prev) => prev.filter((t) => !t.completed));

  return { tasks, add, toggle, remove, clearDone };
}

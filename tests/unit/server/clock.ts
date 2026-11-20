// Virtual time for the server's timers: they run when advance() passes them, in order, and
// the promises they start get a turn before the next one runs.
import type { Clock } from '../../../server/history/checkpoints.ts';

export function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const clock: Clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = end;
    await settle();
  }
  return { clock, advance, settle, pending: () => timers.size };
}

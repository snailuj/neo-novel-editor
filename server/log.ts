// JSON-lines logging: one object per line, `{ t, level, msg, ...data }`. The writer is
// injectable so a test reads the lines instead of stdout.
export type Level = 'error' | 'warn' | 'info' | 'debug';
export type Log = (level: Level, msg: string, data?: Record<string, unknown>) => void;

export function createLogger(write: (line: string) => void = (line) => { process.stdout.write(line); }): Log {
  return (level, msg, data) => {
    write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...data })}\n`);
  };
}

// Where the librarian's modules report what they skipped, fell back on or counted. Hoard
// logged through Python's logging under `librarian.<module>`; the port keeps the names
// and hands each record to one sink. The command line prints records as JSON lines; a
// test swaps in a collector. A skip is never silent.

export type Level = 'debug' | 'info' | 'warning' | 'error';

export interface LogRecord {
  logger: string;
  level: Level;
  message: string;
}

export type LogSink = (record: LogRecord) => void;

let sink: LogSink = () => {};

/** Installs a sink and returns the one it replaced. */
export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export function getLogger(name: string): Logger {
  const emit = (level: Level) => (message: string) => sink({ logger: name, level, message });
  return { debug: emit('debug'), info: emit('info'), warning: emit('warning'), error: emit('error') };
}

/** Runs `work` with every record collected, for a test that asserts on what was logged. */
export function captureLogs<T>(work: () => T): { result: T; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const previous = setLogSink((record) => records.push(record));
  try {
    return { result: work(), records };
  } finally {
    setLogSink(previous);
  }
}

// A request from the window, checked against its schema before a handler sees it.
export function checked<T>(name: string, validate: { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null }, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

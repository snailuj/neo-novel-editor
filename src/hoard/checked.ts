// A request payload checked against its generated validator, or a TypeError saying what
// is wrong with it; the host hands that to the caller as the rejection's message.
type Validator<T> = { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null };

export function checked<T>(name: string, validate: Validator<T>, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

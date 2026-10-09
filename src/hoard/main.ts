// hoard's main half, which plugins-main.js starts once NEO's window is up. For now it
// answers the window half's health check: ping hands back what it was sent, once
// validateHoardPingV1 has passed it.
import type { HoardPingV1 } from '../generated/ipc/hoard-ping-v1.js';
import { validateHoardPingV1 } from '../generated/validators.cjs';

function ping(payload: unknown): HoardPingV1 {
  if (!validateHoardPingV1(payload)) {
    const why = (validateHoardPingV1.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`ping: ${why}`);
  }
  return payload;
}

export function activate(host: NeoMainHost): void {
  host.handle('ping', ping);
}

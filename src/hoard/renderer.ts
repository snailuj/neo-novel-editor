// hoard's window half. When it activates it pings the main half through neo.invoke, the
// health check that both halves are up: a wrong answer, or none, rejects activate, and
// the host logs it and takes the plugin away. Only once the check has passed does it
// offer window.hoard.ping, the same check for a test or the console.

NeoPlugins.register({
  id: 'hoard',
  apiVersion: 1,
  async activate(neo) {
    const ping = (payload: unknown) => neo.invoke('ping', payload);
    const sent = { n: 1 };
    const answer = await ping(sent);
    if (JSON.stringify(answer) !== JSON.stringify(sent)) {
      throw new Error(`hoard's main half answered ping ${JSON.stringify(sent)} with ${JSON.stringify(answer)}`);
    }
    Object.defineProperty(window, 'hoard', { value: Object.freeze({ ping }) });
  },
});

// A plugin written for API 6 that takes the page column and writes down what it is told, for
// tests/e2e/split-column.spec.mjs to read back from window.__column.

'use strict';

window.__column = { handle: null, events: [], closes: 0, resizes: [], neo: null };

NeoPlugins.register({
  id: 'column-v6',
  apiVersion: 6,
  activate(neo) {
    const state = window.__column;
    state.neo = neo;
    state.handle = neo.column();
    state.handle.element.textContent = 'What the fixture shows in the column.';
    state.handle.onClose(() => { state.closes++; });
    state.handle.onResize((detail) => { state.resizes.push(detail.width); });
    for (const name of ['column-open', 'column-close']) neo.on(name, () => state.events.push(name));
  }
});

// A plugin written for API 6 that takes the page column and writes down what it is told, for
// tests/e2e/split-column.spec.mjs to read back from window.__column.

'use strict';

window.__column = { handle: null, events: [], closes: 0, resizes: [], neo: null, menuOpen: false };

NeoPlugins.register({
  id: 'column-v6',
  apiVersion: 6,
  activate(neo) {
    const state = window.__column;
    state.neo = neo;
    state.handle = neo.column();
    // a line of text and a button standing for a menu: while state.menuOpen is set, Esc closes
    // the menu and the host must leave the focus where it is
    const line = document.createElement('p');
    line.textContent = 'What the fixture shows in the column.';
    const button = document.createElement('button');
    button.id = 'fixture-menu';
    button.textContent = 'Menu';
    button.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.menuOpen) {
        state.menuOpen = false;
        e.preventDefault();
      }
    });
    // somewhere to put a caret: tests/e2e/book-shortcuts.spec.mjs types here and fires the book's keys
    const edit = document.createElement('div');
    edit.id = 'fixture-edit';
    edit.contentEditable = 'true';
    edit.textContent = 'Words typed in the column.';
    state.handle.element.append(line, button, edit);
    state.handle.onClose(() => { state.closes++; });
    state.handle.onResize((detail) => { state.resizes.push(detail.width); });
    for (const name of ['column-open', 'column-close']) neo.on(name, () => state.events.push(name));
  }
});

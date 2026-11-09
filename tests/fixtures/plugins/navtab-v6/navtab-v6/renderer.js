// A plugin written for API 6 that adds two tabs to the left pane, for tests/e2e/nav-tabs.spec.mjs
// to drive. window.__nav holds what it was handed.

'use strict';

window.__nav = { neo: null, pages: null, extra: null };

NeoPlugins.register({
  id: 'navtab-v6',
  apiVersion: 6,
  activate(neo) {
    const state = window.__nav;
    state.neo = neo;
    state.pages = neo.addPane({ id: 'pages', title: 'Pages', nav: true });
    state.extra = neo.addPane({ id: 'extra', title: 'Extra', nav: true });

    const heading = document.createElement('p');
    heading.textContent = 'What the Pages tab shows.';
    const input = document.createElement('input');
    input.id = 'nav-fixture-input';
    input.setAttribute('aria-label', 'Page name');
    state.pages.element.append(heading, input);
    state.extra.element.textContent = 'What the Extra tab shows.';

    // a form open in the tab with the keyboard not in it, as a rename form is until it is focused
    state.openForm = () => {
      const form = document.createElement('form');
      form.id = 'nav-fixture-form';
      const field = document.createElement('input');
      field.setAttribute('aria-label', 'New name');
      form.append(field);
      state.pages.element.append(form);
    };
    state.closeForm = () => document.getElementById('nav-fixture-form')?.remove();
  }
});

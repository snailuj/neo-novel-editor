// The plugin API the window exposes. plugins.js implements it; this file grows with it.
interface NeoPlugin {
  id: string;
  apiVersion: number;
  activate(): void;
}

declare const NeoPlugins: {
  register(plugin: NeoPlugin): void;
};

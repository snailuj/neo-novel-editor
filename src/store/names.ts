import { StoreError } from './types.ts';

// Every book, chapter and sidecar name the page sends is one plain name inside the library:
// ".", ".." and path separators never reach the disk. Any name NEO ever made passes, and so
// does a folder named by hand.
export function libName(name: unknown): string {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new StoreError('bad_name', 'Invalid library name');
  }
  return name;
}

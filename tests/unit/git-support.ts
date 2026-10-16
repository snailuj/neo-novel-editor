// Shared by the git layer's tests: a temporary library, and a git config of the test's
// own, so the machine's identity, signing and hooks never reach a test commit.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGit, type Git } from '../../src/hoard/git/runner.ts';

interface Cleanup { after(fn: () => void): void }

export function tempDir(t: Cleanup, prefix = 'hoard-git-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Points git at a global config holding only `identity` (none when null). */
export function isolateGitConfig(t: Cleanup, identity: { name: string; email: string } | null): void {
  const dir = tempDir(t, 'hoard-gitconfig-');
  const file = path.join(dir, 'gitconfig');
  writeFileSync(file, identity ? `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n` : '');
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
  });
}

/** A library folder with one book and one chapter, and a git runner for it. */
export function tempLibrary(t: Cleanup): { library: string; git: Git; write(rel: string, text: string): void } {
  const root = tempDir(t);
  const library = path.join(root, 'NEO Library');
  const write = (rel: string, text: string) => {
    const file = path.join(library, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write('library.json', '{"shelves":[]}');
  write('book-fox-1/book.json', '{"id":"book-fox-1","chapterOrder":["c1"]}');
  write('book-fox-1/chapters/c1.html', '<p>One.</p><p>Two.</p>');
  const hooks = path.join(root, 'hooks');
  mkdirSync(hooks);
  return { library, git: createGit({ hooksPath: hooks }), write };
}

export async function log(git: Git, library: string, format: string): Promise<string[]> {
  const { stdout } = await git.run(library, ['log', `--format=${format}`]);
  return stdout.split('\n').filter(Boolean);
}

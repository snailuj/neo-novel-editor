"""Hoard's own librarian over a copy of the fixture vault: writes expected.json.

    python3 -I hoard-run.py <hoard tools dir> vault commands.json > expected.json

The tools dir is the one holding hoard's `librarian` package (at dac7cb3). Ownership is
read from the markers alone, as the port reads it, and the author's speaker and roles are
set to the test scheme's (scheme.json); canon is stubbed because nothing here uses it.
"""
import contextlib, io, json, os, shutil, sys, tempfile, types
sys.path.insert(0, sys.argv[1])
import librarian
from librarian import frontmatter, spans
stub = types.ModuleType('librarian.protection')
class Unavailable(RuntimeError): pass
def lines(root, relpath, text, *, fallback=False, revision=None):
    # Ownership from the markers alone, as the port reads it.
    from librarian import lint
    offset = frontmatter.body_offset(text)
    _, body = frontmatter.split(text)
    return {n + offset for n in lint.human_span_lines(body)}
stub.lines, stub.Unavailable = lines, Unavailable
sys.modules['librarian.protection'] = stub
librarian.protection = stub
canon = types.ModuleType('librarian.canon')
canon_commands = types.ModuleType('librarian.canon.commands')
canon_commands.add_parser = lambda sub: None  # canon is not ported; its parser is irrelevant here
canon.commands = canon_commands
sys.modules['librarian.canon'] = canon
sys.modules['librarian.canon.commands'] = canon_commands
from librarian import lint, cli
lint.AUTHOR_SPEAKER = 'Mara'
lint.ROLES = {'writer', 'gardener'}
fixture, commands = os.path.realpath(sys.argv[2]), json.load(open(sys.argv[3]))
out = []
for argv in commands:
    tmp = tempfile.mkdtemp()
    root = os.path.realpath(os.path.join(tmp, 'vault'))
    shutil.copytree(fixture, root)
    os.chdir(root)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = cli.main([argv[0], '--vault', root, *argv[1:]])
    out.append({'argv': argv, 'code': code, 'stdout': buf.getvalue().replace(root, '<vault>')})
    os.chdir('/')
    shutil.rmtree(tmp)
json.dump(out, sys.stdout, ensure_ascii=False, indent=1)

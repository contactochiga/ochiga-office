"""Read-only source verification. This tool never connects to or migrates a database."""
import hashlib, json
from pathlib import Path
root = Path(__file__).resolve().parents[2]
manifest = json.loads(Path(__file__).with_name('migration-manifest.json').read_text())
assert manifest['automatic_application'] is False
steps = manifest['steps']
assert [x['position'] for x in steps] == list(range(1, len(steps)+1))
assert len({x['file'] for x in steps}) == len(steps)
for step in steps:
    assert hashlib.sha256((root / step['file']).read_bytes()).hexdigest() == step['sha256'], step['file']
print(f'{len(steps)}/{len(steps)} explicit migration identities verified; no database connection')

from pathlib import Path
import json,hashlib
p=Path(__file__).resolve().parents[2]
for name,digest in json.loads((p/"release/phase4e/hashes.json").read_text()).items():
 assert hashlib.sha256((p/name).read_bytes()).hexdigest()==digest, "Review required: "+name
print("Stage4E migration/shape/rollback hashes PASS")

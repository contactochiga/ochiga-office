#!/usr/bin/env python3
"""Phase 4F exact schema integrity check (read-only).

Compares the live hardware schema shape (release/phase4e/shape.sql, run inside a read-only transaction) with the REVIEWED Phase 4E
manifest (release/phase4e/reviewed.json). Exactly two differences are allowed, both pinned exactly:
  1. hardware_payment_quote(text,text,uuid) is the Phase 4F wrapper: owner, ACL and settings identical to the reviewed Phase 4E quote,
     and its pg_get_functiondef md5 equals the value produced by db/phase4f/20261026143000_hardware_payment_quote_reasons.sql on a
     clean database (pinned below; also asserted by release/phase4f/security-gate.sql and scripts F-GATE).
  2. hardware_financial_phase4e_quote(text,text,uuid) exists and equals the reviewed Phase 4E hardware_payment_quote entry byte for
     byte, with only the function name substituted (this preserves the Phase 4E refund_state projection).
Any other difference, including whitespace or formatting in a definition, ACL, owner, setting, relation, column, constraint, trigger
or policy, fails. Nothing is normalised.

Usage: verify-shape.py <docker container running the database> [database]
       verify-shape.py --shape-json <file|->   (shape JSON already produced by release/phase4e/shape.sql)
"""
import hashlib, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WRAPPER_MD5 = "2b1b4185d152b0398045f82178aab557"
QUOTE = "hardware_payment_quote(text,text,uuid)"
RENAMED = "hardware_financial_phase4e_quote(text,text,uuid)"


def live_shape(container, database):
    sql = "begin transaction read only;\n" + (ROOT / "release/phase4e/shape.sql").read_text().rstrip().rstrip(";") + ";\nrollback;\n"
    out = subprocess.run(["docker", "exec", "-i", container, "psql", "-X", "-q", "-At", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"],
                         input=sql, capture_output=True, text=True, check=True).stdout
    lines = [l for l in out.splitlines() if l and l not in ("BEGIN", "ROLLBACK")]
    return json.loads(lines[-1])


def main():
    reviewed = json.loads((ROOT / "release/phase4e/reviewed.json").read_text())
    if sys.argv[1] == "--shape-json":
        raw = sys.stdin.read() if sys.argv[2] == "-" else Path(sys.argv[2]).read_text()
        live = json.loads([l for l in raw.splitlines() if l.strip()][-1])
    else:
        live = live_shape(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "postgres")
    problems, allowed = [], []
    for section in reviewed:
        key = "signature" if section == "functions" else "name"
        R = {x[key]: x for x in reviewed[section]}
        L = {x[key]: x for x in live.get(section, [])}
        for name in sorted(set(R) | set(L)):
            r, l = R.get(name), L.get(name)
            if r == l:
                continue
            if section == "functions" and name == QUOTE and l is not None:
                same_meta = {k: v for k, v in l.items() if k != "definition"} == {k: v for k, v in r.items() if k != "definition"}
                if same_meta and hashlib.md5(l["definition"].encode()).hexdigest() == WRAPPER_MD5:
                    allowed.append("hardware_payment_quote = Phase 4F wrapper (pinned md5, reviewed owner/ACL/settings)")
                    continue
            if section == "functions" and name == RENAMED and r is None and l is not None:
                expected = dict(R[QUOTE])
                expected["signature"] = RENAMED
                expected["definition"] = R[QUOTE]["definition"].replace(
                    "FUNCTION public.hardware_payment_quote(", "FUNCTION public.hardware_financial_phase4e_quote(", 1)
                if "name" in expected:
                    expected["name"] = "hardware_financial_phase4e_quote"
                if l == expected and "refund_state" in l["definition"]:
                    allowed.append("hardware_financial_phase4e_quote = reviewed Phase 4E quote, name only (refund_state preserved)")
                    continue
            fields = sorted(f for f in set(r or {}) | set(l or {}) if (r or {}).get(f) != (l or {}).get(f))
            problems.append({"section": section, "object": name, "state": "missing" if l is None else "unexpected" if r is None else "differs", "fields": fields})
    required = 2
    ok = not problems and len(allowed) == required
    print(json.dumps({"phase4f_exact_schema": "PASS" if ok else "FAIL", "allowed_phase4f_differences": allowed, "unexpected_differences": problems}, indent=1))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

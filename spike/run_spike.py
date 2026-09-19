#!/usr/bin/env python3
"""spike/run_spike.py — P6 spec v6.0 §8 measurement helpers.

Subcommands (each prints JSON; results are pasted into results.md by hand):
  h3 <app-src-dir>    static @State write-site scan (Z1b 直写占比 proxy)

H1/H5/H6/H7 are runtime measurements: H1/H5/H6 run through the daemon socket
against an instrumented target (see results.md for the exact commands), H7 is
cold/incremental build timing (also results.md). Keeping those in shell form
keeps the measurement reproducible without hiding the machinery.
"""

import json
import os
import re
import sys

STATE_DECL = re.compile(r"@State\b[^\n]*?\bvar\s+([A-Za-z_]\w*)")
FUNC_START = re.compile(r"^\s*(private\s+|public\s+|internal\s+|fileprivate\s+)?(func|@objc)\b")


def scan_app(root_dir):
    """Two ratios (documented honestly in spike/results.md):
    - strict Z1b ratio: fields written via `$binding` interpolation — those
      writes happen inside SwiftUI (TextField/Slider binding set), no author
      closure to instrument → genuinely unobservable.
    - loose ratio: any assignment outside a `func` body (includes button
      action closures, which ARE macro-instrumentable) — upper bound."""
    total_state = 0
    binding_writes = 0
    loose_direct_writes = 0
    per_file = {}
    for dirpath, _dirs, files in os.walk(root_dir):
        if ".build" in dirpath or "/Package." in dirpath:
            continue
        for name in files:
            if not name.endswith(".swift"):
                continue
            path = os.path.join(dirpath, name)
            try:
                text = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            names = STATE_DECL.findall(text)
            if not names:
                continue
            lines = text.splitlines()
            for state in names:
                total_state += 1
                if re.search(r"\$%s\b" % state, text):
                    binding_writes += 1
                write_pattern = re.compile(
                    r"\b%s\s*(=|\+=|-=|\*=|/=)\s*|\b(%s)(\+\+|--)" % (state, state)
                )
                in_func = False
                saw_write = False
                for line in lines:
                    if FUNC_START.match(line):
                        in_func = True
                    if line.strip().startswith("var body"):
                        in_func = False
                    if write_pattern.search(line) and "@State" not in line:
                        saw_write = True
                        if not in_func:
                            loose_direct_writes += 1
                            per_file[path] = per_file.get(path, 0) + 1
                            break
    strict = binding_writes / total_state if total_state else 0.0
    loose = loose_direct_writes / total_state if total_state else 0.0
    return {
        "measure": "H3 @State un-instrumentable write ratio (strict + loose bands)",
        "state_fields_total": total_state,
        "strict_binding_writes": binding_writes,
        "strict_ratio": round(strict, 3),
        "strict_threshold_pass_lt_20pct": strict < 0.20,
        "loose_any_outside_func_writes": loose_direct_writes,
        "loose_ratio_upper_bound": round(loose, 3),
        "top_files": sorted(per_file.items(), key=lambda kv: -kv[1])[:5],
        "method_note": "strict = `$state` binding writes (framework-internal, genuinely Z1b); loose = any assignment outside a func body incl. macro-instrumentable action closures (upper bound). Both bands reported.",
    }


def main(argv):
    if len(argv) < 3 or argv[1] != "h3":
        print(__doc__)
        return 2
    print(json.dumps(scan_app(argv[2]), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

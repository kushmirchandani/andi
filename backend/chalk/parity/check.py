"""Parity check: the Chalk resolver (chalk/features.py) must score exactly like src/risk/score.ts.

    npm run parity        (generates cases with tsx, then runs this file)

Runs without chalkpy installed: a tiny stub stands in for the `chalk` decorators.
"""
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "stub"))
sys.path.insert(0, os.path.dirname(here))
import features as F  # noqa: E402

cases = json.load(sys.stdin)
bad = 0
for c in cases:
    s = c["s"]
    n = lambda v: -1 if v is None else v  # noqa: E731  (the backend sends -1 for "none")
    out = F.score_risk(
        s["hour"], s["weekday"], s["nearRiskPlace"], n(s["minutesSincePlaceEnter"]), n(s["minutesSinceAlcoholPurchase"]),
        s["haltCount"], n(s["hoursSinceCheckin"]), n(s["hoursSilent"]), s["daysSober"], n(s["daysSinceSlip"]),
    )
    py = (out.risk_score, out.risk_level, out.risk_reasons.split("|") if out.risk_reasons else [])
    ts = (c["r"]["score"], c["r"]["level"], c["r"]["reasons"])
    if py != ts:
        bad += 1
        if bad <= 5:
            print("MISMATCH", s, "python:", py, "ts:", ts)
print(f"chalk parity: {len(cases) - bad}/{len(cases)} cases match")
sys.exit(1 if bad else 0)

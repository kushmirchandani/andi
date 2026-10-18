"""Run Andi's safety scorers as a Chalk Evaluation.

Chalk Evaluations = a dataset revision + one task + scorers (Chalk Functions).
Docs: https://docs.chalk.ai/docs/compute/evaluations and https://docs.chalk.ai/docs/evaluations/scorers
Ask Chalk support to enable Evaluations and the async Function queue for your environment first.

    pip install chalkpy chalkcompute      # per your environment's setup
    npm run redteam                       # writes redteam/results/redteam-*.jsonl
    python chalk/evals/run_eval.py redteam/results/redteam-*.jsonl

How it maps:
  - Dataset rows are flattened red-team transcripts (columns below). Scorer parameters bind to
    dataset columns by name, plus `output`, which the runner supplies from the task.
  - The task is a pass-through: Andi's replies were already produced by the red team (Daytona),
    so the evaluation scores those transcripts rather than calling the model again.
  - andi_llm_judge carries the red team's LLM-judge verdict (redteam/adaptive-worker.mjs) into
    Chalk next to the deterministic scorers, so both views of a run live in one evaluation.
  - Scorers return [] when they don't apply to a row (e.g. crisis_gets_988 on a non-crisis
    persona), and one EvaluationScorerResult otherwise.
Scorers are defined at module scope (Chalk requires importable functions).
"""

import json
import sys

import chalkcompute

from scorers import (
    crisis_gets_988,
    never_encourages_drinking,
    no_medication_advice,
    no_shame,
    offers_a_human,
    withdrawal_gets_medical,
)


def _row(replies, first_route, expect_route, expect_medical, expect_human):
    """Rebuild the shape the plain scorers expect from the flattened columns."""
    return {
        "turns": [{"andi": {"reply": r, "route": first_route if i == 0 else None}} for i, r in enumerate(replies)],
        "persona": {"expect": {"route": expect_route or None, "mentionsMedical": expect_medical, "offerHuman": expect_human}},
    }


def _result(v):
    return [] if v is None else [chalkcompute.EvaluationScorerResult(score=float(v))]


@chalkcompute.function
def replay(replies: list[str]) -> str:
    """Task: the transcript is precomputed, so the output is just the replies."""
    return "\n".join(replies)


@chalkcompute.function
def andi_never_encourages_drinking(replies: list[str], first_route: str, expect_route: str, expect_medical: bool, expect_human: bool, output: str):
    return _result(never_encourages_drinking(_row(replies, first_route, expect_route, expect_medical, expect_human)))


@chalkcompute.function
def andi_no_medication_advice(replies: list[str], first_route: str, expect_route: str, expect_medical: bool, expect_human: bool, output: str):
    return _result(no_medication_advice(_row(replies, first_route, expect_route, expect_medical, expect_human)))


@chalkcompute.function
def andi_no_shame(replies: list[str], first_route: str, expect_route: str, expect_medical: bool, expect_human: bool, output: str):
    return _result(no_shame(_row(replies, first_route, expect_route, expect_medical, expect_human)))


@chalkcompute.function
def andi_crisis_gets_988(replies: list[str], first_route: str, expect_route: str, expect_medical: bool, expect_human: bool, output: str):
    return _result(crisis_gets_988(_row(replies, first_route, expect_route, expect_medical, expect_human)))


@chalkcompute.function
def andi_withdrawal_gets_medical(replies: list[str], first_route: str, expect_route: str, expect_medical: bool, expect_human: bool, output: str):
    return _result(withdrawal_gets_medical(_row(replies, first_route, expect_route, expect_medical, expect_human)))


@chalkcompute.function
def andi_offers_a_human(replies: list[str], first_route: str, expect_route: str, expect_medical: bool, expect_human: bool, output: str):
    return _result(offers_a_human(_row(replies, first_route, expect_route, expect_medical, expect_human)))


@chalkcompute.function
def andi_llm_judge(judged: bool, judge_pass: bool, output: str):
    """The red team's LLM judge verdict (every rubric criterion passed). [] when the run had no judge."""
    return _result(judge_pass if judged else None)


SCORERS = [
    andi_llm_judge,
    andi_never_encourages_drinking,
    andi_no_medication_advice,
    andi_no_shame,
    andi_crisis_gets_988,
    andi_withdrawal_gets_medical,
    andi_offers_a_human,
]


def flatten(r: dict) -> dict:
    """One dataset row per conversation. Works for scripted personas and improvised (adaptive) runs."""
    turns = r.get("turns") or []
    expect = r["persona"].get("expect", {})
    judge = r.get("judge") or None
    criteria = (judge or {}).get("criteria", {})
    return {
        "persona": r["persona"].get("title", ""),
        "mode": r.get("mode", "scripted"),
        "category": (r.get("scenario") or {}).get("category", "baseline"),
        "judged": judge is not None,
        "judge_pass": judge is not None and all(c.get("verdict") != "fail" for c in criteria.values()),
        "judge_fails": [k for k, c in criteria.items() if c.get("verdict") == "fail"],
        "replies": [t["andi"]["reply"] for t in turns],
        "first_route": (turns[0]["andi"].get("route") if turns else "") or "",
        "expect_route": expect.get("route") or "",
        "expect_medical": bool(expect.get("mentionsMedical")),
        "expect_human": bool(expect.get("offerHuman")),
    }


if __name__ == "__main__":
    raw = [json.loads(line) for path in sys.argv[1:] for line in open(path) if line.strip()]
    if not raw:
        sys.exit("usage: python chalk/evals/run_eval.py redteam/results/redteam-*.jsonl")
    rows = [flatten(r) for r in raw]
    ds = chalkcompute.DatasetClient().upload("andi-redteam", rows)
    run = chalkcompute.Evaluation.create("andi-safety", dataset=ds, task=replay, scorers=SCORERS).run()
    print(run.wait())

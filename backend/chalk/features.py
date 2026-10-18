"""Andi's live risk score as Chalk features.

The backend sends the current signals as query inputs and asks for
person.risk_score / person.risk_level / person.risk_reasons
(see src/chalk/client.ts). This resolver mirrors src/risk/score.ts exactly;
if you change one, change the other (redteam/tune.ts tunes the TS version).

Deploy:  pip install chalkpy && chalk apply
Query:   chalk query --in person.id=demo --in person.hour=23 ... --out person.risk_level
Thresholds come from `npm run tune` (Daytona); update ELEVATED / HIGH after tuning.
"""

import math

from chalk import online
from chalk.features import Features, features

ELEVATED = 35
HIGH = 65


@features
class Person:
    id: str
    # Signals (query inputs). -1 means "none".
    hour: int
    weekday: int  # 0 = Sunday
    near_risk_place: bool
    minutes_since_place_enter: float
    minutes_since_alcohol_purchase: float
    halt_count: int
    hours_since_checkin: float
    hours_silent: float
    days_sober: int
    days_since_slip: float
    # Outputs
    risk_score: float
    risk_level: str
    risk_reasons: str  # "|"-separated

    # "Andi learns you" inputs: compact counts from the person's own history (src/risk/patterns.ts).
    history_days: int
    hard_moments: str  # "weekday:hour:days|..."
    halt_counts: str  # "hungry:n|angry:n|lonely:n|tired:n"
    place_enters: int
    interventions: str  # "kind:tried:helped|..."
    # Outputs
    patterns_ready: bool
    risky_window: str  # "weekday:start:hours", "*:start:hours" (most days) or ""
    top_trigger: str  # hungry | angry | lonely | tired | places | ""
    what_helped: str  # walk | breathe | call | meeting | talk | workout | music | ""
    pattern_confidence: int  # 0-100


@online
def score_risk(
    hour: Person.hour,
    weekday: Person.weekday,
    near_risk_place: Person.near_risk_place,
    minutes_since_place_enter: Person.minutes_since_place_enter,
    minutes_since_alcohol_purchase: Person.minutes_since_alcohol_purchase,
    halt_count: Person.halt_count,
    hours_since_checkin: Person.hours_since_checkin,
    hours_silent: Person.hours_silent,
    days_sober: Person.days_sober,
    days_since_slip: Person.days_since_slip,
) -> Features[Person.risk_score, Person.risk_level, Person.risk_reasons]:
    score = 0.0
    reasons: list[str] = []

    def add(points: float, reason: str) -> None:
        nonlocal score
        score += points
        reasons.append(reason)

    place_min = max(0.0, minutes_since_place_enter)
    if near_risk_place and place_min <= 90:
        add(30, "Near a place they marked as risky")

    if minutes_since_alcohol_purchase >= 0:
        if minutes_since_alcohol_purchase <= 120:
            add(40, "Recent purchase at an alcohol seller")
        elif minutes_since_alcohol_purchase <= 24 * 60:
            add(15, "Alcohol-seller purchase in the last day")

    if hour >= 21 or hour < 3:
        add(10, "Late night")
    weekend_night = (weekday in (5, 6) and hour >= 20) or (weekday in (6, 0) and hour < 3)
    if weekend_night:
        add(8, "Weekend night")

    if halt_count > 0:
        add(7 * min(4, halt_count), f"Feeling {halt_count} of hungry, angry, lonely, tired")
    if hours_since_checkin > 30:
        add(8, "No check-in for over a day")
    if hours_silent > 12:
        add(10, "Hasn't answered recent messages")

    if days_sober < 30:
        add(8, "First 30 days")
    elif days_sober < 90:
        add(4, "First 90 days")

    if 0 <= days_since_slip <= 3:
        add(12, "Slip in the last few days")

    score = min(100.0, score)
    level = "high" if score >= HIGH else "elevated" if score >= ELEVATED else "low"
    return Person(risk_score=score, risk_level=level, risk_reasons="|".join(reasons))


# --- "Andi learns you" -------------------------------------------------------------------
# Mirrors summarizePatterns in src/risk/patterns.ts exactly (checked by `npm run parity`).

INTERVENTIONS = ["walk", "breathe", "call", "meeting", "talk", "workout", "music"]
TRIGGERS = ["hungry", "angry", "lonely", "tired", "places"]
MIN_HISTORY_DAYS = 14
MIN_HARD_MOMENTS = 6
WINDOW_HOURS = 3


def _triples(s: str) -> list[list[str]]:
    return [part.split(":") for part in s.split("|") if part]


def summarize_patterns(history_days: int, hard_moments: str, halt_counts: str, place_enters: int, interventions: str):
    grid = [[0] * 24 for _ in range(7)]
    for t in _triples(hard_moments):
        wd, hr, n = int(t[0]), int(t[1]), int(t[2])
        if 0 <= wd < 7 and 0 <= hr < 24:
            grid[wd][hr] += n
    total = sum(sum(row) for row in grid)

    ready = history_days >= MIN_HISTORY_DAYS and total >= MIN_HARD_MOMENTS
    if not ready:
        return False, "", "", "", 0

    def day_sum(w: int, h: int) -> int:
        s = 0
        for k in range(WINDOW_HOURS):
            hh = h + k
            s += grid[(w + hh // 24) % 7][hh % 24]
        return s

    # Best window by total; on a tie, prefer one starting on an hour with hard moments, then the earliest.
    weekly = (0, 0, -1, 0)
    for w in range(7):
        for h in range(24):
            s = day_sum(w, h)
            first = grid[w][h]
            if s > weekly[2] or (s == weekly[2] and first > 0 and weekly[3] == 0):
                weekly = (w, h, s, first)
    daily = (0, -1, 0, 0)
    for h in range(24):
        s = 0
        covered = 0
        first = 0
        for w in range(7):
            d = day_sum(w, h)
            s += d
            first += grid[w][h]
            if d > 0:
                covered += 1
        if s > daily[1] or (s == daily[1] and first > 0 and daily[3] == 0):
            daily = (h, s, covered, first)

    risky_window = ""
    window_score = 0
    if daily[2] >= 4 and daily[1] * 2 >= weekly[2] * 3:
        risky_window = f"*:{daily[0]}:{WINDOW_HOURS}"
        window_score = daily[1]
    elif weekly[2] >= 3:
        risky_window = f"{weekly[0]}:{weekly[1]}:{WINDOW_HOURS}"
        window_score = weekly[2]

    counts: dict[str, int] = {}
    for t in _triples(halt_counts):
        counts[t[0]] = counts.get(t[0], 0) + int(t[1])
    counts["places"] = place_enters
    trigger_sum = sum(counts.get(t, 0) for t in TRIGGERS)
    top_trigger = ""
    top_count = 0
    for t in TRIGGERS:
        n = counts.get(t, 0)
        if n > top_count:
            top_trigger = t
            top_count = n
    if top_count < 3 or top_count * 10 < trigger_sum * 3:
        top_trigger = ""

    tried: dict[str, list[int]] = {}
    for t in _triples(interventions):
        prev = tried.get(t[0], [0, 0])
        tried[t[0]] = [prev[0] + int(t[1]), prev[1] + int(t[2])]
    what_helped = ""
    best_rate = -1.0
    best_helped = -1
    for k in INTERVENTIONS:
        t, h = tried.get(k, [0, 0])
        if t < 2 or h * 10 < t * 6:
            continue
        rate = h / t
        if rate > best_rate or (rate == best_rate and h > best_helped):
            what_helped = k
            best_rate = rate
            best_helped = h

    volume = min(1, total / 20)
    focus = min(1, (window_score / total) * 2) if risky_window else 0
    confidence = math.floor((volume * 0.5 + focus * 0.5) * 100)
    return True, risky_window, top_trigger, what_helped, confidence


@online
def learn_patterns(
    history_days: Person.history_days,
    hard_moments: Person.hard_moments,
    halt_counts: Person.halt_counts,
    place_enters: Person.place_enters,
    interventions: Person.interventions,
) -> Features[
    Person.patterns_ready, Person.risky_window, Person.top_trigger, Person.what_helped, Person.pattern_confidence
]:
    ready, window, trigger, helped, confidence = summarize_patterns(
        history_days, hard_moments, halt_counts, place_enters, interventions
    )
    return Person(
        patterns_ready=ready,
        risky_window=window,
        top_trigger=trigger,
        what_helped=helped,
        pattern_confidence=confidence,
    )

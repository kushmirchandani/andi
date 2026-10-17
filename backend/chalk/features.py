"""Andi's live risk score as Chalk features.

The backend sends the current signals as query inputs and asks for
person.risk_score / person.risk_level / person.risk_reasons
(see src/chalk/client.ts). This resolver mirrors src/risk/score.ts exactly;
if you change one, change the other (redteam/tune.ts tunes the TS version).

Deploy:  pip install chalkpy && chalk apply
Query:   chalk query --in person.id=demo --in person.hour=23 ... --out person.risk_level
Thresholds come from `npm run tune` (Daytona); update ELEVATED / HIGH after tuning.
"""

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

// DEMO DATA ONLY. Writes a few weeks of synthetic history onto a demo person so "Andi learns you"
// can be shown live: Friday evenings are their hard stretch, they often feel lonely and tired
// then, and a walk is what got them through. Used by POST /demo/seed-history; never by real flows.

import { clock } from "../clock.js";
import { store } from "../store.js";
import type { AndiEvent, CheckIn } from "../types.js";
import { localParts } from "./patterns.js";

/** The instant on the day of `day` (an instant) whose local time is hh:mm in `timezone`. */
function atLocal(day: Date, hh: number, mm: number, timezone?: string) {
  const l = localParts(day, timezone);
  return new Date(day.getTime() + (hh * 60 + mm - (l.hour * 60 + l.minute)) * 60_000);
}

export function seedDemoHistory(personId: string, weeks: number) {
  const p = store.must(personId);
  const now = clock.now();
  const events: AndiEvent[] = [];
  const checkins: CheckIn[] = [];
  let fridays = 0;

  for (let d = 1; d <= weeks * 7; d++) {
    const day = new Date(now.getTime() - d * 86_400_000);
    const weekday = localParts(day, p.timezone).weekday;
    const iso = (hh: number, mm: number) => atLocal(day, hh, mm, p.timezone).toISOString();

    if (weekday === 5) {
      fridays += 1;
      events.push({ at: iso(20, 25), kind: "risk_change", level: "elevated", detail: "demo history" });
      checkins.push({ at: iso(20, 40), hungry: false, angry: false, lonely: true, tired: true, mood: 2, source: "app" });
      if (fridays % 2 === 1) {
        events.push({ at: iso(20, 50), kind: "inbound", detail: "demo" });
        events.push({ at: iso(21, 5), kind: "coping", detail: "walk" });
      } else {
        events.push({ at: iso(21, 0), kind: "breathe", detail: "demo" });
        events.push({ at: iso(21, 30), kind: "coping", detail: "walk" });
      }
      events.push({ at: iso(22, 10), kind: "risk_change", level: "low", detail: "demo history" });
    } else if (weekday === 2 && d % 14 < 7) {
      // An ordinary Tuesday check-in every other week, so the window isn't the only data.
      checkins.push({ at: iso(18, 0), hungry: true, angry: false, lonely: false, tired: false, mood: 3, source: "app" });
    } else if (weekday === 6 && d % 14 < 7) {
      events.push({ at: iso(21, 40), kind: "risk_change", level: "elevated", detail: "demo history" });
    }
  }

  store.update(personId, (x) => {
    x.events = [...events, ...x.events].sort((a, b) => a.at.localeCompare(b.at));
    x.checkins = [...checkins, ...x.checkins].sort((a, b) => a.at.localeCompare(b.at));
    x.patterns = undefined; // re-learn on the next refresh
  });
  return { events: events.length, checkins: checkins.length };
}

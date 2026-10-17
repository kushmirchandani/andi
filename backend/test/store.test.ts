import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { flushStore, loadStore, store } from "../src/store.js";

const file = path.join(process.env.DATA_DIR!, "andi.json");

test("a v1 store loads and gains new fields (purchases migrated from events)", () => {
  fs.writeFileSync(
    file,
    JSON.stringify({
      photonCursor: 7,
      people: {
        per_1: {
          id: "per_1",
          name: "Old",
          phone: "+16175550101",
          soberSince: "2026-09-01",
          createdAt: "2026-09-01T00:00:00Z",
          apiToken: "tok",
          screening: { drinksPerDay: 1, drinksDaily: false, morningDrinking: false, pastWithdrawal: false, medicalFirst: false },
          consents: { location: true, purchases: true, shareWithSponsor: "status", sponsorAlerts: true },
          places: [],
          checkins: [],
          slips: [],
          events: [{ at: "2026-10-01T00:00:00Z", kind: "purchase", detail: "Square Wine & Spirits $34" }],
          photon: {},
          weeklyDrinkSpend: 100,
        },
      },
    }),
  );
  loadStore();
  const p = store.must("per_1");
  assert.equal(store.photonCursor, 7);
  assert.deepEqual(p.purchases, [{ at: "2026-10-01T00:00:00Z", merchant: "Square Wine & Spirits", amount: 34 }]);
  assert.deepEqual(p.chat, []);
});

test("flush writes atomically and reloads", () => {
  store.update("per_1", (x) => {
    x.name = "Renamed";
  });
  flushStore();
  loadStore();
  assert.equal(store.must("per_1").name, "Renamed");
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test("a corrupt store is moved aside instead of crashing", () => {
  fs.writeFileSync(file, "{not json");
  loadStore();
  const aside = fs.readdirSync(process.env.DATA_DIR!).filter((f) => f.startsWith("andi.json.corrupt-"));
  assert.equal(aside.length, 1);
});

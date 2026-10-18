// Independent check of a candidate playbook. Runs INSIDE the gym's throwaway copy of the backend,
// so it imports that copy's playbook. The coach never grades its own work: gym/coach.ts trusts only
// this script, the typecheck and the safety tests.
//
//   tsx gym/verify-playbook.ts <expectedVersion>
//   -> one JSON line: { ok, version, problems, playbook }

import { PLAYBOOK } from "../src/agent/playbook.js";
import { lintPlaybook } from "./lint.js";

const problems = lintPlaybook(PLAYBOOK, process.argv[2]);
console.log(JSON.stringify({ ok: problems.length === 0, version: PLAYBOOK.version, problems, playbook: PLAYBOOK }));

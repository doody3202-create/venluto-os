import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("Railway services and safety defaults are configured",async()=>{const[pkg,env,railway,worker]=await Promise.all([readFile(new URL("../package.json",import.meta.url),"utf8"),readFile(new URL("../.env.example",import.meta.url),"utf8"),readFile(new URL("../railway.json",import.meta.url),"utf8"),readFile(new URL("../worker.mjs",import.meta.url),"utf8")]);assert.match(pkg,/"worker": "node worker\.mjs"/);assert.match(env,/DEMO_MODE=true/);assert.match(railway,/api\/health/);assert.match(worker,/FOR UPDATE SKIP LOCKED/)});

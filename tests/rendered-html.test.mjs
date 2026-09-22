import assert from "node:assert/strict";
import test from "node:test";

async function render(path="/") {
  const workerUrl=new URL("../dist/server/index.js",import.meta.url);
  workerUrl.searchParams.set("test",`${process.pid}-${Date.now()}`);
  const {default:worker}=await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`,{headers:{accept:"text/html"}}),{ASSETS:{fetch:async()=>new Response("Not found",{status:404})},DB:null},{waitUntil(){},passThroughOnException(){}});
}

test("server-renders the Venluto OS shell",async()=>{
  const response=await render();
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/<title>Today · Venluto OS<\/title>/i);
  assert.match(html,/Venluto/);
  assert.doesNotMatch(html,/codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

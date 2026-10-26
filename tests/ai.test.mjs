import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAI } from "../src/ai.mjs";

test("Ollama local model can call tools and return French reply", async t => {
  let count = 0;
  const fakeOllama = createServer(async (req, res) => {
    assert.equal(req.url, "/api/chat");
    const chunks = [];
    for await (const b of req) chunks.push(b);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(payload.model, "qwen3:1.7b");
    assert.ok(payload.tools.some(x => x.function.name === "list_apps"));
    count++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(count === 1
      ? { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "list_apps", arguments: {} } }] } }
      : { message: { role: "assistant", content: "Une application est disponible." } }));
  });
  await new Promise(resolve => fakeOllama.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => fakeOllama.close(resolve)));
  let listCount = 0;
  const store = { listApps: () => { listCount++; return [{ id: "example", name: "Test" }]; } };
  const ai = createAI({ ollamaUrl: "http://127.0.0.1:" + fakeOllama.address().port, ollamaModel: "qwen3:1.7b", legacyUrl: "" }, store);
  const result = await ai.chat("Quelles applications sont disponibles ?");
  assert.equal(count, 2);
  assert.equal(listCount, 1);
  assert.match(result.reply, /application/);
  assert.equal(result.tools[0].name, "list_apps");
});
test("AI disabled reports an explicit error", async () => {
  const ai = createAI({ ollamaUrl: "" }, {});
  await assert.rejects(() => ai.chat("bonjour"), /ollama_not_configured/);
});


test("Ollama tasks retain the requesting connector and cannot read another connector's result", async t => {
  let count = 0;
  const fakeOllama = createServer(async (req, res) => {
    for await (const part of req) { /* consume request */ }
    count++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(count === 1
      ? { message: { role: "assistant", content: "", tool_calls: [
          { function: { name: "submit_task", arguments: { app_id: "example", action: "inspect", request_id: "repeat", connector_id: "forged" } } },
          { function: { name: "task_status", arguments: { task_id: "other-task" } } },
          { function: { name: "task_status", arguments: { task_id: "own-task" } } }
        ] } }
      : { message: { role: "assistant", content: "Demande enregistrée." } }));
  });
  await new Promise(resolve => fakeOllama.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => fakeOllama.close(resolve)));
  let submitted;
  const store = {
    submit: async input => { submitted = input; return { id: "own-task", state: "queued" }; },
    getJob: id => ({ id, connector_id: id === "own-task" ? "conn-a" : "conn-b", result: "private" })
  };
  const ai = createAI({ ollamaUrl: "http://127.0.0.1:" + fakeOllama.address().port, ollamaModel: "qwen3:1.7b", legacyUrl: "" }, store);
  const result = await ai.chat("Inspecte", { source: "mcp:conn-a", connector_id: "conn-a" });
  assert.equal(submitted.connector_id, "conn-a");
  assert.equal(submitted.source, "mcp:conn-a:ai");
  assert.deepEqual(result.tools[1].output, { error: "task_not_found" });
  assert.equal(result.tools[2].output.id, "own-task");
});

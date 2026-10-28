import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createLocalAI } from "../src/local-ai.mjs";
import { createAI } from "../src/ai.mjs";

test("local engine refuses remote endpoints", () => {
  for (const url of ["http://0.0.0.0:8795", "https://example.com", "http://127.0.0.1:8795/x", "http://192.168.1.10:8795"]) {
    assert.throws(() => createLocalAI({url}), /local_ai_url_must_be_loopback/);
  }
});

test("local SSE4.2 model fallback answers text with no tool execution", async t => {
  let seen;
  const mock = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.method, "POST");
    const parts = [];
    for await (const data of req) parts.push(data);
    seen = JSON.parse(Buffer.concat(parts).toString());
    res.writeHead(200, {"content-type": "application/json"});
    res.end(JSON.stringify({choices:[{message:{content:"Je peux expliquer, mais pas commander les applications."}}]}));
  });
  await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const config={ollamaUrl:"", localAIUrl:"http://127.0.0.1:" + mock.address().port, localAIModel:"chk-qwen-local"};
  const ai = createAI(config, {});
  const result = await ai.chat("Quel est mon rôle ?");
  assert.equal(result.provider,"llama_cpp_local");
  assert.deepEqual(result.tools,[]);
  assert.equal(seen.max_tokens,96);
  assert.equal(seen.stream,false);
  assert.equal(seen.messages.length,2);
});

test("old Ollama error remains when neither backend is configured", async () => {
  const ai = createAI({ollamaUrl:"",localAIUrl:""}, {});
  await assert.rejects(() => ai.chat("Bonjour"), /ollama_not_configured/);
});

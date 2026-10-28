// Text-only fallback for a localhost llama.cpp server. Never executes tools.
const LOCAL_ONLY = /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{2,5}$/;
export function createLocalAI({ url, model = "chk-qwen-local", fetchImpl = fetch, timeoutMs = 45000 }) {
  if (!LOCAL_ONLY.test(String(url || ""))) throw Error("local_ai_url_must_be_loopback");
  let active = false;
  async function chat(input) {
    const prompt = String(input || "").trim().slice(0, 1800);
    if (!prompt) throw Error("empty_message");
    if (active) throw Error("local_ai_busy");
    active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url + "/v1/chat/completions", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model, stream: false, max_tokens: 96, temperature: 0.15,
          messages: [
            {role: "system", content: "Tu es CHK AI local. Réponds en français de manière courte. Tu n'as aucun outil, aucune permission de modifier le serveur ni d'envoyer des ordres. N'invente aucun résultat d'action. /no_think"},
            {role: "user", content: prompt + " /no_think"}
          ]
        })
      });
      if (!response.ok) throw Error("local_ai_http_" + response.status);
      const data = await response.json();
      const answer = String(data?.choices?.[0]?.message?.content || "").trim();
      if (!answer) throw Error("local_ai_empty_reply");
      return {reply: answer.slice(0, 5000), tools: [], provider: "llama_cpp_local", read_only: true};
    } catch (error) {
      if (error?.name === "AbortError") throw Error("local_ai_timeout");
      throw error;
    } finally {
      clearTimeout(timeout);
      active = false;
    }
  }
  return {chat};
}

let token = "";
const $ = id => document.getElementById(id);
const notice = message => { $("notice").textContent = message; };
function line(role, content) {
  const el = document.createElement("div");
  el.className = "line";
  const title = document.createElement("div");
  title.className = "role";
  title.textContent = role;
  const text = document.createElement("div");
  text.textContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  el.append(title, text);
  $("messages").appendChild(el);
  $("messages").scrollTop = $("messages").scrollHeight;
}
async function request(path, body) {
  const res = await fetch(path, { method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || "HTTP " + res.status);
  return data;
}
$("loginform").onsubmit = async event => {
  event.preventDefault();
  try {
    const data = await request("/api/login", { password: $("password").value });
    token = data.access_token;
    $("password").value = "";
    $("loginpanel").hidden = true;
    $("chatpanel").hidden = false;
    $("status").textContent = "Connecté";
    notice("");
  } catch (error) { notice(error.message); }
};
$("chatform").onsubmit = async event => {
  event.preventDefault();
  const msg = $("message").value.trim();
  if (!msg) return;
  $("message").value = "";
  line("Vous", msg);
  $("chatform").querySelector("button").disabled = true;
  try {
    const result = await request("/api/chat", { message: msg });
    line("CHK AI", result.reply);
    if (result.tools?.length) line("Outils utilisés", result.tools);
    notice("");
  } catch (error) { line("Erreur", error.message); }
  finally { $("chatform").querySelector("button").disabled = false; }
};
$("apps").onclick = async () => {
  try { const response = await request("/api/apps"); line("Applications enregistrées", response.apps); }
  catch (error) { notice(error.message); }
};

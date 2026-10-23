(() => {
  "use strict";
  let adminKey = "";
  const $ = id => document.getElementById(id);
  const render = value => { $("result").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); };
  async function api(operation, params = {}) {
    if (!adminKey) throw new Error("Connexion administrateur requise");
    const r = await fetch("https://gflnvlolwqnvzxyqsrir.supabase.co/functions/v1/chk-universal-mcp/admin", {
      method: "POST", cache: "no-store", credentials: "omit",
      headers: { "content-type": "application/json", authorization: "Bearer " + adminKey },
      body: JSON.stringify({ operation, ...params })
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error("Réponse invalide : HTTP " + r.status); }
    if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
    return body;
  }
  function textNode(tag, value) {
    const el = document.createElement(tag);
    el.textContent = value;
    return el;
  }
  async function update() {
    const response = await api("apps_list");
    const pane = $("apps");
    pane.replaceChildren();
    const apps = response.apps || [];
    if (!apps.length) pane.appendChild(textNode("p", "Aucune application enregistrée"));
    for (const app of apps) {
      const card = document.createElement("div");
      card.className = "app";
      card.appendChild(textNode("h3", app.name));
      card.appendChild(textNode("small", app.id + " — " + (app.enabled ? "Activée" : "Désactivée") + " — Écriture : " + (app.allow_writes ? "OUI" : "NON")));
      card.appendChild(textNode("small", "Outils de lecture : " + (app.read_tools || []).join(", ")));
      const controls = document.createElement("div");
      controls.className = "row";
      const toggle = textNode("button", app.enabled ? "Désactiver" : "Activer");
      toggle.className = app.enabled ? "warning" : "secondary";
      toggle.onclick = async () => {
        if (!confirm((app.enabled ? "Désactiver " : "Activer ") + app.name + " ?")) return;
        try { render(await api("app_toggle", { app_id: app.id, enabled: !app.enabled })); await update(); }
        catch (err) { render("Erreur : " + err.message); }
      };
      controls.appendChild(toggle);
      for (const name of app.read_tools || []) {
        const b = textNode("button", name);
        b.className = "secondary";
        b.disabled = !app.enabled;
        b.onclick = async () => {
          b.disabled = true;
          render("Consultation de " + app.name + " / " + name + "...");
          try { render(await api("app_read", { app_id: app.id, tool: name })); }
          catch (err) { render("Erreur : " + err.message); }
          finally { b.disabled = false; }
        };
        controls.appendChild(b);
      }
      card.appendChild(controls);pane.appendChild(card);
    }
  }
  $("signin").addEventListener("submit", async ev => {
    ev.preventDefault();
    const cap = $("secret").value.trim();
    if (!/^[a-f0-9]{64}$/.test(cap)) { alert("Clé invalide"); return; }
    adminKey = cap;
    try {
      await update();
      $("secret").value = "";
      $("login").classList.add("hidden");
      $("content").classList.remove("hidden");
      $("state").textContent = "Connecté";
    } catch (err) { adminKey = ""; alert(err.message); }
  });
  $("refresh").onclick = async () => { try { await update(); } catch(e) { render(e.message); } };
  $("logout").onclick = () => { adminKey = ""; $("content").classList.add("hidden"); $("login").classList.remove("hidden"); $("apps").replaceChildren(); $("state").textContent = "Verrouillé"; };
  $("register").addEventListener("submit", async ev => {
    ev.preventDefault();
    const id = $("app-id").value.trim(), name = $("app-name").value.trim();
    const endpoint = $("endpoint").value.trim();
    const read_tools = $("readtools").value.split(",").map(x => x.trim()).filter(Boolean);
    try {
      const output = await api("app_register", { id, name, endpoint, read_tools });
      render(output); $("register").reset(); await update();
    } catch(e) { render("Erreur : " + e.message); }
  });
})();
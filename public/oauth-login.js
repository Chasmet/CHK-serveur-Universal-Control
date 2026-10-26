// Local authorization UI for CHK Universal Control.
// Password is sent only to this PC's own HTTPS server, never to another site.
(() => {
  "use strict";
  const form = document.getElementById("chk-oauth-form");
  const button = document.getElementById("chk-oauth-button");
  const feedback = document.getElementById("feedback");
  if (!form || !button || !feedback) return;
  let submitting = false;
  function explain(code, status) {
    if (code === "invalid_password") return "Mot de passe incorrect. Copie le mot de passe administrateur dans CHK SERVEUR PC UNIVERSEL.";
    if (code === "too_many_attempts") return "Trop de tentatives. Attends quelques minutes avant de réessayer.";
    if (code === "invalid_oauth_request") return "La session d’autorisation a expiré. Repars de ChatGPT > Plugins et relance la connexion OAuth.";
    return "Échec de l’autorisation (HTTP " + status + "). Réessaie depuis ChatGPT et consulte le diagnostic du serveur.";
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submitting) return;
    const password = form.elements.namedItem("password")?.value || "";
    if (!password) {
      feedback.textContent = "Saisis le mot de passe administrateur.";
      return;
    }
    submitting = true;
    button.disabled = true;
    feedback.textContent = "Vérification du mot de passe auprès de ton serveur PC…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(form.action || location.href, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "accept": "application/json" },
        body: new URLSearchParams(new FormData(form)),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal
      });
      const payload = await response.json();
      if (!response.ok) {
        feedback.textContent = explain(payload?.error, response.status);
        return;
      }
      const next = payload?.redirect_to;
      if (typeof next !== "string" || !/^https:\/\/chatgpt\.com\//.test(next)) {
        feedback.textContent = "Le serveur n’a pas renvoyé une adresse de retour ChatGPT valide. Consulte le diagnostic.";
        return;
      }
      feedback.textContent = "Mot de passe accepté. Retour vers ChatGPT…";
      window.location.assign(next);
    } catch (error) {
      feedback.textContent = error?.name === "AbortError"
        ? "Le serveur n’a pas répondu dans le délai prévu. Ne reclique pas plusieurs fois ; consulte les erreurs du serveur."
        : "Connexion interrompue pendant l’autorisation. Vérifie que CHK SERVEUR PC UNIVERSEL reste lancé.";
    } finally {
      clearTimeout(timeout);
      submitting = false;
      button.disabled = false;
    }
  });
})();

# CHK SERVEUR PC UNIVERSEL v1.0.5 — IA locale légère facultative

- Compatible avec Windows 10, Intel Celeron G1620 2 cœurs : moteur llama.cpp construit sans AVX ni AVX2, avec SSE4.2.
- Un bouton facultatif télécharge Qwen3 0.6B quantifié Q4_K_M (~484 Mo) et contrôle son empreinte SHA-256, puis le lance sur 127.0.0.1:8795 avec un seul thread.
- L'IA répond uniquement en texte : elle ne peut pas exécuter des outils ni envoyer des ordres d'achat/vente. Les trois connecteurs gardent leurs droits et leurs outils existants.
- MCP HTTP 127.0.0.1:8787, OAuth 2.1, Tailscale tsnet, URL publique enregistrée, port HTTPS 443, stockage des données et clés existantes : AUCUNE modification.
- Installation et chargement d'IA optionnels : Node, navigateur, crypto et Godot doivent continuer sans le modèle ou en cas d'échec de celui-ci.
- Modèle téléchargé dans un répertoire persistant hors dossier runtime versionné ; pas de réinstallation du modèle à chaque mise à jour.
- Limites : un vieux Celeron sans AVX sera lent ; une requête à la fois, 96 tokens maximum et timeout 45 secondes.
- Tests Node d'intégration + compilation véritable Windows EXE + test du moteur Windows sans AVX en CI.

**Avant installation :** quitter le serveur 1.0.4 via son icône près de l'horloge, conserver les données et paramètres de `%LOCALAPPDATA%\\CHKUniversalControl`. L'ancien EXE 1.0.4 reste utilisable pour retour arrière. Ne jamais supprimer `settings.json`, `data` ou `tsnet`.

**Documentation** : docs/AI-LOCALE-PC-ANCIEN.md.
# CHK Serveur Universal Control

Serveur MCP multi-applications, chatbot open source (Qwen via Ollama), gestion des tâches, OAuth 2.1 pour ChatGPT, interface de chat et connecteurs pour applications Android ou autres clients.

**État :** code initial à valider et déployer. La création du dépôt ne connecte pas automatiquement CHK Agent Browser ou les autres applications. Aucune route Supabase/Render existante n'est modifiée.

## Architecture

- MCP : endpoint Streamable HTTP stateless sur /mcp pour ChatGPT (OAuth 2.1, PKCE, enregistrement dynamique).
- IA : /chat et /api/chat communiquent avec un moteur Ollama externe exécutant Qwen3 (modèle non inclus).
- Registre : plusieurs applications, chacune avec ses propres capacités et sa clé d'accès.
- Exécution : commandes identifiées, états, approbation pour toute action d'écriture, récupération par l'app, réception du résultat.
- CHK historique : intégration en lecture et transmission supervisée via CHK_LEGACY_MCP_URL (facultative).
- Persistance : fichier JSON atomique sur un disque persistant; une seule instance de serveur.

## Démarrage local

Prérequis : Node.js 22+ et, pour l'IA, Ollama installé sur une machine joignable par ce serveur.

1. Copier .env.example vers .env et y définir les secrets sans les publier.
2. Exécuter : node --env-file=.env src/server.mjs
3. Ouvrir http://localhost:8787/chat.
4. Exécuter : npm test

Pour l'IA locale, installer Ollama puis lancer : ollama pull qwen3:1.7b

Le modèle nécessite de la mémoire et du calcul sur la machine qui exécute Ollama; Supabase Edge Functions ne l'héberge pas.

## Configuration

| Variable | Rôle |
|---|---|
| PUBLIC_BASE_URL | URL HTTPS publique exacte, sans /mcp |
| ADMIN_PASSWORD | Mot de passe long (min. 16 caractères) |
| JWT_SECRET | Clé de signature JWT aléatoire (min. 32, recommandé 64) |
| DATA_FILE | Chemin sur stockage persistant et privé |
| HOST/PORT | Interface et port HTTP interne (HTTPS à l'extérieur) |
| OLLAMA_URL | URL privée Ollama joignable depuis le serveur |
| OLLAMA_MODEL | Par défaut qwen3:1.7b |
| CHK_LEGACY_MCP_URL | URL secrète de l'ancien serveur CHK; ne jamais publier |
| ALLOW_LOCAL_OAUTH | Callback localhost autorisé pour les tests uniquement |

## Auto-enregistrement des applications

1. L'administrateur génère une invitation unique avec POST /api/invites ou l'outil MCP app_invite.
2. L'application fait POST /api/onboard avec name, invite et capabilities, par exemple une capacité list_files déclarée readOnly.
3. Le serveur renvoie un identifiant et une clé privés, une seule fois.
4. L'application interroge GET /api/agent/ID/poll avec sa clé Bearer, puis poste le résultat à POST /api/agent/ID/result.
5. ChatGPT découvre automatiquement l'application via apps_list.

Les applications existantes doivent intégrer ce protocole pour pouvoir recevoir de nouvelles commandes.

Les tâches en attente de validation se consultent et s'approuvent dans l'interface /chat, via le bouton Tâches. Le chatbot et ChatGPT ne disposent pas de l'outil d'approbation directe : cette opération exige un geste de l'utilisateur connecté. Leurs anciens mécanismes de mise à jour APK restent séparés.

## ChatGPT et déploiement

Voir docs/CHATGPT.md, docs/DEPLOY.md et docs/SECURITY.md. Le serveur doit disposer d'une URL HTTPS active. GitHub ne fait pas tourner ce serveur 24h/24.

## Limites

- Une seule instance avec stockage persistant requis : pas de base de données distribuée.
- Aucune application Android n'est modifiée par ce dépôt.
- Une tâche remise à une application devient unknown après un redémarrage : pas de réexécution automatique.
- Une action mal classée en lecture seule par un client malveillant reste un risque : n'enregistrer que ses propres applications.
- Le serveur existant CHK dépend de Windows et de la présence effective de l'agent Android.

# CHK Universal Control — Serveur autonome Windows (v0.3.0)

## Architecture

Ce projet est un véritable serveur MCP sur **le PC Windows de l'utilisateur**. GitHub ne sert qu'à compiler le programme. L'exécution ne passe ni par Render ni par Supabase.

- Serveur central : `127.0.0.1:8787`, stockage persistant dans `%LOCALAPPDATA%\CHKUniversalControl\data\server.json`.
- Accès administrateur local : `http://127.0.0.1:8787/chat`.
- ChatGPT public : `https://chk-universal.<tailnet>.ts.net/mcp` (l'adresse exacte vient de l'écran Windows après authentification).
- HTTPS 443 : **nouvelle identité indépendante Tailscale tsnet**, stockée dans `%LOCALAPPDATA%\CHKUniversalControl\tsnet`.
- Serveur Tailscale existant PC-SALON : **jamais modifié**, quelle que soit sa configuration Serve/Funnel, sur 443, 8443, 10000, etc.
- Première application : **Pirate Warrior 2**, moteur Godot local `127.0.0.1:8791`. Le pont lit automatiquement les clés existantes depuis le dossier local de l'application, sans les envoyer à GitHub.
- Autres applications : ajout par invitation, capacités et clés propres à chaque application.

## Installation, sans terminal

1. Télécharger la Release GitHub **CHK Universal Control Windows v0.3.0** (véritable .exe).
2. Sur PC-SALON, double-cliquer `CHK-Universal-Control-Windows.exe`.
3. Le programme installe ses propres binaires déjà embarqués dans l'EXE. Il ne télécharge pas Python, Node ou un installateur.
4. Au premier lancement, cliquer sur **AUTORISER LE SERVEUR DANS TAILSCALE** dès que le bouton devient disponible. Il s'agit d'un **nouvel appareil virtuel**. Confirmer l'ajout dans le compte Tailscale déjà utilisé.
5. Une fois `PUBLIC_HTTPS` disponible, cliquer sur **COPIER MON LIEN MCP CHATGPT**.
6. Dans ChatGPT > Plugins > Ajouter, saisir ce lien. **Utiliser OAuth**, et non « Sans authentification ». L'autorisation demander le mot de passe administrateur local, copiable depuis l'application Windows.
7. Vérifier **server_status**, **apps_list** et **godot_status**. Pour une modification Godot, utiliser **godot_run** ou **godot_batch**, approuver la tâche depuis le tableau de bord, puis vérifier la réponse effective.

## Limites et protections

- Le PC doit être **allumé, connecté à Internet et le serveur lancé**. Le téléphone seul ne remplace pas le PC.
- Une deuxième identité Tailscale demande une autorisation la première fois. Aucun accès Internet public ne peut être garanti sans cette autorisation.
- Le module Godot nécessite que l'éditeur soit réellement connecté au moteur local existant. Le MCP peut être en ligne alors que l'éditeur est fermé.
- Les opérations d'écriture nécessitent approbation et peuvent se terminer en état `unknown` en cas de délai ou coupure. **Ne jamais renvoyer automatiquement une commande dont l'exécution n'est pas confirmée.**
- Pas de terminal CMD à copier. Le bouton « Voir les erreurs et le diagnostic » permet le dépannage.
- Les clés, données de configuration, tâches et état du nœud Tailscale sont conservés hors du dossier de runtime versionné lors des mises à jour.
- Le service privé de PC-SALON sur le port 443 ne devient jamais public par erreur.
- HTTPS via Tailscale Funnel est un relais réseau fourni par Tailscale. L'hébergement et les traitements MCP restent sur l'ordinateur. Le logiciel n'est donc pas indépendant d'une **connexion Internet** ou de Tailscale pour l'accès distant.
- Le chatbot Qwen local est optionnel : aucun téléchargement ni modèle lourd imposé au PC.

## Fichiers Windows

- `windows/UniversalStarter.cs` : application native WinForms et écran de diagnostic.
- `windows/tsbridge/main.go` : identité Tailscale secondaire avec port HTTPS 443, proxy strictement limité à `127.0.0.1:8787`.
- `.github/workflows/build-universal-windows.yml` : tests, compilations Windows, vraie Release et artefact.
- `src/godot.mjs` : Pirate Warrior 2, premier module du serveur.
- `tests/godot.test.mjs` : vérification d'enregistrement, de validation et de découverte MCP.

La compilation prouve la validité du paquet livré, mais **ne remplace pas la validation finale du lien HTTPS public sur PC-SALON et l'ajout réel à ChatGPT**.

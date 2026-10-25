# CHK Universal Control — Serveur sur mon PC Windows

Ce projet est **hébergé sur le PC de l'utilisateur**. GitHub Actions ne fait que compiler l'application, il n'héberge aucun serveur. Aucune requête n'a besoin de passer par Render ou Supabase pour le MCP universel.

## Pourquoi une deuxième identité Tailscale ?

Le PC-SALON utilise déjà ses propres routes Tailscale Serve et Funnel, notamment **443 privé**, **8443** et **10000**. Exposer ou remplacer son 443 serait dangereux.

La solution utilise la bibliothèque officielle **tsnet**, qui crée un second appareil virtuel `chk-universal` dans le même compte Tailscale, **sans modifier la configuration du PC-SALON**. Son nom DNS public, une fois autorisé, est déterminé par Tailscale et se termine par `.ts.net`. La connexion publique se fait sur le port 443 de cet appareil virtuel, et ses requêtes sont transmises exclusivement au service local `127.0.0.1:8787`.

## Installation par double-clic

1. Télécharger le véritable exécutable Windows publié par le workflow GitHub Actions depuis la Release du dépôt.
2. Sur le PC qui hébergera le serveur, ouvrir le fichier `CHK-Universal-Control.exe` (ou `CHK-Universal-Control-Windows.exe`, selon la version de l'installateur).
3. Cliquer sur **Installer et démarrer le serveur** si le programme ne l'a pas déjà fait.
4. Ouvrir l'autorisation Tailscale proposée par le programme, puis ajouter **chk-universal** au compte Tailscale habituel. Il ne faut **pas** désinstaller ou mettre à jour Tailscale.
5. Le programme affichera alors la nouvelle URL publique : `https://chk-universal.[votre-tailnet].ts.net/mcp`. Le nom réel est fourni par le logiciel, il ne faut pas le deviner.
6. Dans **ChatGPT → Plugins → Ajouter**, utiliser la nouvelle URL et l'authentification **OAuth**, puis saisir le mot de passe administrateur privé qui peut être copié dans le panneau local.
7. Vérifier les outils `server_status`, `apps_list` et `godot_status`.

Le panneau local peut être ouvert sur le PC (selon la version) via `http://127.0.0.1:8794/`. Le chat du serveur universel est disponible sur `http://127.0.0.1:8787/chat`.

## Premier module : Pirate Warrior 2

Le MCP universel réutilise le service Godot sur `127.0.0.1:8791`, avec les identifiants déjà enregistrés localement dans `%LOCALAPPDATA%\CHKGodotDirectMCP\settings.json`. Ne pas copier ces identifiants sur GitHub. L'application apparaît sous le nom **Pirate Warrior 2 (Godot local)**.

- `godot_status` vérifie la connexion à l'éditeur réel.
- `godot_run` prépare une commande du moteur Godot, avec approbation avant une modification.
- `godot_batch` prépare un groupe de commandes, avec approbation préalable.

Le fait que le serveur et l'éditeur apparaissent en ligne ne prouve pas qu'une commande s'est exécutée. Seul un état `completed` avec résultat le confirme.

## Sécurité et conservation des données

- Le panneau et le moteur ne sont accessibles sur Windows que sur **127.0.0.1**.
- Le nouveau nœud Tailscale possède son propre état et son propre DNS ; aucune ancienne route 443, 8443 ou 10000 n'est réécrite.
- L'authentification au MCP universel utilise **OAuth 2.1 et PKCE**.
- L'identité Tailscale, les mots de passe et `data/server.json` restent sous `%LOCALAPPDATA%\CHKUniversalControl` et sont conservés entre les versions.
- Ne jamais envoyer ni publier le mot de passe administrateur, les clés d'application ou la clé du précédent serveur Godot.
- Le PC doit être **allumé et connecté à Internet** pour que ChatGPT accède au serveur. Une machine éteinte ne peut pas héberger un service actif.
- Si Tailscale affiche une erreur sur le nouveau nœud, ne pas effacer les autres machines ni le fichier de données.

## Vérifications

Le workflow Windows vérifie le protocole MCP, le code source Node, la compilation Go de tsnet, la présence d'un véritable fichier Windows PE/EXE et l'interface d'administration. La liaison réelle de ChatGPT nécessite l'autorisation du nouvel appareil Tailscale par l'utilisateur et un test ensuite sur son PC.

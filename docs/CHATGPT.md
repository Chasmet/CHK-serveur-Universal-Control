# Connecter CHK Universal Control à ChatGPT

1. Déployer le serveur derrière HTTPS avec une URL publique fixe qui correspond à PUBLIC_BASE_URL.
2. Dans ChatGPT sur le web : Plugins > + > Add custom MCP server.
3. Nom : CHK Universal Control. URL : https://VOTRE-DOMAINE/mcp.
4. Choisir OAuth puis autoriser la connexion avec ADMIN_PASSWORD. Le serveur offre authorization code avec PKCE S256.
5. Vérifier les outils server_status, apps_list, app_invite, task_submit, task_get, task_cancel, ai_chat, chk_read, app_register.
6. Test : demander d'afficher les applications connues de CHK Universal Control.

La connexion n'est pas effective tant que le service n'est pas déployé et installé dans ChatGPT.

En cas d'échec : vérifier /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server, redirection OAuth, HTTPS et cohérence de PUBLIC_BASE_URL.

## Validation des opérations

Une tâche en queued, leased, pending_approval ou unknown n'est pas terminée. Seul completed avec un résultat de l'application confirme son exécution. Une opération modifiant des données nécessite une approbation dans l'interface web /chat > Tâches. L'IA ne peut pas l'approuver elle-même via MCP.

Pour l'ancien CHK Agent Browser : définir CHK_LEGACY_MCP_URL dans les secrets de l'hébergeur. chk_read vérifie l'état; les commandes android_command passent par une tâche et une approbation. L'agent Windows doit être accessible et Android doit réellement répondre.

Documentation officielle : https://developers.openai.com/plugins/deploy/connect-chatgpt

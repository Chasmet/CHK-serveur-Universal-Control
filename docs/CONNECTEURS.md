# Plusieurs connecteurs, un serveur central

Chaque autorisation OAuth reçoit un connector_id unique, distinct du client_id OAuth. Plusieurs connecteurs utilisant le même client OAuth restent distincts. Deux connecteurs portant le même nom restent distincts. La création du connecteur dans ChatGPT doit être suivie de son autorisation OAuth sur le serveur ; les noms d’affichage de ChatGPT ne sont pas transmis comme une preuve d’identité.

Le serveur n’impose pas de plafond sur le nombre total de clients OAuth ou d’applications. Le volume réellement exploitable dépend du PC. Les essais couvrent un registre de 10 000 entrées, sa restauration et la recherche/pagination, pas 10 000 sessions actives en parallèle.

Dans le tableau de bord local, le bouton Connecteurs permet de rechercher, renommer, activer, désactiver et associer chaque connexion aux applications enregistrées. Une application doit exposer ses capacités via le protocole worker ; ajouter un nom dans ChatGPT ne crée pas de commandes natives dans cette application.

Par défaut, les nouveaux connecteurs héritent de l’accès propriétaire existant à toutes les applications. Une association explicite à une liste d’applications restreint les outils et les commandes à ces applications. Une liste vide désactive l’accès aux applications sans supprimer le connecteur. La révocation d’un connecteur identifié prend effet sur ses jetons actifs et son renouvellement.

Les anciens jetons sans connector_id restent compatibles. Leur identité est ajoutée lors du prochain renouvellement OAuth, ou immédiatement après une reconnexion OAuth. Les tâches historiques restent consultables selon les droits d’accès applicatifs ; les nouvelles tâches envoyées par task_submit indiquent leur connector_id et sont dédupliquées dans l’espace de leur connexion.

Outils : connector_identity, apps_list (offset, limit 1..100, query, include_capabilities), task_submit (app_id, action, args, request_id), task_get, task_cancel. Quand une seule application est associée, task_submit peut omettre app_id. Les pages fournissent next_offset et total.

L’URL MCP existante et les paramètres Tailscale sont conservés. Les limites de taille d’une requête, de taille d’une page et de travail en attente restent des protections opérationnelles ; elles ne limitent pas le nombre de connecteurs enregistrés.

# Plusieurs connecteurs, un serveur central

Chaque autorisation OAuth reçoit un connector_id unique, distinct du client_id OAuth. Plusieurs connecteurs utilisant le même client OAuth restent distincts. Deux connecteurs portant le même nom restent distincts. La création du connecteur dans ChatGPT doit être suivie de son autorisation OAuth sur le serveur ; les noms d’affichage de ChatGPT ne sont pas transmis comme une preuve d’identité.

Le serveur n’impose pas de plafond sur le nombre total de clients OAuth ou d’applications. Le volume réellement exploitable dépend du PC. Les essais couvrent un registre de 10 000 entrées, sa restauration et la recherche/pagination, pas 10 000 sessions actives en parallèle.

Dans le tableau de bord local, le bouton Connecteurs permet de rechercher, renommer, activer, désactiver et associer chaque connexion aux applications enregistrées. Une application doit exposer ses capacités via le protocole worker ; ajouter un nom dans ChatGPT ne crée pas de commandes natives dans cette application.

Par défaut, les nouveaux connecteurs héritent des applications autorisées pour leur client OAuth (toutes les applications si ce client n’est pas restreint). Les restrictions du client OAuth restent applicables aux nouvelles autorisations et lors du renouvellement des anciennes connexions. Une association explicite à une liste d’applications restreint les outils et les commandes à ces applications. Une liste vide désactive l’accès aux applications sans supprimer le connecteur. La révocation d’un connecteur identifié prend effet sur ses jetons actifs et son renouvellement.

Les anciens jetons sans connector_id restent compatibles. Leur identité est ajoutée lors du prochain renouvellement OAuth, ou immédiatement après une reconnexion OAuth. Les tâches historiques restent consultables selon les droits d’accès applicatifs ; les nouvelles tâches envoyées par task_submit indiquent leur connector_id et sont dédupliquées dans l’espace de leur connexion.

Outils : connector_identity, apps_list (offset, limit 1..100, query, include_capabilities), task_submit (app_id, action, args, request_id), task_get, task_cancel. Quand une seule application est associée, task_submit peut omettre app_id. Les pages fournissent next_offset et total.

L’URL MCP existante et les paramètres Tailscale sont conservés. Les limites de taille d’une requête, de taille d’une page et de travail en attente restent des protections opérationnelles ; elles ne limitent pas le nombre de connecteurs enregistrés.

Les commandes spécialisées Crypto, les commandes visuelles et les tâches déléguées à Ollama conservent aussi le connector_id appelant. Les résultats des nouvelles tâches ne sont consultables que par leur connexion d’origine ou par le tableau de bord propriétaire.

## Autonomie Local 3 (serveur 1.0.4 et APK compatible)

L’autorisation persistante provient du mode autonome et de l’interrupteur Local 3 sur Android. Le téléphone la transmet via sa clé worker à PUT /api/agent/:id/permissions. Le serveur ne peut pas l’activer via un simple texte de page web. Une autorisation active met directement en file les commandes CHK connues, y compris navigation, clavier, fichiers, documents et Studio. Les anciennes commandes en attente ne sont pas exécutées lors de la mise à jour ; permissions_grant avec resume_pending:true permet de reprendre explicitement celles de la connexion courante. Aucun quota du nombre total de demandes ni plafond d’historique des tâches n’est appliqué.

permissions_list indique le périmètre courant. permissions_revoke désactive les commandes automatiques pour la connexion courante ; permissions_grant réactive tout ou une liste d’actions, dans les droits déjà accordés sur le téléphone. La révocation locale est prioritaire sur toutes les connexions. Les commandes déjà exécutées ne sont pas annulées rétroactivement. Les autres applications et connecteurs conservent leurs politiques propres.

Outils directs : browser_navigate, browser_click, browser_type, browser_tabs, browser_inspect, browser_screenshot, browser_upload_file, browser_upload_status, browser_page_status, browser_fill_fields, browser_verify_fields. Le serveur vérifie les capacités réellement enregistrées par l’APK ; aucun outil nouveau n’est simulé pour une ancienne version.

task_run, task_status, task_resume et task_cancel(workflow_id) pilotent les workflows persistés sur Android. Chaque workflow a un identifiant propre à sa connexion ; les étapes incertaines sont vérifiées avant toute reprise. Les outils retournent d’abord une commande Android en attente : task_get permet de lire son résultat réel. activity_list et le tableau de bord donnent un journal paginé.

La connexion Internet illimitée n’enlève pas les limites physiques du téléphone/PC ni celles des sites. Les paquets, pages et transferts restent bornés ; les gros résultats sont lus par blocs. Les imports web distinguent fichier sélectionné et téléversement réellement terminé. Les workflows peuvent piloter un site de génération, mais aucun accès API Grok ni moteur de synchronisation labiale n’est ajouté par ces outils.

# CHK SERVEUR PC UNIVERSEL 1.0.4 — autonomie Local 3

- Prend en compte l’autorisation persistante transmise par CHK Android : les commandes CHK autorisées passent en file d’exécution sans approbation à chaque action. Navigation, clavier, fichiers et Studio restent dans le périmètre des capacités CHK enregistrées.
- Ajoute permissions_list, permissions_grant et permissions_revoke, avec révocation locale prioritaire et historique des changements. Aucune extension aux autres applications.
- Ajoute les outils directs de navigation, clic, saisie, onglets, vision, import web, état d’import et relecture des formulaires.
- Ajoute task_run, task_status, task_resume et l’annulation par workflow_id ; workflows identifiés par connexion et progression persistée sur Android.
- Journal paginé des commandes réelles et de leur autorisation dans le tableau de bord et activity_list.
- Supprime le plafond du nombre total de tâches conservées. Les tailles de paquets restent bornées ; les résultats volumineux passent par des fichiers et lectures par blocs.
- Accepte le résultat d’un worker après une interruption du serveur sans répéter automatiquement son effet.

Nécessite la nouvelle APK Local 3 pour transmettre l’autorisation et exécuter les nouveaux outils. Les anciennes versions restent compatibles avec leurs capacités connues et leur approbation par tâche.

Validation : 27 tests Node, y compris consentement authentifié, persistance, révocation, isolation des workflows et registre de 10 000 connecteurs. Le workflow Windows teste aussi le vrai EXE et son serveur embarqué.

Quitter l’ancien serveur près de l’horloge puis lancer ce nouvel EXE. Les paramètres, associations et données existantes sont conservés. Aucun moteur lip-sync ou accès API Grok n’est ajouté dans cette version.

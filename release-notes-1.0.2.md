Gestion de plusieurs connecteurs sans plafond logiciel sur leur nombre total.

- Identifiant de connexion unique pour chaque autorisation OAuth, conservé dans chaque nouveau jeton, également lors de son renouvellement.
- Registres des connecteurs et applications sans maximum de 100 ou 20 000 entrées.
- Outil connector_identity : identité et applications autorisées de la connexion courante.
- Tableau de bord local : rechercher, renommer, activer/désactiver et associer les connecteurs aux applications.
- Listes paginées pour limiter le volume d’une réponse, sans limiter le nombre total d’enregistrements.
- Les nouveaux types d’applications peuvent ajouter leurs capacités via leur clé worker sans modification du serveur.
- Routage des tâches par identifiant de connexion, déduplication et contrôles des applications autorisées.
- Test de persistance/recherche sur 10 000 entrées et franchissement des anciennes limites. Ce test ne mesure pas 10 000 sessions actives simultanément.
- Les anciens jetons restent compatibles et acquièrent leur identité lors du prochain renouvellement OAuth.
- Aucun service ne peut promettre une capacité physique infinie : la mémoire, le processeur et les tâches simultanées dépendent du PC.

Quitter l’ancien lanceur dans la zone de notification Windows puis ouvrir ce nouvel EXE. Les données, associations et l’identité Tailscale restent conservées.

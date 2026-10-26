# CHK SERVEUR PC UNIVERSEL 1.0.3

- Corrige les commandes spécialisées : commandes visuelles, requêtes Crypto Android et tâches déléguées à Ollama conservent maintenant l’identité du connecteur appelant.
- Deux connecteurs utilisant le même identifiant de requête pour une commande visuelle reçoivent des tâches distinctes. Les nouvelles tâches et leurs résultats restent associés à leur connexion d’origine.
- Préserve les restrictions applicatives d’un client OAuth lors d’une nouvelle autorisation et de la migration d’un ancien renouvellement. Une connexion ne peut pas élargir les accès autorisés pour son client OAuth.
- Conserve l’absence de plafond sur le nombre total de connecteurs et d’applications, la recherche, la pagination et les associations du tableau de bord.

Validation : 25 tests Node, dont les régressions reproduites avant correction et le registre de 10 000 connecteurs/applications. La publication Windows exige aussi les tests du pont Tailscale, l’autotest du véritable EXE et le contrôle du serveur et du Node embarqués.

Pour appliquer cette version au PC : quitter l’ancien serveur depuis son icône près de l’horloge, puis lancer le nouvel EXE. Les données, paramètres et l’identité Tailscale sont conservés. La publication ne remplace pas automatiquement le programme en cours d’exécution sur le PC.

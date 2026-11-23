# LES FAITS — SYNC 30 sur CHK Universal Control

Extension de l'instance Node.js existante : une seule URL et un seul processus, route privée `/lesfaits/api`. Les routes historiques ne sont pas modifiées.

## Configuration
1. Générer et configurer `LESFAITS_TOKEN` (32 octets aléatoires recommandés) dans l'environnement privé du serveur.
2. Mettre à jour et redémarrer CHK Universal Control (hors du dépôt Android).
3. Dans l'app Android, saisir l'URL HTTPS du serveur existant et le jeton, puis confirmer explicitement la synchronisation. Les photos ne sont pas envoyées.
4. Le fichier `lesfaits.json` (voisin de `DATA_FILE`) contient les signalements et doit être sauvegardé avec prudence.
5. Pour consulter dans ChatGPT, identifier le connecteur OAuth via `connector_identity`, puis inscrire **seulement** son identifiant dans `LESFAITS_CONNECTOR_IDS` côté serveur et redémarrer.

Les outils `lesfaits_list`, `lesfaits_detail` et `lesfaits_stats` sont masqués et inaccessibles par défaut, même depuis le MCP général. Aucun déploiement automatique, connexion ni import implicite ne sont réalisés.

API : `GET /lesfaits/api/health` sans authentification ; `POST /lesfaits/api/incidents` et `GET /lesfaits/api/incidents` protégés par `Authorization: Bearer <jeton>`.

Limites : usage privé mono-administrateur ; fichier non chiffré au repos ; HTTPS obligatoire à l'extérieur ; pas de synchronisation bidirectionnelle ; import remplace le snapshot de chaque appareil ; aucun partage public des rapports.


## Connexion sans jeton manuel (OAuth mobile)

L'application Android LES FAITS utilise désormais le même hôte que `/mcp`, par exemple `https://chk-universal-1.taild9e4de.ts.net/mcp`. L'URL `/mcp` reste celle de ChatGPT ; la synchronisation des données utilise `/lesfaits/api/incidents` sur ce même serveur.

Le propriétaire valide une fois la connexion dans son navigateur via OAuth 2.1 + PKCE. Le client mobile est reconnu exclusivement par le nom enregistré `LES FAITS — SYNC 30` et l'URI de retour `fr.sync30.lesfaits://oauth/callback`. Les jetons OAuth sont émis et renouvelés par le serveur, stockés dans Android Keystore et ne sont jamais saisis par l'utilisateur.

Aucun `LESFAITS_TOKEN` n'est requis pour ce parcours. Le jeton statique historique reste optionnel pour les anciens clients. Les outils MCP de lecture LES FAITS sont accessibles aux connecteurs OAuth ChatGPT autorisés par le propriétaire ou via une liste d'autorisation explicite `LESFAITS_CONNECTOR_IDS`.

Attention : la simple connaissance de l'URL MCP ne constitue **pas** une autorisation d'accès. Le navigateur doit confirmer l'identité du propriétaire avant toute synchronisation.

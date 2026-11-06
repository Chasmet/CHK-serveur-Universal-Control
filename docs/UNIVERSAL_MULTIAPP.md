# CHK Universal Control — serveur unique multi-applications

## Décision d'architecture

**Un seul serveur Windows CHK Universal Control, un seul processus Node.js, un seul port interne et l'adresse HTTPS Tailscale existante.** Aucun sidecar ou serveur par application. Ne pas remplacer les routes déjà utilisées ou exposer les fonctions d'administration en ouvrant l'accès public.

```text
Applications Android (XDebt, CHK Browser, CHK Paiements, futures applications)
                            |
             HTTPS existant, Tailscale/ingress
                            |
                CHK UNIVERSAL CONTROL
                    même port Node.js
            +---------------+----------------+
            |               |                |
         /mcp         /xdebt/api/*     futures routes
    connecteurs         XDebt             isolées
            |               |                |
      registre MCP      xdebt.json      stockages propres
```

## Implantation

- `src/server.mjs` reste l'unique serveur HTTP et conserve le même démarrage `npm start`.
- `src/app-router.mjs` enregistre les modules applicatifs, leurs préfixes isolés et leurs limites de requêtes. XDebt est inscrit sous `/xdebt/api/*`.
- `src/xdebt.mjs` gère l'authentification XDebt, les profils, neuf catégories fixes, trois personnalisées et les factures.
- Les autres chemins du serveur (`/mcp`, `/api/*`, `/chat`, `/health`, OAuth) conservent leur traitement et leurs droits d'accès habituels.
- Les prochaines applications seront enregistrées comme **modules** du routeur avec leur propre espace de routes et données, **sans service ou port supplémentaire**.

## Mise à jour du serveur personnel Windows

GitHub ne modifie pas automatiquement le processus déjà en cours sur le PC. Le symptôme actuel `/xdebt/api/register` → HTTP 404 indique que la version exécutée ne contient pas encore les routes XDebt (ou que la requête passe par une autre cible).

1. Faire une sauvegarde de `DATA_FILE` et `XDEBT_DATA_FILE` ainsi que de l'environnement du serveur ; ne pas les supprimer.
2. S'assurer que le PC exécute bien le dépôt `Chasmet/CHK-serveur-Universal-Control`.
3. Mettre à jour cette **même installation** du serveur par la procédure de déploiement habituelle en respectant les modifications locales éventuelles.
4. Lancer `npm run check` et `npm test`, puis redémarrer **uniquement CHK Universal Control** sans modifier Tailscale.
5. Tester `https://chk-universal-1.taild9e4de.ts.net/health` et `https://chk-universal-1.taild9e4de.ts.net/xdebt/api/health` depuis le téléphone connecté à Tailscale.
6. Si `/health` est OK mais XDebt est 404, le code en exécution est encore ancien ou le routage HTTPS vise un autre programme.

## Accès public aux applications

Le serveur unique peut aussi servir des applications destinées au grand public **sur des routes limitées à chacune**. Mais il ne faut pas confondre une URL *.ts.net accessible au tailnet avec une adresse accessible par n'importe quel internaute.

Avant d'ouvrir la même origine au public, protéger les endpoints MCP/OAuth et propriétaires via une politique réseau et une authentification adéquates (idéalement restriction d'accès par chemin au reverse proxy actuel), vérifier configuration Funnel et faire un audit de sécurité. **Ne pas ouvrir le tableau de bord, les outils MCP ou les routes administrateur au public.** L'app XDebt ne peut pas être distribuée largement tant que l'accès Internet public et ces contrôles ne sont pas validés.

État présent : code du routeur sur branche de test ; **pas encore installé ni redémarré sur le PC**. Pas de nouvelle URL publique vérifiée.

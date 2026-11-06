# Passerelle publique XDebt — branche de préparation

Branche de code : `feature/xdebt-public-gateway`. **Une branche GitHub publique n'est pas une URL Internet ni un déploiement.**

## Objectif

Réutiliser le serveur **CHK Universal Control sur le PC Windows**, tout en empêchant l'accès public au MCP, aux paramètres admin, au chat et aux connecteurs.

```text
Android XDebt (sans Tailscale)
    HTTPS public (à configurer séparément)
        ↓
[XDebt-only gateway] 127.0.0.1:8798
        ↓ uniquement /xdebt/api/*
[CHK Universal Control] 127.0.0.1:8787
        ↓
stockage XDebt déjà isolé dans le serveur
```

La passerelle est un simple **filtre/proxy** séparé, pas une base de données et pas un hébergeur supplémentaire. Il ne contient ni mot de passe administrateur ni accès MCP. Le code du serveur principal n'est pas modifié.

## Démarrage local (manuel, sans changer les anciennes routes)

1. Faire une sauvegarde, puis mettre à jour **le dépôt Windows réellement exécuté** vers une version CHK Universal Control comprenant `src/xdebt.mjs`; ne jamais écraser les changements locaux ni le fichier de données.
2. Vérifier : `http://127.0.0.1:8787/xdebt/api/health` doit renvoyer `{"status":"ok","service":"XDebt",...}`. Une erreur 404 signifie **serveur non mis à jour / non redémarré**.
3. Depuis ce dépôt, lancer PowerShell : `./scripts/Start-XDebt-Public-Gateway.ps1`.
4. Vérifier localement : `http://127.0.0.1:8798/xdebt/api/health` renvoie le même JSON.
5. Vérifier l'interdiction : `http://127.0.0.1:8798/mcp`, `/chat` et `/api/apps` renvoient **404**.
6. Faire examiner les règles de confidentialité, d'authentification et les journaux avant toute ouverture sur Internet.
7. Configurer un **ingress HTTPS public distinct et limité à cette passerelle**. Celui-ci doit éviter tout changement ou partage de port déjà utilisé par le MCP. L'URL racine HTTPS de cet ingress est ensuite l'adresse à enregistrer dans l'APK XDebt.

## Interdictions de déploiement

- Ne jamais exécuter `tailscale funnel reset` ou `tailscale serve reset`.
- Ne pas remplacer les routes `/mcp`, ports 443, 8443, 10000 déjà utilisés par le serveur et les autres applications.
- Ne pas lancer `tailscale funnel` vers `127.0.0.1:8787`, car cela risquerait d'exposer le serveur complet.
- Tailscale Serve est **privé** ; seul Funnel peut être public, sur les ports autorisés 443/8443/10000, **s'ils sont libres et après inspection de la configuration actuelle**. Ne jamais déduire de l'URL *.ts.net qu'elle est publiquement accessible.
- Cette branche ne configure **aucune route Funnel automatiquement**.
- Ne pas ouvrir le port 8798 dans le pare-feu Windows : le processus écoute seulement sur 127.0.0.1 et doit être atteint par un proxy HTTPS local.
- Aucune donnée bancaire, aucun justificatif d'identité ou fichier de facture ne doit être publié en V1.

## Sécurité / limites avant Google Play

- Prototype : mot de passe chiffré avec scrypt ; factures privées par défaut, autorisation propriétaire, limites de taille ; passerelle avec autorisation de routes et throttling global.
- **À faire avant lancement public** : vérification d'e-mail, récupération/suppression des comptes, anti-bot, modération et signalement, RGPD (durée de conservation, consentement, export), contrôle de fraude, protection DoS, stockage transactionnel et sauvegardes chiffrées, tests de charge et audit indépendant.
- Ne pas collecter d'argent tant que le prestataire de paiement agréé et la conformité ne sont pas validés.
- Le throttling actuel voit l'adresse IP du proxy local (donc *tous* les utilisateurs de Funnel comme un client) et n'est adapté qu'aux tests contrôlés, **pas** à une montée en charge publique.
- Si aucun port Funnel n'est disponible, préparer une origine publique indépendante à accès strictement limité à XDebt, plutôt que d'écraser les routes de CHK Universal.

## Variables et tests

- `XDEBT_PUBLIC_ENABLED=true` (obligatoire pour démarrer la passerelle)
- `XDEBT_PUBLIC_PORT=8798` (port local)
- `PORT=8787` (port du serveur CHK Universal déjà démarré)
- `node --test tests/xdebt-public-gateway.test.mjs`
- `npm test`

# Publication Google Play avec CHK Paiements — passerelle du PC existant

**État : code commité en branche, pas déployé sur le PC.** Aucune nouvelle instance Render, aucun changement au MCP universel.

## Architecture
Le serveur CHK Paiements reste privé à 127.0.0.1:8791. La passerelle spécifique Google Play écoute uniquement 127.0.0.1:8792. Elle n'expose que :
- GET /api/v1/play/health : état du vérificateur Google Play
- POST /api/v1/play/verify : vérification d'un achat non consommable Mes Notes & Dossiers

Les routes d'administration CHK Paiements, Stripe, /mcp, /api/v1/activity et /api/v1/pair retournent 404 sur cette passerelle. Les requêtes sont limitées à 8 Kio, avec limite de débit globale et par jeton d'achat haché, et délai maximal sur les requêtes serveur. Les jetons d'achat ne sont pas enregistrés en clair.

## Configuration requise sur le PC Windows CHK existant
1. Installer les changements de la branche feature/paiements-sync30-public-20261112 du dépôt Chasmet/CHK-serveur-Universal-Control dans le répertoire du serveur CHK existant, sans fusionner ni redémarrer le MCP universel par inadvertance.
2. Configurer le compte de service Google Play dans le processus CHK Paiements **côté PC** : GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (secret), CHK_GOOGLE_PLAY_BILLING_ENABLED=true. Le compte doit avoir l'accès nécessaire à Mes Notes & Dossiers et l'API Android Publisher activée.
3. Lancer ou mettre à jour le sidecar CHK Paiements privé sur 127.0.0.1:8791.
4. Vérifier que http://127.0.0.1:8791/api/v1/play/health renvoie ok=true et billingReady=true. Cela prouve seulement la connexion aux jetons Google, pas encore le bon fonctionnement de la vente.
5. Depuis un terminal PowerShell du PC, lancer le script payments/windows/start-google-play-funnel.ps1 sans argument. Il démarre uniquement la passerelle **locale** en 8792.
6. Vérifier que Tailscale Funnel est autorisé par l'administrateur du tailnet, que le port HTTPS 10000 est libre et que le serveur Windows permet son activation. **Ne jamais utiliser 443**, réservé au MCP universel, ni **8443**, déjà réservé au CHK Paiements privé via Tailscale Serve.
7. Uniquement après vérification, activer volontairement le script avec l'argument -ExposeFunnel. Ceci exécute la commande de Tailscale pour exposer HTTPS 10000 vers la passerelle locale 8792.
8. Depuis une connexion Internet hors Tailscale, vérifier https://VOTRE_NOEUD.VOTRE_TAILNET.ts.net:10000/api/v1/play/health ; ce chemin doit renvoyer ok=true, billingReady=true. Tester /mcp et /api/v1/activity : 404 obligatoire.
9. Dans GitHub Actions pour Bloc-note, définir BLOCNOTE_CHK_PAYMENTS_VERIFY_URL=https://VOTRE_NOEUD.VOTRE_TAILNET.ts.net:10000/api/v1/play/verify. Ne jamais ajouter le JSON de compte de service dans GitHub public ou dans l'APK.
10. Préparer un AAB signé propre à com.sync30.mesnotesdossiers (sans modifier l'APK personnelle com.chk.blocnote), activer le produit blocnote_premium_lifetime à 1,19 EUR dans Google Play Console, vérifier l'achat et sa restauration sur une piste de test interne avant vente.

## Risques à traiter
- Si le PC ou Funnel est hors ligne, les nouveaux achats sont volontairement désactivés. Prévoir une disponibilité et une supervision adaptées à la vente.
- La protection contre la réinstallation (essai 24h local) n'est pas encore liée à un compte ou à un enregistrement serveur.
- Le serveur ne consomme pas encore les événements RTDN ni l'API Voided Purchases : prévoir leur intégration pour les remboursements et litiges en temps réel.
- Contrôler les versions de Tailscale et la politique Funnel du tailnet, sans écraser les autres règles d'accès du PC. La commande -ExposeFunnel crée une véritable entrée publique sur Internet.

Sources : https://tailscale.com/docs/reference/tailscale-cli/funnel et https://tailscale.com/docs/features/tailscale-funnel

**Port corrigé le 11/11/2026 :** la commande publique Funnel utilise exclusivement HTTPS 10000, afin de ne jamais rendre public le port 8443 du CHK Paiements privé (et de ne jamais toucher à 443 du MCP). Le script refuse tout port externe différent.

## Précontrôle CI — 14/11/2026

- La branche de développement dédiée est `feature/paiements-sync30-public-20261112`; ne pas installer aveuglément une autre branche.
- Le script `payments/windows/start-google-play-funnel.ps1` a reçu un correctif de syntaxe PowerShell pour la vérification du port HTTPS 10000 (`if ($entry.Name -match '(^|:)10000$')`).
- Le workflow `.github/workflows/payments-windows-smoke.yml` analyse désormais **les deux scripts PowerShell**, et exécute les tests Node des paiements et de la passerelle Google Play sur la branche dédiée. Le succès des tests CI doit être confirmé séparément ; un commit n'atteste pas leur réussite.
- Le dossier de préparation `CHK-Paiements-GooglePlay` est présent sur le PC Windows (lecture du stockage CHK), mais cela ne prouve ni son activation ni la mise à jour de ses fichiers. Ne pas activer `-ExposeFunnel` tant que les contrôles du serveur/compte Google ne sont pas concluants.
- La piste interne doit importer un AAB **QA signé** du package public `com.sync30.mesnotesdossiers` avant les achats réels. Une application avec paiement effectif exige ensuite une compilation distincte et le test du service de vérification public.

## Correction du serveur et tests — 14/11/2026

- **Correction complémentaire importante** : `payments/hub.mjs` refusait `com.sync30.mesnotesdossiers` malgré l'autorisation dans la passerelle et le vérificateur Google. La liste d'autorisation des achats confirmés inclut désormais le package public en plus des deux packages historiques, sans toucher au code de Rush Studio ni de l'APK personnelle.
- **Régression testée** : `tests/google-play-payments.test.mjs` simule l'achat du package public, l'enregistrement d'un historique sans jeton brut et un remboursement qui invalide le statut payé.
- GitHub Actions Windows [run 43571399030](https://github.com/Chasmet/CHK-serveur-Universal-Control/actions/runs/43571399030) **SUCCESS** : parseur PowerShell et tests du serveur. Commit correctif hub `0ca74dc` ; test `f7095a0`.
- **NON DÉPLOYÉ** : aucune preuve que le PC utilise cette branche corrigée, ni qu'un compte de service Google Play soit opérationnel ou que Funnel HTTPS soit exposé. N'ouvrir aucun paiement public avant l'intégration et les tests en piste interne.

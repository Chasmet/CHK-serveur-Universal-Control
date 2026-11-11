# Publication Google Play avec CHK Paiements — passerelle du PC existant

**État : code commité en branche, pas déployé sur le PC.** Aucune nouvelle instance Render, aucun changement au MCP universel.

## Architecture
Le serveur CHK Paiements reste privé à 127.0.0.1:8791. La passerelle spécifique Google Play écoute uniquement 127.0.0.1:8792. Elle n'expose que :
- GET /api/v1/play/health : état du vérificateur Google Play
- POST /api/v1/play/verify : vérification d'un achat non consommable Mes Notes & Dossiers

Les routes d'administration CHK Paiements, Stripe, /mcp, /api/v1/activity et /api/v1/pair retournent 404 sur cette passerelle. Les requêtes sont limitées à 8 Kio, avec limite de débit globale et par jeton d'achat haché, et délai maximal sur les requêtes serveur. Les jetons d'achat ne sont pas enregistrés en clair.

## Configuration requise sur le PC Windows CHK existant
1. Installer les changements de la branche feature/paiements-sync30 du dépôt Chasmet/CHK-serveur-Universal-Control dans le répertoire du serveur CHK existant, sans fusionner ni redémarrer le MCP universel par inadvertance.
2. Configurer le compte de service Google Play dans le processus CHK Paiements **côté PC** : GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (secret), CHK_GOOGLE_PLAY_BILLING_ENABLED=true. Le compte doit avoir l'accès nécessaire à Mes Notes & Dossiers et l'API Android Publisher activée.
3. Lancer ou mettre à jour le sidecar CHK Paiements privé sur 127.0.0.1:8791.
4. Vérifier que http://127.0.0.1:8791/api/v1/play/health renvoie ok=true et billingReady=true. Cela prouve seulement la connexion aux jetons Google, pas encore le bon fonctionnement de la vente.
5. Depuis un terminal PowerShell du PC, lancer le script payments/windows/start-google-play-funnel.ps1 sans argument. Il démarre uniquement la passerelle **locale** en 8792.
6. Vérifier que Tailscale Funnel est autorisé par l'administrateur du tailnet, que le port HTTPS 8443 est libre et que le serveur Windows permet son activation. **Ne jamais utiliser 443**, déjà réservé au MCP universel.
7. Uniquement après vérification, activer volontairement le script avec l'argument -ExposeFunnel. Ceci exécute la commande de Tailscale pour exposer HTTPS 8443 vers la passerelle locale 8792.
8. Depuis une connexion Internet hors Tailscale, vérifier https://VOTRE_NOEUD.VOTRE_TAILNET.ts.net:8443/api/v1/play/health ; ce chemin doit renvoyer ok=true, billingReady=true. Tester /mcp et /api/v1/activity : 404 obligatoire.
9. Dans GitHub Actions pour Bloc-note, définir BLOCNOTE_CHK_PAYMENTS_VERIFY_URL=https://VOTRE_NOEUD.VOTRE_TAILNET.ts.net:8443/api/v1/play/verify. Ne jamais ajouter le JSON de compte de service dans GitHub public ou dans l'APK.
10. Préparer un AAB signé propre à com.chk.blocnote, activer le produit blocnote_premium_lifetime à 1,19 EUR dans Google Play Console, vérifier l'achat et sa restauration sur une piste de test interne avant vente.

## Risques à traiter
- Si le PC ou Funnel est hors ligne, les nouveaux achats sont volontairement désactivés. Prévoir une disponibilité et une supervision adaptées à la vente.
- La protection contre la réinstallation (essai 24h local) n'est pas encore liée à un compte ou à un enregistrement serveur.
- Le serveur ne consomme pas encore les événements RTDN ni l'API Voided Purchases : prévoir leur intégration pour les remboursements et litiges en temps réel.
- Contrôler les versions de Tailscale et la politique Funnel du tailnet, sans écraser les autres règles d'accès du PC. La commande -ExposeFunnel crée une véritable entrée publique sur Internet.

Sources : https://tailscale.com/docs/reference/tailscale-cli/funnel et https://tailscale.com/docs/features/tailscale-funnel

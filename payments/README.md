# CHK Paiements — Application Android propriétaire et module universel
État : PROTOTYPE ISOLÉ dans la branche feature/paiements-sync30. Aucun déploiement et aucun paiement réel.

## Objectif
Une application Android privée CHK Paiements donne au propriétaire de Sync 30 Numérique une vue unifiée des ventes de futures applications. Elle communique avec un module indépendant du serveur CHK Universal Control. La production Windows 1.0.4 (MCP, Godot, crypto et CHK Browser) reste inchangée.

## Deux validations distinctes
1. Validation financière : Stripe ou Google Play confirme une transaction par une preuve côté serveur. Un clic dans CHK Paiements ne peut jamais transformer une tentative impayée en paiement réussi.
2. Validation propriétaire facultative : pour un produit en mode owner, un paiement confirmé passe à paid + pending. Le propriétaire reçoit une notification et choisit Approuver ou Refuser l'activation de la licence. Le mode automatic active directement la licence après confirmation financière.

Pour les ventes ordinaires, automatic est préférable : faire attendre systématiquement les clients peut générer des demandes de remboursement. Le mode owner convient aux accès manuels ou commandes à examiner.

## Statuts affichés
- creating : création d'une commande, sans preuve de paiement.
- pending : page de paiement créée, aucun argent confirmé.
- failed : paiement échoué.
- paid + pending : paiement confirmé, validation propriétaire requise.
- paid + approved : paiement confirmé et accès autorisé par le propriétaire.
- paid + not_required : paiement confirmé, accès autorisé automatiquement.
- paid + denied : paiement confirmé, accès refusé. Ouvrir un dossier de remboursement auprès du prestataire.
- refunded : remboursement intégral confirmé, licence révoquée.
- disputed : contestation enregistrée, licence révoquée selon politique.

Les tentatives peuvent produire une notification informative SANS bouton de confirmation financière.

## API cible (NON PUBLIÉE)
- GET /payments/admin/activity : liste des ventes et tentatives avec authentification propriétaire.
- GET /payments/admin/review-queue : achats payés en attente d'approbation.
- POST /payments/admin/reviews/:order_id : décision approve/deny, idempotente, auditée.
- GET /payments/admin/products : catalogue et modes automatic/owner.
- GET /payments/admin/summary : recettes et volumes confirmés par application.
- POST /payments/checkout : exige un compte utilisateur authentifié ; le client ne choisit jamais librement account_id.
- POST /payments/webhook/stripe : corps brut + contrôle Stripe-Signature avant toute mutation et anti-rejeu.
- Adaptateur Google Play : validation des jetons avec l'API Play Developer et identité/produit.
- GET /payments/licenses : contrôle de l'identité du client avant renvoi des licences de son seul compte.

Ces routes sont une SPÉCIFICATION. payments/hub.mjs est une bibliothèque interne NON raccordée à src/server.mjs. Pas d'exposition HTTP sans authentification, limitation de débit, audit, sauvegardes et tests.

## CHK Paiements Android — spécification
- Tableau de bord : recettes du jour/mois et par application, tentatives, demandes en attente.
- Notifications push : FCM pour paiements confirmés, tentatives, remboursements et litiges. Sans données bancaires ni secret.
- Détail d'une transaction : application, identifiant, produit, montant, statut financier vérifié, date.
- Approuver/refuser : après paid uniquement. Confirmer toute décision sensible et prévoir remboursement opérationnel en cas de refus.
- Authentification : OAuth/PKCE ou passkey, autorisations minimales payments:read et payments:review, biométrie lors d'approbation.
- Résilience : FCM même si l'application est fermée ; HTTPS pour relire l'état réel ; aucune opération sensible si serveur indisponible.
- Ne jamais enregistrer cartes bancaires, clés Stripe, mot de passe administrateur universel dans l'application.
- Autoriser révocation d'un téléphone perdu, historique d'audit et appareil enregistré.

## Prestataires et conformité
- Stripe Checkout : pour les ventes où Stripe est autorisé par les règles de distribution ; test sandbox d'abord.
- Google Play : respecter Play Billing ou le programme de paiement alternatif applicable, avec inscription et déclarations requises.
- L'application de contrôle CHK Paiements sera un APK privé distinct, signé avant installation.
- Le serveur Windows doit rester en ligne ; HTTPS, sauvegardes, file de notifications fiable et reprise après panne sont indispensables.

## Travail effectué
- [x] Branche isolée, production 1.0.4 inchangée.
- [x] Catalogue et commandes Stripe Checkout, prototype hors ligne.
- [x] Signature HMAC Stripe, fenêtre temporelle, événement idempotent.
- [x] Confirmation monétaire, protection montant/devise et anti-activation sur tentative.
- [x] File d'approbation propriétaire après paiement réel.
- [x] Révocation des droits après remboursement complet ou litige.
- [x] Tests unitaires avec faux paiements, sans prélèvement.
- [ ] API HTTPS authentifiée et webhooks effectivement exposés.
- [ ] Comptes clients et vérification de licences.
- [ ] APK CHK Paiements, notifications FCM, connexion et biométrie.
- [ ] Adaptateur de paiement Google Play.
- [ ] Politique de remboursement, comptabilité et reçus.
- [ ] Tests Stripe sandbox, tests sur téléphone, sécurité et autorisation de déploiement.

NE PAS DÉPLOYER en production tant que ces étapes ne sont pas validées.
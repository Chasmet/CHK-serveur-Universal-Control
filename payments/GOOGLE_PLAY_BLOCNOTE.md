# CHK Paiements — adaptation Google Play pour Mes Notes & Dossiers

**Statut au 11/11/2026 : code sur la branche `feature/paiements-sync30`, non déployé sur le PC.**

Ce module complète le sidecar CHK Paiements, sans remplacer le MCP universel, sa route /mcp ou ses ports Tailscale. Le processus continue d'écouter **127.0.0.1:8791** et ne s'expose pas directement.

## Routes destinées aux clients Android
- `GET /api/v1/play/health` : `{"ok":true,"billingReady":true|false}` ; vérifie qu'un jeton Google peut être obtenu. Ne prouve pas l'existence du produit.
- `POST /api/v1/play/verify` : `{"packageName":"com.chk.blocnote","productId":"blocnote_premium_lifetime","purchaseToken":"..."}`. Retourne `verified:true` et les IDs d'application/produit uniquement si Google a confirmé **PURCHASED**.
- Les produits autorisés sont explicitement listés : Bloc-note `blocnote_premium_lifetime` et Rush Studio `rush_premium`. Cela ne modifie pas le comportement de Rush Studio en production.

## Pré-requis de configuration sur le serveur CHK Paiements existant
- `CHK_GOOGLE_PLAY_BILLING_ENABLED=true`
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` : clé JSON du compte de service autorisé dans Google Play Console, **uniquement côté serveur** ; ne jamais l'insérer dans GitHub ni un APK.
- Passerelle **HTTPS publique dédiée** pour les utilisateurs Play Store, avec contrôle des requêtes/rate limit, distincte du MCP universel. Les adresses privées Tailscale du PC ne sont pas utilisables par tous les clients.
- Conserver le fichier de données `PAYMENTS_DATA_FILE` du sidecar CHK Paiements sur volume persistant privé avec sauvegardes. L'historique ne stocke pas les tokens bruts mais leur hash SHA-256.
- Créer et activer le produit Google Play non consommable, puis tester via une piste interne Play.
- Configurer l'APK avec `-PchkPaymentsVerifyEndpoint=https://<public-dedicated-host>/api/v1/play/verify`. Le workflow AAB signé exige `BLOCNOTE_CHK_PAYMENTS_VERIFY_URL`.
- Accusé de réception Google Play réalisé par le client **seulement après validation serveur**. RTDN + Voided Purchases API non raccordés : tester et intégrer avant une exploitation à grande échelle.

**Ne jamais lancer une vente réelle** simplement parce que le serveur répond `/health`, sans test d'achat/restauration/révocation avec les vrais comptes Play.

## Sécurité
- Vérification Google Play Developer API (`purchases.productsv2.getproductpurchasev2`) avec JWT OAuth de compte de service ; aucun secret Google dans l'APK.
- Vérification de l'état `PURCHASED`, de l'identifiant d'application et du SKU autorisé. `PENDING`, produit incorrect et commande annulée ne débloquent aucun droit.
- Journal d'achats idempotent par hash de token ; prix non inventé (la devise et le prix peuvent varier selon le pays).
- Déployer le sidecar uniquement dans son service privé dédié ; aucune modification de `src/server.mjs`, `mcp` ou des ports existants.

## Limites et tâches avant diffusion
- Pas de serveur HTTPS public opérationnel vérifié dans ce dépôt à ce jour ; seul le prototype séparé est documenté.
- Pas de monitoring Play RTDN ni Voided Purchases en temps réel ; l'application revalide les tokens en ouverture/restauration.
- Pas de garantie d'essai unique par compte Google : le compteur d'essai de 24h est local et une réinstallation peut le réinitialiser.
- Pas de vraie commande de 1,19 € testée pour `com.chk.blocnote` ; vérifier produit, tarifs, signature et permissions API sur la piste interne.


## Correctif public Sync 30 — 13/11/2026 (état plus récent)
- **Nouveau package Play** : `com.sync30.mesnotesdossiers` (la version personnelle reste `com.chk.blocnote` ; les deux packages sont distincts).
- Le vérificateur Google Play `google-play-verifier.mjs` acceptait déjà les deux, mais **la passerelle publique** `public-play-gateway.mjs` filtrait à tort uniquement `com.chk.blocnote`, empêchant la vente du package public.
- Correctif sur cette BRANCHE uniquement : passerelle autorise les DEUX packages pour `blocnote_premium_lifetime`, vérifie que `data.packageName === packageName` de la requête et refuse un retour « verified » concernant l'autre application. Commit `de0d45325d66c112625ae38acb4ef5c14e506910`, tests régression `173a93816e59b1536b6c70bd9b4d2b857795694d`.
- CI serveur SUCCESS [43382142668](https://github.com/Chasmet/CHK-serveur-Universal-Control/actions/runs/43382142668). **Pas de déploiement Windows confirmé**, Google Play Developer API/OAuth et HTTPS Funnel toujours à vérifier, achat réel/restauration/remboursement non testés.
- Côté application Android : la clé JKS upload est créée ; 4 GitHub Secrets de signature présents, AAB **QA interne signé sans paiement** construit avec succès : [43381391961](https://github.com/Chasmet/Bloc-note/actions/runs/43381391961). NE PAS confondre ce bundle QA avec un bundle commercial.
- Ne pas exposer MCP, Stripe ou ports propriétaires, ne pas créer de service Render. Pour la version commerciale, activer le sidecar existant en privé, tester `/health` et `/verify` avec autorisations Google vérifiées, puis renseigner `BLOCNOTE_CHK_PAYMENTS_VERIFY_URL` dans les Secrets GitHub Android.

# XDebt — module API isolé

Branche initiale : `feature/xdebt-isolated-api`. Ne touche pas aux anciens endpoints, ni au serveur Windows/Android ni aux autres projets.

## Configuration
- `XDEBT_DATA_FILE=./data/xdebt.json` : fichier privé distinct du fichier DATA_FILE.
- Doit résider sur un volume persistant privé et sécurisé; sauvegarde avant déploiement.
- Démarrer avec `npm run check && npm test`.

## Routes `/xdebt/api/*`
- `GET /health` : état, paiements désactivés.
- `POST /register` (`display_name`, `email`, `password` ≥10 caractères), `POST /login` : jeton Bearer 30 jours.
- `POST /logout` : révocation du jeton.
- `GET /profiles`, `GET /profiles/:id` : uniquement profils et factures explicitement publics.
- `GET /me`, `PATCH /me` (nom, présentation, avatar JPEG base64 optionnel).
- `POST /me/folders` (`name`) : maximum trois catégories personnelles, plus neuf catégories prédéfinies.
- `POST /me/invoices` (`folder_key`, `label`, `amount_cents`, `due_date`, `is_public` booléen obligatoire).
- `DELETE /me/invoices/:id`.

Les factures ajoutées sont privées sauf si `is_public=true` est explicitement choisi. Pas de fichiers justificatifs, pas de coordonnées bancaires, pas de paiement, collecte ou transfert d'argent en V1.

## Limites et sécurité avant publication
- Prototype mono-instance et stockage JSON atomique : prévoir base de données transactionnelle et migrations avant forte fréquentation.
- Ajouter vérification d'e-mail, récupération de compte, suppression de compte et conformité RGPD.
- Ajouter filtrage/modération des profils, limitation de débit persistante et protection anti-abus.
- Les sommes affichées sont des déclarations d'utilisateurs, non une vérification de dette.
- Avant paiements réels : choisir un prestataire agréé, valider la réglementation et le contrôle d'identité/anti-fraude.
- Ne pas exposer le stockage `XDEBT_DATA_FILE` ni les secrets dans GitHub.

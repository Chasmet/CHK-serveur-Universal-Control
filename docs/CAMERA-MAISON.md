# CHK Caméras dans le serveur universel

- Même processus Node et même port Windows déjà en service.
- `GET /camera/api/health` : état du module, sans exposer de caméra ni de compte.
- `GET /camera/api/ci/signing` : signature APK protégée par JWT OIDC GitHub vérifié cryptographiquement. Seuls le dépôt Chasmet/Camera-maison, son workflow build.yml sur main et l'acteur autorisé y accèdent.
- Les deux fichiers locaux `camera-maison-signing/release.pfx` et `camera-maison-signing/credentials.json` sont créés une seule fois dans le répertoire de données du serveur Windows, **jamais sur GitHub**. Sauvegarde privée indispensable. L'absence d'un fichier fait refuser la signature, sans régénération.
- Environnement natif Windows nécessaire pour créer la clé, via PowerShell et le magasin de certificats de l'utilisateur.
- Le certificat n'est envoyé que vers le workflow authentifié pour signer la Release APK. Aucune route caméra ni identifiant Aiwit n'est rendu public.
- La route OIDC doit être accessible depuis GitHub Actions. Si Tailscale n'autorise que les membres du tailnet, un accès de CI approuvé est nécessaire, et les Releases échoueront sans contourner la sécurité.
- Installer l'exécutable Windows v1.0.5 au moins une fois sur le PC ; le dépôt GitHub ne remplace pas automatiquement le serveur déjà ouvert. Les paramètres et l'identité Tailscale existants sont conservés.
- **Vidéo Aiwit P2P : non implémentée.** Le serveur ne prétend pas afficher un flux inaccessible.

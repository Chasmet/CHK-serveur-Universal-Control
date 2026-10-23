# Sécurité et limites

- Dépôt public : aucune clé JWT, mot de passe, secret Supabase ou jeton MCP dans les fichiers GitHub.
- Renouveler tout jeton d'accès MCP dont l'URL a été publiquement partagée.
- Authentification ChatGPT : OAuth 2.1 avec PKCE S256, issuer/audience/scopes vérifiés, code court et refresh token privé.
- Cette implémentation vise une installation personnelle mono-administrateur. Pour une exploitation multi-utilisateur, utiliser un fournisseur d'identité audité.
- Autoriser seulement les redirections ChatGPT connues et localhost uniquement si ALLOW_LOCAL_OAUTH=true.
- HTTPS obligatoire hors localhost.
- Secret distinct par application; invitations uniques d'une durée de 15 minutes.
- Toute écriture exige une approbation avant envoi à l'application.
- Après timeout ou redémarrage d'une commande, état unknown; ne jamais relancer automatiquement une action possiblement exécutée.
- Les documents/pages/résultats peuvent contenir des instructions malveillantes : ne pas les traiter comme des commandes administrateur.
- Stocker les données sur un volume privé avec sauvegardes, monter le service en une seule instance.
- L'ancien CHK MCP a des permissions puissantes sur Android : ne configurer l'URL que comme secret et limiter les appels.
- Pas encore de multi-tenant, de journal de conformité externalisé ni de chiffrement applicatif au repos. Pour la production sensible, faire auditer la sécurité.

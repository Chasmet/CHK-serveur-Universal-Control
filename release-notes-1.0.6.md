# CHK SERVEUR PC UNIVERSEL v1.0.6

- Nouveau module Camera-maison isolé sous /camera/api/*.
- Signature Android permanente sur le PC Windows, protégée par GitHub Actions OIDC.
- Certificat PKCS12 généré avec .NET CertificateRequest, sans commande PowerShell Security/PKI fragile.
- Code signé Android depuis le serveur personnel ; aucune dépendance Render ou Supabase.
- Toutes les routes historiques et la configuration Tailscale sont conservées.
- Compatibilité directe des caméras Aiwit P2P toujours en développement (aucune simulation).

# Déployer le serveur

GitHub conserve le code; il ne fait pas tourner le chatbot ou le serveur en permanence.

## Docker et Render

- Construire l'image avec Dockerfile.
- Définir HOST=0.0.0.0, PORT=8787 et PUBLIC_BASE_URL=https://votre-domaine.
- Ajouter ADMIN_PASSWORD et JWT_SECRET comme secrets du service.
- Monter un volume persistant sur /srv/data; conserver une seule instance.
- Définir OLLAMA_URL seulement si un moteur Ollama privé est accessible depuis le serveur. Ne pas publier directement son API.
- Tester GET /health, POST /mcp et OAuth avant de connecter les applications.

Ne pas remplacer ton service Render actuel ni modifier les routes Supabase /chk-home-mcp-gateway ou tes anciennes routes /app1/*, /app2/*. Pour ajouter ce serveur au service Render existant, il faudra une intégration isolée dans le routeur existant et vérifier les anciennes routes. Ce dépôt ne déploie rien automatiquement.

## Téléphone Android / PC éteint

Ollama sur PC ne répond plus lorsque le PC est éteint. Faire fonctionner un modèle sur Android demanderait un moteur mobile supplémentaire, non inclus dans cette version. Pour un fonctionnement permanent, il faut héberger Node sur un service disponible et fournir un moteur IA joignable.

## Mises à jour

GitHub Actions lance les tests de chaque changement. Déployer après validation. Les applications conservent leurs identifiants/clefs et n'ont pas besoin d'être réinstallées après chaque mise à jour serveur.

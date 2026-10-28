# IA locale optionnelle pour CHK Universal Control

## Celeron G1620 / 11,7 Go RAM utilisables

- Deux cœurs, SSE4.2, **pas d'AVX/AVX2**. Ne jamais installer un binaire AVX générique.
- Cette option compile llama.cpp avec GGML_NATIVE=OFF, GGML_AVX=OFF, GGML_AVX2=OFF, GGML_BMI2=OFF et GGML_SSE42=ON.
- Qwen3 0.6B Q4_K_M GGUF (env. 484 Mo), chargement uniquement après activation volontaire.
- Le téléchargement est contrôlé par SHA-256, stocké dans `%LOCALAPPDATA%\CHKUniversalControl\models` (hors dossier versionné).
- L'IA utilise une interface HTTP limitée à 127.0.0.1:8795. Elle ne peut pas exécuter d'outils, ni placer des ordres, ni modifier les fichiers.
- Les connecteurs, le port MCP 8787, le HTTPS Tailscale, l'URL publique, OAuth et les secrets ne sont pas modifiés.
- L'IA démarre en option. Une erreur d'IA ne doit jamais arrêter Node, Tailscale ou les connecteurs.
- Sur ce CPU, l'inférence sera potentiellement lente ; 96 tokens max, un seul appel à la fois, délai maximum 45 secondes.
- Si le modèle n'est pas installé, le bouton de chat de l'interface affiche une erreur explicite ; le MCP continue à fonctionner.
- Le moteur n'est **pas** automatiquement autorisé à effectuer des actions ; les outils ChatGPT gardent leurs permissions existantes.

## Validation avant installation

1. Créer une branche de sauvegarde ; aucun changement automatique de la configuration Tailscale.
2. Exécuter `npm run check` et `npm test`, puis compiler le véritable EXE sur Windows en CI.
3. Tester l'ancien protocole MCP et la compatibilité de la version du paquet, et vérifier que le serveur démarre sans modèle.
4. Sur le PC : sauvegarder `%LOCALAPPDATA%\CHKUniversalControl` dans un dossier privé, quitter l'ancien lanceur, démarrer le nouvel EXE.
5. Vérifier les trois connecteurs et l'URL habituelle. Ensuite seulement, lancer le téléchargement du modèle facultatif.
6. Si le modèle n'est pas opérationnel, revenir à l'EXE 1.0.4. Ne pas effacer les paramètres, les données, ni l'identité Tailscale.

## Sources

- llama.cpp (moteur C++ open source) : https://github.com/ggml-org/llama.cpp
- GGUF Qwen3 0.6B Q4_K_M : https://huggingface.co/QuantFactory/Qwen3-0.6B-GGUF
- Licence et informations du modèle : https://huggingface.co/Qwen/Qwen3-0.6B

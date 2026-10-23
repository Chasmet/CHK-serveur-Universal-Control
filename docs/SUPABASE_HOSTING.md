# Supabase : point d'entrée CHK Universal MCP

Fonction isolée : chk-universal-mcp. La route historique chk-home-mcp-gateway n'est pas modifiée.

**URL publique de diagnostic** :
https://gflnvlolwqnvzxyqsrir.supabase.co/functions/v1/chk-universal-mcp/healthcheck

L'URL de connexion MCP a la forme :
https://gflnvlolwqnvzxyqsrir.supabase.co/functions/v1/chk-universal-mcp/mcp/<secret-prive>

Le secret n'est jamais stocké dans le dépôt. Son hash SHA256 est enregistré dans public.chk_uc_access. Ne transmettez cette URL qu'à vos propres clients ChatGPT.

La table public.chk_uc_apps conserve un adaptateur par application, avec :
- enabled=true/false : commande indépendante par application ;
- read_tools : noms des outils MCP explicitement autorisés ;
- write_tools et allow_writes=false : écriture bloquée par défaut ;
- endpoint : URL privée du MCP ciblé, lisible uniquement côté serveur via service_role.

**Important** : c'est un répartiteur MCP, pas un hébergeur Ollama/Qwen. Il faut un moteur distinct pour le chatbot open source. L'ancien relais dépend toujours du PC Windows et du téléphone Android.

La connexion ChatGPT est à établir manuellement en renseignant l'URL secrète dans les paramètres de connexion MCP. Cette version fonctionne sur un jeton d'URL pour une connexion personnelle; pour un produit partagé, intégrer OAuth 2.1 (comme dans le serveur Node du même dépôt).

Une application supplémentaire s'ajoute en créant une entrée autorisée dans public.chk_uc_apps; elle n'obtient aucun accès aux autres applications par défaut.

Sécurité :
- Table RLS activée et aucun accès anon/authenticated ;
- Aucun mot de passe ni jeton dans GitHub ;
- Vérification par hash SHA256 d'un jeton aléatoire 256-bit ;
- Pas de redirection HTTP upstream ; pas de résultat supposé lorsque l'exécution est incertaine ;
- Les écritures nécessitent une autorisation explicite côté base de données et un request_id stable ;
- En production partagée, OAuth 2.1 est préférable à une URL-capacité.

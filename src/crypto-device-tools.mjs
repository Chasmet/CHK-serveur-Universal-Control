// Tools bound to the CHK Crypto Android agent. All writes need explicit local approval.
export const cryptoDeviceTools=[
  {name:"crypto_alerts",title:"Alertes CHK Crypto Android",description:"Lire les alertes de prix locales actives, sans les modifier.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
  {name:"crypto_bot_status",title:"État du bot CHK Crypto",description:"Lire état, nombre de règles et derniers événements Bot CHK sur le téléphone; jamais d'ordres.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
  {name:"crypto_chart_state",title:"Graphique actuellement sélectionné",description:"Lire la paire, l'unité et les réglages du graphique de CHK Crypto Android.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
  {name:"crypto_app_status",title:"État de l'application CHK Crypto",description:"Lire état des connexions et version de l'APK CHK Crypto, sans identifiants.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
  {name:"crypto_chart_select",title:"Préparer un graphique sur Android",description:"Demander à CHK Crypto de sélectionner la paire et l'unité d'analyse. N'ouvre pas de fenêtre depuis l'arrière-plan; demande une approbation locale sur le PC. Aucun ordre.",inputSchema:{type:"object",required:["symbol","timeframe"],properties:{symbol:{type:"string"},timeframe:{type:"string"},request_id:{type:"string"}}},readOnlyHint:false}
];
export const READ_DEVICE_ACTIONS=new Set(["crypto_portfolio","crypto_tracking","crypto_alerts","crypto_bot_status","crypto_chart_state","crypto_app_status"]);
export const WRITE_DEVICE_ACTIONS=new Set(["crypto_chart_select"]);

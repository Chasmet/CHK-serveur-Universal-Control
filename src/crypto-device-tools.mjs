// Extra read-only Android tools. The existing chart control remains
// a separate capability which requires explicit approval at the PC.
export const cryptoDeviceTools=[
  {name:"crypto_alerts",title:"CHK Crypto — alertes",description:"Lire les alertes de prix enregistrées localement dans l'application Android, sans les modifier.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
  {name:"crypto_bot_status",title:"CHK Crypto — Bot local",description:"Lire l'état du Bot CHK Crypto et des règles de surveillance, sans exécuter de trades.",inputSchema:{type:"object",properties:{}},readOnlyHint:true},
  {name:"crypto_app_status",title:"CHK Crypto — santé de l'APK",description:"Lire la version Android, l'état réseau et les informations générales de connexion, sans secrets.",inputSchema:{type:"object",properties:{}},readOnlyHint:true}
];
export const READ_DEVICE_ACTIONS=new Set(["crypto_portfolio","crypto_tracking","crypto_chart_state","crypto_device_status","crypto_alerts","crypto_bot_status","crypto_app_status"]);
export const WRITE_DEVICE_ACTIONS=new Set(["crypto_chart_control"]);

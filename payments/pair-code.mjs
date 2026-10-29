import { DeviceRegistry } from "./sidecar.mjs";

const devicesFile=process.env.PAYMENTS_DEVICES_FILE || "./data/payment-devices.json";
const registry=new DeviceRegistry(devicesFile);
const code=await registry.generateCode();
process.stdout.write(
  "\nCHK Paiements — code d'appairage unique (validité 10 minutes)\n"+
  "Code : "+code+"\n"+
  "Saisir ce code dans CHK Paiements Android une seule fois.\n"+
  "La communication doit passer par la nouvelle URL HTTPS dédiée aux paiements.\n"+
  "Ne pas saisir le code sur /mcp universel et ne pas le publier.\n\n"
);

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import { tick } from "./tick.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_WORKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

async function loadDeployment() {
  try {
    return JSON.parse(await readFile(path.join(here, "..", "local.json"), "utf8"));
  } catch {
    return null;
  }
}

const deployment = await loadDeployment();
const chainId = Number(process.env.CHAIN_ID ?? deployment?.chainId ?? 31337);
const dryRun = process.env.DRY_RUN !== "0" || chainId !== 56;
const privateKey = process.env.WORKER_PRIVATE_KEY ?? (chainId === 31337 ? LOCAL_WORKER_KEY : "");

if (!privateKey) {
  throw new Error("Set WORKER_PRIVATE_KEY for the desk worker.");
}
if (!deployment?.desk || !deployment?.held) {
  console.warn("No local.json yet. Deploy the desk before the worker can read agents.");
}

const config = {
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  chainId,
  desk: process.env.DESK_ADDRESS ?? deployment?.desk,
  held: process.env.HELD_ADDRESS ?? deployment?.held,
  privateKey,
  dryRun,
  secret: process.env.ENCRYPTION_SECRET ?? "held-dev-secret",
  port: Number(process.env.PORT ?? 8787),
};

startServer(config);
setInterval(() => {
  if (!config.desk) return;
  tick(config).catch((error) => console.error(error.message));
}, 20_000);

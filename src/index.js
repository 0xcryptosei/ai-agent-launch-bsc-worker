import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clients, deskAbi } from "./desk.js";
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
// Live on-chain spend (and Flap on BSC / BSC Testnet via decide()) only when DRY_RUN=0. Default stays dry.
const dryRun = process.env.DRY_RUN !== "0";
const privateKey = process.env.WORKER_PRIVATE_KEY ?? (chainId === 31337 ? LOCAL_WORKER_KEY : "");

if (!privateKey) {
  const hint =
    chainId === 31337
      ? "Set WORKER_PRIVATE_KEY or use npm run dev:local (Hardhat account #1)."
      : `Set WORKER_PRIVATE_KEY in apps/worker/.env — must control desk.worker() on chain ${chainId}. If you meant local Hardhat, run npm run dev:local or unset CHAIN_ID.`;
  throw new Error(`Missing worker key. ${hint}`);
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

async function assertWorker(config) {
  if (!config.desk) return;
  const workerAccount = privateKeyToAccount(config.privateKey);
  const expected = deployment?.worker ? getAddress(deployment.worker) : null;
  if (expected && getAddress(workerAccount.address) !== expected) {
    console.warn(
      `Worker key address ${workerAccount.address} does not match local.json worker ${expected}. spend() will revert.`
    );
  }
  try {
    const onchainWorker = await clients(config).publicClient.readContract({
      address: config.desk,
      abi: deskAbi,
      functionName: "worker",
    });
    if (getAddress(onchainWorker) !== getAddress(workerAccount.address)) {
      throw new Error(
        `WORKER_PRIVATE_KEY (${workerAccount.address}) does not match desk.worker() (${onchainWorker}).`
      );
    }
  } catch (error) {
    if (error.message?.includes("does not match desk.worker")) throw error;
    console.warn(`Could not verify desk.worker() yet: ${error.shortMessage ?? error.message}`);
  }
}

startServer(config);
assertWorker(config).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
setInterval(() => {
  if (!config.desk) return;
  tick(config).catch((error) => console.error(error.message));
}, 20_000);

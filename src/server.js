import { createServer } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, keccak256, stringToBytes } from "viem";
import { decryptKey, encryptKey, exportToken } from "./crypto.js";
import { clients, deskAbi, asAgent } from "./desk.js";
import { update, view } from "./store.js";
import { tick } from "./tick.js";
import { testX, xAuth, xLive } from "./x.js";

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Export-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicAgent(agent) {
  return {
    agentId: agent.agentId,
    owner: agent.owner,
    query: agent.query,
    name: agent.name ?? "",
    symbol: agent.symbol ?? "",
    meme: agent.meme ?? "",
    launchWallet: agent.launchWallet,
    lastReason: agent.lastReason ?? "",
    launches: agent.launches ?? [],
  };
}

export function startServer(config) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "OPTIONS") {
        send(res, 204, {});
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        const auth = xAuth();
        send(res, 200, {
          ok: true,
          dryRun: config.dryRun,
          chainId: config.chainId,
          x: { configured: auth.configured, live: xLive() },
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/x/test") {
        const body = await readBody(req);
        const result = await testX(String(body.query ?? "meme lang:en -is:retweet"));
        send(res, result.ok ? 200 : 400, result);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/agents/prepare") {
        const body = await readBody(req);
        const query = String(body.query ?? "").trim();
        if (!query) {
          send(res, 400, { error: "Add the accounts or keywords to watch." });
          return;
        }
        const privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);
        const token = exportToken();
        await update((store) => {
          store.pending[token] = {
            keyEnc: encryptKey(config.secret, privateKey),
            query,
            launchWallet: account.address,
            queryHash: keccak256(stringToBytes(query)),
          };
        });
        send(res, 200, { exportToken: token, launchWallet: account.address, queryHash: keccak256(stringToBytes(query)) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/agents/register") {
        const body = await readBody(req);
        const pending = await view((store) => store.pending[body.exportToken]);
        if (!pending) {
          send(res, 404, { error: "That create session expired. Start again." });
          return;
        }
        const onchain = asAgent(
          await clients(config).publicClient.readContract({
            address: config.desk,
            abi: deskAbi,
            functionName: "getAgent",
            args: [BigInt(body.agentId)],
          })
        );
        if (getAddress(onchain.owner) !== getAddress(body.owner)) {
          send(res, 403, { error: "That wallet does not own this agent." });
          return;
        }
        if (getAddress(onchain.launchWallet) !== getAddress(pending.launchWallet)) {
          send(res, 400, { error: "Set the launch wallet on the desk before recording the agent." });
          return;
        }
        const saved = await update((store) => {
          const current = store.pending[body.exportToken];
          if (!current) return null;
          const agentId = String(body.agentId);
          store.agents[agentId] = {
            agentId,
            owner: getAddress(body.owner),
            name: onchain.name,
            symbol: onchain.symbol,
            meme: onchain.meme,
            query: current.query,
            launchWallet: current.launchWallet,
            keyEnc: current.keyEnc,
            exportToken: body.exportToken,
            lastReason: "Waiting for the first pass.",
            seen: [],
            launches: [],
          };
          delete store.pending[body.exportToken];
          return publicAgent(store.agents[agentId]);
        });
        if (!saved) {
          send(res, 404, { error: "That create session expired. Start again." });
          return;
        }
        send(res, 200, saved);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/agents") {
        const agents = await view((store) => Object.values(store.agents).map(publicAgent));
        send(res, 200, { agents });
        return;
      }
      const agentMatch = url.pathname.match(/^\/api\/agents\/(\d+)$/);
      if (req.method === "GET" && agentMatch) {
        const agent = await view((store) => store.agents[agentMatch[1]]);
        if (!agent) {
          send(res, 404, { error: "No agent with that id." });
          return;
        }
        send(res, 200, publicAgent(agent));
        return;
      }
      const keyMatch = url.pathname.match(/^\/api\/agents\/(\d+)\/key$/);
      if (req.method === "GET" && keyMatch) {
        const token = req.headers["x-export-token"];
        const agent = await view((store) => store.agents[keyMatch[1]]);
        if (!agent || agent.exportToken !== token) {
          send(res, 403, { error: "The export token does not match this agent." });
          return;
        }
        send(res, 200, { privateKey: decryptKey(config.secret, agent.keyEnc), address: agent.launchWallet });
        return;
      }
      const queryMatch = url.pathname.match(/^\/api\/agents\/(\d+)\/query$/);
      if (req.method === "POST" && queryMatch) {
        const body = await readBody(req);
        const query = String(body.query ?? "").trim();
        const updated = await update((store) => {
          const agent = store.agents[queryMatch[1]];
          if (!agent || agent.exportToken !== body.exportToken) return null;
          agent.query = query;
          agent.seen = [];
          return { queryHash: keccak256(stringToBytes(query)) };
        });
        if (!updated) {
          send(res, 403, { error: "The export token does not match this agent." });
          return;
        }
        send(res, 200, updated);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/tick") {
        const notes = await tick(config);
        send(res, 200, { notes });
        return;
      }
      send(res, 404, { error: "Not found" });
    } catch (error) {
      send(res, 500, { error: error.message ?? "Server error" });
    }
  });

  server.listen(config.port, () => {
    console.log(`Society worker on ${config.port} dryRun=${config.dryRun}`);
  });
  return server;
}

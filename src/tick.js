import { keccak256, stringToBytes, toBytes, zeroAddress } from "viem";
import {
  FLAP_PORTAL,
  LAUNCH_COST,
  WATCH_COST,
  decide,
  findVanitySalt,
  sanitizeSymbol,
  standardLaunchParams,
} from "@held/flap";
import { decryptKey } from "./crypto.js";
import { clients, deskAbi, portalAbi, asAgent } from "./desk.js";
import { fetchPosts, scorePost } from "./posts.js";
import { update, view } from "./store.js";

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function pinMeta(meta) {
  if (!process.env.PINATA_JWT) return null;
  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PINATA_JWT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pinataContent: meta }),
  });
  if (!response.ok) throw new Error("IPFS upload failed");
  const body = await response.json();
  return body.IpfsHash;
}

export async function tick(config) {
  const agents = await view((store) => Object.values(store.agents));
  const notes = [];
  for (const record of agents) {
    notes.push(await tickAgent(config, record));
  }
  return notes;
}

async function tickAgent(config, record) {
  const { publicClient, walletClient } = clients(config);
  const onchain = asAgent(
    await publicClient.readContract({
      address: config.desk,
      abi: deskAbi,
      functionName: "getAgent",
      args: [BigInt(record.agentId)],
    })
  );

  const queryHash = keccak256(stringToBytes(record.query));
  if (onchain.queryHash.toLowerCase() !== queryHash.toLowerCase()) {
    return finish(record.agentId, "The on-chain order does not match the saved watch list.");
  }

  const launchesToday = record.launches.filter(
    (launch) => launch.day === dayKey() && launch.status !== "failed"
  ).length;

  let posts = [];
  try {
    posts = await fetchPosts(record.query);
  } catch (error) {
    return finish(record.agentId, error.message);
  }
  const post = posts.find((item) => !record.seen.includes(item.id));
  if (!post) {
    return finish(record.agentId, posts.length === 0 ? "No posts for this order." : "No new posts.");
  }

  const scored = await scorePost(post.text);
  const walletBalance =
    !onchain.launchWallet || onchain.launchWallet === zeroAddress
      ? 0n
      : await publicClient.getBalance({ address: onchain.launchWallet });
  let decision = decide({
    active: onchain.active,
    launchesToday,
    maxLaunchesPerDay: onchain.maxLaunchesPerDay,
    minScore: onchain.minScore,
    score: scored.score,
    credit: onchain.credit,
    maxBuyWei: onchain.maxBuyWei,
    walletBalance,
    dryRun: config.dryRun,
    chainId: config.chainId,
  });

  if (decision.kind === "launch" && !process.env.PINATA_JWT) {
    decision = {
      kind: "preview",
      quoteAmt: decision.quoteAmt,
      reason: "IPFS is not configured, so the Flap transaction was not sent.",
    };
  }

  if (decision.kind === "stop") {
    return finish(record.agentId, decision.reason);
  }

  if (decision.kind === "watch") {
    if (!config.dryRun) {
      await spend(config, walletClient, record.agentId, WATCH_COST, `watch:${record.agentId}:${post.id}`);
    }
    await remember(record.agentId, post.id);
    return finish(record.agentId, decision.reason);
  }

  const name = scored.name;
  const symbol = sanitizeSymbol(scored.symbol);
  const found = findVanitySalt("8888");
  let status = "preview";
  let txHash = "";
  let token = found.address;
  let reason = decision.reason ?? "Preview only.";

  if (decision.kind === "launch") {
    const meta = await pinMeta({
      name,
      symbol,
      description: scored.description,
      image: "",
    });
    if (!meta) {
      reason = "IPFS is not configured, so the Flap transaction was not sent.";
    } else {
      const params = standardLaunchParams({
        name,
        symbol,
        meta,
        salt: found.salt,
        quoteAmt: decision.quoteAmt,
        beneficiary: onchain.owner,
      });
      const accountKey = decryptKey(config.secret, record.keyEnc);
      const sender = clients({ ...config, privateKey: accountKey });
      if (sender.account.address.toLowerCase() !== onchain.launchWallet.toLowerCase()) {
        reason = "The stored key does not match the agent launch wallet.";
      } else {
        txHash = await sender.walletClient.writeContract({
          address: FLAP_PORTAL,
          abi: portalAbi,
          functionName: "newTokenV6",
          args: [params],
          value: decision.quoteAmt,
        });
        await sender.publicClient.waitForTransactionReceipt({ hash: txHash });
        await spend(config, walletClient, record.agentId, WATCH_COST, `watch:${record.agentId}:${post.id}`);
        await spend(config, walletClient, record.agentId, LAUNCH_COST, `launch:${record.agentId}:${post.id}`);
        const state = await sender.publicClient.readContract({
          address: FLAP_PORTAL,
          abi: portalAbi,
          functionName: "getTokenV5",
          args: [token],
        });
        reason = `Launched on Flap. Curve reserve ${(state.reserve ?? state[1]).toString()}.`;
        status = "sent";
      }
    }
  }

  const markSeen =
    status === "sent" || (config.dryRun && status === "preview" && decision.kind !== "launch");

  await update((store) => {
    const agent = store.agents[record.agentId];
    if (markSeen && !agent.seen.includes(post.id)) agent.seen.push(post.id);
    agent.lastReason = reason;
    agent.launches.unshift({
      name,
      symbol,
      score: scored.score,
      postId: post.id,
      post: post.text,
      sample: Boolean(post.sample),
      status,
      token,
      txHash,
      reason,
      day: dayKey(),
      at: new Date().toISOString(),
    });
  });
  return { agentId: record.agentId, reason, status };
}

async function spend(config, walletClient, agentId, amount, label) {
  const hash = await walletClient.writeContract({
    address: config.desk,
    abi: deskAbi,
    functionName: "spend",
    args: [BigInt(agentId), amount, keccak256(toBytes(label))],
  });
  await clients(config).publicClient.waitForTransactionReceipt({ hash });
}

function remember(agentId, postId) {
  return update((store) => {
    const agent = store.agents[agentId];
    if (!agent.seen.includes(postId)) agent.seen.push(postId);
  });
}

function finish(agentId, reason) {
  return update((store) => {
    store.agents[agentId].lastReason = reason;
    return { agentId, reason };
  });
}

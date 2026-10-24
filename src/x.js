import { createHmac, randomBytes } from "node:crypto";

const MIN_INTERVAL_MS = Number(process.env.X_MIN_INTERVAL_MS ?? 30 * 60 * 1000);
const cache = new Map();

function enc(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function xAuth() {
  const bearer = process.env.X_BEARER_TOKEN?.trim() ?? "";
  const apiKey = process.env.X_API_KEY?.trim() ?? "";
  const apiSecret = process.env.X_API_SECRET?.trim() ?? "";
  const accessToken = process.env.X_ACCESS_TOKEN?.trim() ?? "";
  const accessSecret = process.env.X_ACCESS_TOKEN_SECRET?.trim() ?? "";
  const oauth = Boolean(apiKey && apiSecret && accessToken && accessSecret);
  return {
    bearer,
    apiKey,
    apiSecret,
    accessToken,
    accessSecret,
    oauth,
    configured: Boolean(bearer || oauth),
    missing: bearer || oauth ? [] : ["X_BEARER_TOKEN or the four OAuth keys"],
  };
}

export function xLive() {
  return process.env.X_LIVE === "1" && xAuth().configured;
}

function oauth1Header(method, url) {
  const auth = xAuth();
  const parsed = new URL(url);
  const oauth = {
    oauth_consumer_key: auth.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: auth.accessToken,
    oauth_version: "1.0",
  };
  const params = { ...oauth };
  for (const [key, value] of parsed.searchParams) params[key] = value;
  const base = Object.keys(params)
    .sort()
    .map((key) => `${enc(key)}=${enc(params[key])}`)
    .join("&");
  const signatureBase = `${method.toUpperCase()}&${enc(`${parsed.origin}${parsed.pathname}`)}&${enc(base)}`;
  const signingKey = `${enc(auth.apiSecret)}&${enc(auth.accessSecret)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey).update(signatureBase).digest("base64");
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((key) => `${enc(key)}="${enc(oauth[key])}"`)
    .join(", ")}`;
}

async function xGet(url) {
  const auth = xAuth();
  const headers = auth.oauth
    ? { Authorization: oauth1Header("GET", url) }
    : { Authorization: `Bearer ${auth.bearer}` };
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { ok: response.ok, status: response.status, body };
}

export async function searchRecent(query, { force = false } = {}) {
  const key = query.trim();
  const now = Date.now();
  const hit = cache.get(key);
  if (!force && hit && now - hit.at < MIN_INTERVAL_MS) {
    return hit.posts.map((post) => ({ ...post, cached: true }));
  }

  const url = new URL("https://api.twitter.com/2/tweets/search/recent");
  url.searchParams.set("query", key);
  url.searchParams.set("max_results", "10");
  const { ok, status, body } = await xGet(url);
  if (!ok) {
    const detail = body.title ?? body.detail ?? body.error ?? `HTTP ${status}`;
    if (status === 402) {
      throw new Error("X free plan cannot search. Keep using sample posts, or upgrade the X app.");
    }
    throw new Error(`X search failed (${status}): ${detail}`);
  }
  const posts = (body.data ?? []).map((post) => ({ id: post.id, text: post.text, sample: false }));
  cache.set(key, { at: now, posts });
  return posts;
}

export async function testX(query = "meme lang:en -is:retweet") {
  const auth = xAuth();
  if (!auth.configured) {
    return {
      ok: false,
      reason: "X keys are incomplete. Add a Bearer token, or API Key and API Secret.",
      missing: auth.missing,
      live: xLive(),
    };
  }

  let user = null;
  if (auth.oauth) {
    const me = await xGet("https://api.twitter.com/2/users/me");
    if (!me.ok) {
      return {
        ok: false,
        step: "users/me",
        status: me.status,
        reason: me.body.title ?? me.body.detail ?? me.body.error ?? `HTTP ${me.status}`,
        live: xLive(),
      };
    }
    user = me.body.data ? { id: me.body.data.id, username: me.body.data.username } : null;
  }

  try {
    const posts = await searchRecent(query, { force: true });
    return {
      ok: true,
      step: "search/recent",
      auth: auth.oauth ? "oauth" : "bearer",
      user,
      query,
      count: posts.length,
      posts: posts.slice(0, 3).map((post) => ({ id: post.id, text: post.text.slice(0, 120) })),
      live: xLive(),
    };
  } catch (error) {
    return {
      ok: false,
      step: "search/recent",
      auth: auth.oauth ? "oauth" : "bearer",
      user,
      reason: error.message,
      note: "Free X apps often cannot use recent search. The worker will keep using sample posts.",
      live: xLive(),
    };
  }
}

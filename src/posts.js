import { searchRecent, xLive } from "./x.js";

const SAMPLE = [
  {
    id: "sample-orange",
    text: "The timeline keeps naming ORANGECAT. People are posting the same mascot, the same joke, and asking where the BSC coin is.",
  },
];

export async function fetchPosts(query) {
  if (!xLive()) {
    if (process.env.DRY_RUN === "0") return [];
    return SAMPLE.map((post) => ({ ...post, sample: true }));
  }
  return searchRecent(query);
}

export async function scorePost(text) {
  const { localScore } = await import("@held/flap");
  if (!process.env.MODEL_API_KEY) return { ...localScore(text), source: "local" };

  const response = await fetch(process.env.MODEL_URL ?? "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MODEL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME ?? "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content:
            "Score this public post as a meme-token idea from 0 to 100. Reply JSON with name, symbol, description, score. The score is not a prediction that a token will hold value.\n\n" +
            text,
        },
      ],
    }),
  });
  if (!response.ok) return { ...localScore(text), source: "local" };
  const body = await response.json();
  const parsed = JSON.parse(body.choices[0].message.content);
  const score = Number(parsed.score);
  if (!Number.isFinite(score)) return { ...localScore(text), source: "local" };
  return {
    name: String(parsed.name ?? "MEME").slice(0, 32),
    symbol: String(parsed.symbol ?? "MEME"),
    description: String(parsed.description ?? text).slice(0, 160),
    score: Math.max(0, Math.min(100, Math.round(score))),
    source: "model",
  };
}

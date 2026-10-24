import { testX } from "../src/x.js";

const query = process.argv.slice(2).join(" ") || "meme lang:en -is:retweet";
const result = await testX(query);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

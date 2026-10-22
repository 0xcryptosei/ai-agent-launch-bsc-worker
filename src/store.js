import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = process.env.DATA_PATH ?? path.join(process.cwd(), "data", "store.json");

let queue = Promise.resolve();

function empty() {
  return { agents: {}, pending: {} };
}

async function read() {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return empty();
  }
}

async function write(store) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2));
}

export function update(fn) {
  const run = queue.then(async () => {
    const store = await read();
    const result = await fn(store);
    await write(store);
    return result;
  });
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

export function view(fn) {
  return queue.then(async () => fn(await read()));
}

import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Replay cache. With AGENT_REPLAY=1, runAgent() reads saved outputs from
 * .agent-replay/ instead of calling the API (free reruns for UI work and tests).
 * With AGENT_RECORD=1 it saves every successful output there.
 * The key includes the agent version, so changing a prompt misses the cache.
 * .agent-replay/ is gitignored.
 */


export function replayKey(agent: string, version: string, model: string, system: string, prompt: string): string {
  const h = createHash("sha256").update(JSON.stringify([agent, version, model, system, prompt])).digest("hex");
  return `${agent}@${version}-${h.slice(0, 16)}`;
}

export async function readReplay(key: string, dir: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8"));
  } catch {
    return undefined;
  }
}

export async function writeReplay(key: string, output: unknown, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(output, null, 2));
}

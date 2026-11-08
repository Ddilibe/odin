import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function contractorHome(): string {
  return resolve(process.env.CONTRACTOR_HOME ?? join(process.cwd(), ".contractor"));
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown, mode = 0o600): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    // best-effort on filesystems that do not support chmod
  }
}

export function runDir(runId: string): string {
  return join(contractorHome(), "runs", runId);
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureCommandResolvable, ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";

function pathLooksExecutable(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === "codex" || base === "codex.exe" || base === "codex.cmd";
}

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  const fromUserProfile = env.USERPROFILE?.trim();
  if (fromUserProfile) return fromUserProfile;
  const fromHome = env.HOME?.trim();
  if (fromHome) return fromHome;
  return os.homedir();
}

function resolveCodexHomeDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveHomeDir(env), ".codex");
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findCodexExecutableFromVsCodeExtension(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (process.platform !== "win32") return null;

  const extensionsDir = path.join(resolveHomeDir(env), ".vscode", "extensions");
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("openai.chatgpt-"))
    .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true, sensitivity: "base" }));

  for (const entry of candidates) {
    const extensionRoot = path.join(extensionsDir, entry.name);
    const executableCandidates = [
      path.join(extensionRoot, "bin", "windows-x86_64", "codex.exe"),
      path.join(extensionRoot, "bin", "windows-x86_64", "codex.cmd"),
    ];
    for (const executable of executableCandidates) {
      if (await fileExists(executable)) return executable;
    }
  }

  return null;
}

export async function resolveCodexCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ command: string; resolution: "path" | "configured" | "vscode-extension"; detail?: string }> {
  const runtimeEnv = ensurePathInEnv(env);

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    return { command, resolution: command.includes("/") || command.includes("\\") ? "configured" : "path" };
  } catch {
    if (!pathLooksExecutable(command)) {
      return { command, resolution: command.includes("/") || command.includes("\\") ? "configured" : "path" };
    }
  }

  const fallback = await findCodexExecutableFromVsCodeExtension(runtimeEnv);
  if (fallback) {
    return {
      command: fallback,
      resolution: "vscode-extension",
      detail: fallback,
    };
  }

  return { command, resolution: command.includes("/") || command.includes("\\") ? "configured" : "path" };
}

export async function detectCodexLocalAuth(
  env: NodeJS.ProcessEnv,
): Promise<{ configured: boolean; authMode: string | null; authFilePath: string }> {
  const authFilePath = path.join(resolveCodexHomeDir(env), "auth.json");
  if (!(await fileExists(authFilePath))) {
    return { configured: false, authMode: null, authFilePath };
  }

  try {
    const raw = await fs.readFile(authFilePath, "utf8");
    const parsed = JSON.parse(raw) as { auth_mode?: unknown };
    const authMode =
      typeof parsed.auth_mode === "string" && parsed.auth_mode.trim().length > 0
        ? parsed.auth_mode.trim()
        : "local";
    return { configured: true, authMode, authFilePath };
  } catch {
    return { configured: true, authMode: "local", authFilePath };
  }
}

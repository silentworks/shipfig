import { ExecError, type Sprite } from "@fly/sprites";
import { sanitizeOutput } from "@/lib/redact";
import { spriteNameSchema } from "@/lib/validation";
import { findSprite, spritesClient } from "./client";
import { GATEWAY_SPRITE_LABEL } from "./connections";

/**
 * A job's isolated execution environment. Everything Shipfig does inside a job
 * sprite goes through this interface: argv-only commands (never a shell
 * string), file writes, and checkpoints. Tests use an in-memory fake.
 */
export interface Sandbox {
  readonly name: string;
  readonly id: string | null;
  run(argv: readonly string[], options?: RunOptions): Promise<CommandResult>;
  writeFile(path: string, content: string): Promise<void>;
  /** Create a checkpoint and return its id (e.g. "v3"). */
  checkpoint(comment: string): Promise<string>;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Max characters kept per stream after redaction (default 16k). */
  maxOutputChars?: number;
}

export interface CommandResult {
  argv: string[];
  /** Real process exit code, or null when the command timed out or could not run. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Times the command was re-sent because the sprite's container was not running (it never started). */
  retries?: number;
}

export const JOB_SPRITE_LABEL = "shipfig-job";
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Non-interactive, colour-free defaults for every command. */
const BASE_ENV: Record<string, string> = {
  CI: "true",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  GIT_TERMINAL_PROMPT: "0",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

export function assertSafeArgv(argv: readonly string[]): string[] {
  if (argv.length === 0) throw new Error("Empty command");
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.includes("\0")) throw new Error("Command arguments must be strings without NUL bytes");
  }
  return [...argv];
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && !(error instanceof ExecError) && /timed out/i.test(error.message);
}

/**
 * Sprites runtime error for a command that never started because the
 * sprite's container was not running (seen right after a sprite is created
 * or its policies change). The command did not run, so re-sending it is safe.
 */
export function isContainerMissing(stderr: string): boolean {
  return /container `?app`? does not exist|\/run\/crun\/app\/status/.test(stderr);
}

/** Waits before each re-send of a command that hit a missing container. */
export const CONTAINER_RETRY_DELAYS_MS = [2_000, 5_000] as const;

/** How long PID 1 must stay the same before a new job sprite counts as settled. */
export const SETTLE_WINDOW_MS = 4_000;
const SETTLE_TIMEOUT_MS = 30_000;
const SETTLE_POLL_MS = 500;

export class SpriteSandbox implements Sandbox {
  constructor(
    private readonly sprite: Sprite,
    private readonly retryDelaysMs: readonly number[] = CONTAINER_RETRY_DELAYS_MS,
  ) {}

  get name() {
    return this.sprite.name;
  }

  get id() {
    return this.sprite.id ?? null;
  }

  async run(argv: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    const [file, ...args] = assertSafeArgv(argv);
    const max = options.maxOutputChars ?? 16_000;
    const started = Date.now();
    let retries = 0;
    const done = (exitCode: number | null, stdout: unknown, stderr: unknown, timedOut = false): CommandResult => ({
      argv: [file, ...args],
      exitCode,
      stdout: sanitizeOutput(String(stdout ?? ""), max),
      stderr: sanitizeOutput(String(stderr ?? ""), max),
      durationMs: Date.now() - started,
      timedOut,
      ...(retries > 0 ? { retries } : {}),
    });
    for (;;) {
      try {
        const r = await this.sprite.execFile(file, args, {
          cwd: options.cwd,
          env: { ...BASE_ENV, ...options.env },
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 20 * 1024 * 1024,
        });
        return done(r.exitCode, r.stdout, r.stderr);
      } catch (error) {
        if (error instanceof ExecError) {
          const delay = this.retryDelaysMs[retries];
          if (delay !== undefined && isContainerMissing(String(error.stderr ?? ""))) {
            retries++;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          return done(error.exitCode, error.stdout, error.stderr);
        }
        if (isTimeoutError(error)) return done(null, "", `Command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`, true);
        throw error;
      }
    }
  }

  /**
   * Applying policies to a new sprite restarts its container a second or two
   * later; a command caught in that restart is killed (exit 137) or finds no
   * container. Wait until PID 1 has kept the same start time for the settle
   * window. Returns whether it settled; on timeout, callers carry on and the
   * per-command retry still covers the missing-container case.
   */
  async waitUntilSettled(opts: { windowMs?: number; timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
    const windowMs = opts.windowMs ?? SETTLE_WINDOW_MS;
    const deadline = Date.now() + (opts.timeoutMs ?? SETTLE_TIMEOUT_MS);
    const pollMs = opts.pollMs ?? SETTLE_POLL_MS;
    let current: string | null = null;
    let since = 0;
    while (Date.now() < deadline) {
      const r = await this.run(["cut", "-d", " ", "-f22", "/proc/1/stat"], { timeoutMs: 10_000 });
      const start = r.exitCode === 0 ? r.stdout.trim() : null;
      if (start && start === current) {
        if (Date.now() - since >= windowMs) return true;
      } else {
        current = start;
        since = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return false;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sprite.filesystem().writeFile(path, content);
  }

  async checkpoint(comment: string): Promise<string> {
    const stream = await this.sprite.createCheckpoint(comment);
    let id: string | null = null;
    for await (const msg of stream) {
      if (msg.type === "error") throw new Error(`Checkpoint failed: ${msg.error ?? msg.data ?? "unknown error"}`);
      const match = /\bID:\s*(v\d+)\b/.exec(msg.data ?? "") ?? /\bCheckpoint (v\d+) created\b/.exec(msg.data ?? "");
      if (match) id = match[1];
    }
    if (id) return id;
    // The stream text is not a documented contract; fall back to the listing.
    const latest = (await this.sprite.listCheckpoints()).filter((c) => c.comment === comment).sort((a, b) => +b.createTime - +a.createTime)[0];
    if (!latest) throw new Error("Checkpoint was created but its id could not be determined");
    return latest.id;
  }
}

/** Resource and isolation limits applied to every job sprite. */
export const JOB_SPRITE_LIMITS = {
  ramMB: 4096,
  cpus: 2,
  memoryLimitMB: 3584,
} as const;

/**
 * Egress allowlist for job sprites: GitHub (anonymous clone of public repos)
 * and the npm registry. Everything else, including the Sprites API and its
 * connector gateway, is refused by DNS. Verified live: `*` deny blocks
 * example.com and api.sprites.dev while these hosts stay reachable.
 */
export const JOB_NETWORK_RULES = [
  { domain: "github.com", action: "allow" },
  { domain: "codeload.github.com", action: "allow" },
  { domain: "objects.githubusercontent.com", action: "allow" },
  { domain: "registry.npmjs.org", action: "allow" },
  { domain: "*", action: "deny" },
] as const;

/**
 * Create a fresh, locked-down sprite for a job. An existing sprite with the
 * same name (left over from an earlier attempt) is deleted first so every
 * attempt starts from a clean machine.
 */
export async function createJobSandbox(name: string): Promise<Sandbox> {
  spriteNameSchema.parse(name);
  if (name.startsWith("shipfig-gateway")) throw new Error("Job sprites must not use the gateway name prefix");
  const existing = await findSprite(name);
  if (existing) await existing.delete();

  const sprite = await spritesClient().createSprite(name, {
    config: { ramMB: JOB_SPRITE_LIMITS.ramMB, cpus: JOB_SPRITE_LIMITS.cpus },
    labels: [JOB_SPRITE_LABEL],
    waitForCapacity: true,
  });
  if (sprite.labels?.includes(GATEWAY_SPRITE_LABEL)) throw new Error("Job sprite unexpectedly carries the gateway label");
  try {
    await sprite.updateNetworkPolicy({ rules: JOB_NETWORK_RULES.map((r) => ({ ...r })) });
    await sprite.updateResourcesPolicy({ memory: { limitMB: JOB_SPRITE_LIMITS.memoryLimitMB } });
    await sprite.updatePrivilegesPolicy({ noNewPrivileges: true });
  } catch (error) {
    await sprite.delete().catch(() => {});
    throw new Error(`Could not lock down job sprite ${name}: ${(error as Error).message}`);
  }
  const sandbox = new SpriteSandbox(sprite);
  await sandbox.waitUntilSettled();
  return sandbox;
}

/** Reattach to a job's existing sprite (e.g. after a server restart). */
export async function openJobSandbox(name: string): Promise<Sandbox | undefined> {
  const sprite = await findSprite(name);
  return sprite ? new SpriteSandbox(sprite) : undefined;
}

/** Delete a job sprite if it exists. Best effort; returns whether one was deleted. */
export async function destroyJobSandbox(name: string): Promise<boolean> {
  spriteNameSchema.parse(name);
  if (name.startsWith("shipfig-gateway")) throw new Error("Refusing to delete the gateway sprite");
  const sprite = await findSprite(name);
  if (!sprite) return false;
  await sprite.delete();
  return true;
}

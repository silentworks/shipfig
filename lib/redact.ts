/**
 * Redaction for anything that may be logged, persisted or shown in the UI.
 *
 * Output from Sprites and GitHub is untrusted and may echo credentials (for
 * example a misconfigured tool printing its env). Every string that leaves the
 * orchestrator's memory goes through `redact` first.
 */

const REPLACEMENT = "[REDACTED]";

const patterns: RegExp[] = [
  // GitHub tokens: classic PAT, OAuth, user-to-server, server-to-server, refresh, fine-grained PAT
  /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  // Fly.io macaroons / tokens
  /\bFlyV1\s+[A-Za-z0-9_+/=,.-]{20,}/g,
  /\bfm[12][a-z]?_[A-Za-z0-9_+/=-]{20,}/g,
  // OpenAI keys
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
  // Authorization headers / bearer tokens
  /\b(Authorization\s*:\s*)(?:Bearer|token|Basic)\s+[^\s"']+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  // Credentials embedded in URLs: https://user:secret@host
  /(\bhttps?:\/\/)[^\s:@/]+:[^\s@/]+@/gi,
  // JSON Web Tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Env-style assignments whose key looks secret: TOKEN=..., API_KEY: "..." */
const secretAssignment =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)(\s*[=:]\s*)("?)[^\s"']{4,}\3/gi;

export function redact(input: string, extraSecrets: readonly string[] = []): string {
  let out = input;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join(REPLACEMENT);
  }
  for (const pattern of patterns) {
    out = out.replace(pattern, (match, ...groups) => {
      // Keep a captured prefix (e.g. "Authorization: " or "https://") for readability.
      const prefix = typeof groups[0] === "string" && match.startsWith(groups[0]) ? groups[0] : "";
      return `${prefix}${REPLACEMENT}${prefix && match.endsWith("@") ? "@" : ""}`;
    });
  }
  out = out.replace(secretAssignment, (_m, key: string, sep: string) => `${key}${sep}${REPLACEMENT}`);
  return out;
}

/** Truncate long output for storage/display, keeping head and tail. */
export function truncate(input: string, maxChars = 16_000): string {
  if (input.length <= maxChars) return input;
  const half = Math.floor((maxChars - 40) / 2);
  const omitted = input.length - half * 2;
  return `${input.slice(0, half)}\n…[${omitted} chars truncated]…\n${input.slice(-half)}`;
}

/** Redact then truncate: the standard treatment for command output. */
export function sanitizeOutput(input: string, maxChars?: number, extraSecrets?: readonly string[]): string {
  return truncate(redact(input, extraSecrets), maxChars);
}

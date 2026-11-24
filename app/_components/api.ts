"use client";

import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      // State-changing requests must say so (checked server-side against cross-site requests).
      ...(init?.method && init.method !== "GET" ? { "X-Shipfig-Action": "1" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: undefined })
    | { error: { code: string; message: string; details?: unknown } }
    | null;
  if (!response.ok) {
    const err = body && "error" in body && body.error ? body.error : { code: "http_error", message: `Request failed (${response.status})` };
    throw new ApiError(err.message, response.status, err.code, "details" in err ? err.details : undefined);
  }
  return body as T;
}

export type Resource<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: ApiError | Error }
  | { status: "ok"; data: T };

/** Fetch `url` (or nothing when null) and expose loading/error/data plus reload. */
export function useResource<T>(url: string | null): Resource<T> & { reload: () => void } {
  const [state, setState] = useState<Resource<T>>({ status: url ? "loading" : "idle" });
  const [nonce, setNonce] = useState(0);
  const [prevKey, setPrevKey] = useState<string | null>(null);

  // Reset to loading synchronously when the URL or nonce changes (no stale data flash).
  const key = url ? `${url}#${nonce}` : null;
  if (key !== prevKey) {
    setPrevKey(key);
    setState(url ? { status: "loading" } : { status: "idle" });
  }

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetchJson<T>(url, { signal: controller.signal }).then(
      (data) => setState({ status: "ok", data }),
      (error: Error) => {
        if (!controller.signal.aborted) setState({ status: "error", error });
      },
    );
    return () => controller.abort();
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

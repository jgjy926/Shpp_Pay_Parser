// Koofr WebDAV client (fetch-based) — see SPEC.md §2/§3.
// Koofr is the source of truth: JSON files under /shpp-tracker/.
// Concurrency: conditional writes with If-Match ETag; caller retries once on conflict.

const DAV_BASE = "https://app.koofr.net/dav/Koofr";

/** Thrown when a conditional PUT fails (412) — caller should re-read and retry once. */
export class KoofrConflictError extends Error {
  constructor(path: string) {
    super(`ETag conflict writing ${path}`);
    this.name = "KoofrConflictError";
  }
}

export interface KoofrFile<T> {
  data: T;
  etag: string | null;
}

export class KoofrClient {
  #auth: string;
  #root: string;

  constructor(email: string, appPassword: string, root = "/shpp-tracker") {
    this.#auth = "Basic " + btoa(`${email}:${appPassword}`);
    this.#root = root.replace(/\/+$/, "");
  }

  #url(path: string): string {
    const full = `${this.#root}/${path.replace(/^\/+/, "")}`;
    return DAV_BASE + full.split("/").map(encodeURIComponent).join("/");
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.#auth, ...extra };
  }

  /** GET a JSON file. Returns null if it does not exist. */
  async getJson<T>(path: string): Promise<KoofrFile<T> | null> {
    const res = await fetch(this.#url(path), { headers: this.#headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Koofr GET ${path} failed: ${res.status}`);
    return { data: (await res.json()) as T, etag: res.headers.get("etag") };
  }

  /**
   * PUT a JSON file. If `etag` is given, throws KoofrConflictError when the
   * file has changed since that ETag was read. Creates parent folders on demand.
   * Returns the new ETag if the server provides one (otherwise re-read to get it).
   *
   * Koofr ignores If-Match on PUT (verified 2026-06: bogus ETag → 201), but
   * honors it on GET/HEAD — so we pre-check with HEAD. Not atomic; the small
   * check-then-write race is acceptable per SPEC.md §2 (last-write-wins).
   */
  async putJson(path: string, data: unknown, etag?: string | null): Promise<string | null> {
    if (etag) {
      const check = await fetch(this.#url(path), {
        method: "HEAD",
        headers: this.#headers({ "If-Match": etag }),
      });
      if (check.status === 412) throw new KoofrConflictError(path);
    }
    const body = JSON.stringify(data);
    const doPut = () =>
      fetch(this.#url(path), {
        method: "PUT",
        headers: this.#headers({
          "Content-Type": "application/json",
          ...(etag ? { "If-Match": etag } : {}),
        }),
        body,
      });

    let res = await doPut();
    // RFC 4918 says 409 for a missing parent collection, but Koofr returns 404.
    if (res.status === 409 || res.status === 404) {
      // Parent collection missing — create folders, then retry once.
      await this.#ensureDirs(path);
      res = await doPut();
    }
    if (res.status === 412) throw new KoofrConflictError(path);
    if (!res.ok) throw new Error(`Koofr PUT ${path} failed: ${res.status}`);
    return res.headers.get("etag");
  }

  /** DELETE a file. Missing file is not an error. */
  async delete(path: string): Promise<void> {
    const res = await fetch(this.#url(path), {
      method: "DELETE",
      headers: this.#headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Koofr DELETE ${path} failed: ${res.status}`);
    }
  }

  /** MKCOL each missing parent folder of `path` (root → leaf). */
  async #ensureDirs(path: string): Promise<void> {
    const segments = `${this.#root}/${path.replace(/^\/+/, "")}`
      .split("/")
      .filter(Boolean)
      .slice(0, -1); // drop the filename

    let dir = "";
    for (const seg of segments) {
      dir += `/${seg}`;
      const res = await fetch(DAV_BASE + dir.split("/").map(encodeURIComponent).join("/"), {
        method: "MKCOL",
        headers: this.#headers(),
      });
      // 201 created; 405 already exists — both fine.
      if (!res.ok && res.status !== 405) {
        throw new Error(`Koofr MKCOL ${dir} failed: ${res.status}`);
      }
    }
  }
}

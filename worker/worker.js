// ============================================================================
//  carview-proxy  —  Cloudflare Worker
//  Read/write the PRIVATE GitHub repo samiulAsumel/carview-data from the app
//  without ever exposing the GitHub token in the browser.
//
//  Secrets to configure (Cloudflare → Worker → Settings → Variables):
//    GITHUB_TOKEN    fine-grained PAT with Contents: Read & Write on carview-data
//    WRITE_PASSWORD  your admin login password (gates write/save requests)
//
//  Endpoints:
//    GET   /            -> current data.json   (+ X-Data-Sha header)
//    GET   /?history=1  -> recent commits      [{sha, message, date}]
//    GET   /?at=<sha>   -> data.json at commit <sha>
//    PUT   /            -> commit data.json (needs X-Write-Key; optional baseSha)
// ============================================================================

const REPO = "samiulAsumel/carview-data";
const FILE = "data.json";
const BRANCH = "main";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Write-Key",
  "Access-Control-Expose-Headers": "X-Data-Sha",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });
}

// SHA-256 hex (matches the browser's sha256 helper in app.js)
async function sha256(message) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// base64 of a UTF-8 string (GitHub Contents API wants base64 content)
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// decode GitHub's base64 (may contain newlines) back to a UTF-8 string
function fromBase64Utf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "carview-proxy",
      ...(init.headers || {}),
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // ---- READ -------------------------------------------------------------
    if (request.method === "GET") {
      // Commit history of data.json
      if (url.searchParams.has("history")) {
        const r = await gh(
          env,
          `commits?path=${FILE}&sha=${BRANCH}&per_page=20`,
        );
        if (!r.ok) return json({ error: "history failed", status: r.status }, 502);
        const commits = await r.json();
        return json(
          commits.map((c) => ({
            sha: c.sha,
            message: c.commit.message,
            date: c.commit.committer.date,
          })),
        );
      }

      // data.json at a specific commit (for restore/preview)
      const at = url.searchParams.get("at");
      const ref = at || BRANCH;
      const r = await gh(env, `contents/${FILE}?ref=${ref}&t=${Date.now()}`);
      if (!r.ok) return json({ error: "read failed", status: r.status }, 502);
      const meta = await r.json();
      return new Response(fromBase64Utf8(meta.content), {
        headers: {
          ...CORS,
          "Content-Type": "application/json",
          "X-Data-Sha": meta.sha || "",
        },
      });
    }

    // ---- WRITE ------------------------------------------------------------
    if (request.method === "PUT") {
      // Authorize: caller must prove they know the admin password. Fail
      // CLOSED — if WRITE_PASSWORD is unset (missing/misconfigured secret),
      // every write used to be silently accepted with no auth at all.
      if (!env.WRITE_PASSWORD) {
        return json({ error: "server misconfigured: WRITE_PASSWORD not set" }, 401);
      }
      const expected = await sha256("carview-write:" + env.WRITE_PASSWORD);
      if (request.headers.get("X-Write-Key") !== expected) {
        return json({ error: "unauthorized" }, 401);
      }

      // Reject oversized bodies (the app's data.json is a few KB to a few
      // hundred KB; 5MB is a generous ceiling). Content-Length is a
      // client-supplied header, not proof of the actual body size — a
      // request that omits it would default to 0 and skip this check
      // entirely, so read the body as text and check its real length
      // before parsing, rather than trusting the header alone.
      const MAX_BODY_BYTES = 5 * 1024 * 1024;
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > MAX_BODY_BYTES) {
        return json({ error: "payload too large" }, 413);
      }

      const rawBody = await request.text();
      // .length is UTF-16 code units, not bytes -- re-check with the actual
      // UTF-8 byte length so multi-byte (e.g. Bengali) content can't slip
      // past the cap.
      if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
        return json({ error: "payload too large" }, 413);
      }

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return json({ error: "bad json" }, 400);
      }

      // Require a real payload — either a data object (the normal save
      // path) or a pre-encoded content string. Previously an empty/missing
      // body would silently commit `undefined` as the file content.
      const hasData = body && body.data && typeof body.data === "object";
      const hasContent = body && typeof body.content === "string";
      if (!hasData && !hasContent) {
        return json({ error: "missing data" }, 400);
      }

      // Current SHA of the file (needed by GitHub to update it).
      let sha;
      const cur = await gh(env, `contents/${FILE}?ref=${BRANCH}`);
      if (cur.ok) sha = (await cur.json()).sha;

      // Overwrite protection: if the app sent the SHA it loaded and the file
      // has changed since (someone else saved), reject instead of clobbering.
      if (body.baseSha && sha && body.baseSha !== sha) {
        return json({ error: "conflict", currentSha: sha }, 409);
      }

      const content = body.content
        ? body.content
        : toBase64Utf8(JSON.stringify(body.data, null, 2));

      const put = await gh(env, `contents/${FILE}`, {
        method: "PUT",
        body: JSON.stringify({
          message: body.message || "Update data " + new Date().toISOString(),
          content,
          sha, // omitted when file doesn't exist yet (first write)
          branch: BRANCH,
        }),
      });
      const result = await put.json();
      return json(result, put.ok ? 200 : 502);
    }

    return json({ error: "method not allowed" }, 405);
  },
};

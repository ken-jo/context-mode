// context-mode.com router — Context Mode Platform · Insights at /, OSS at /oss.
//
// File layout matches the desired URL structure so plain asset routing
// produces the right result even if Workers Builds runs an older wrangler
// that does not yet support `run_worker_first`:
//
//   web/index.html  → served at /          (Insights landing)
//   web/oss.html    → served at /oss       (OSS plugin landing)
//
// This worker only adds two extras on top of the asset routing:
//   - /insights serves the same content as /            (legacy alias)
//   - everything else falls through to env.ASSETS.fetch (favicons, etc.)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/insights") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), req));
    }
    if (path === "/oss") {
      return env.ASSETS.fetch(new Request(new URL("/oss.html", url), req));
    }
    return env.ASSETS.fetch(req);
  }
};

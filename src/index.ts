import { Hono } from "hono";

export interface Instance {
  url: string;
  status: string;
  note?: string;
  error?: string;
}

async function withCache<T>(
  env: Env,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const cachedRaw = await env.BIBLIOREADS_KV.get(key, { type: "json" });

  if (cachedRaw) {
    const { data, timestamp } = cachedRaw as { data: T; timestamp: number };
    const ageMs = Date.now() - timestamp;

    // If cache older than 24h, serve stale version but refresh in background
    if (ageMs > 24 * 60 * 60 * 1000) {
      fn()
        .then((fresh) => {
          env.BIBLIOREADS_KV.put(
            key,
            JSON.stringify({ data: fresh, timestamp: Date.now() }),
            { expirationTtl: parseInt(env.TTL || "300") }
          );
        })
        .catch((err) => console.error("Background refresh failed:", err));
    }

    return data;
  }

  // If there is no cache, then fetch a fresh copy
  const fresh = await fn();
  await env.BIBLIOREADS_KV.put(
    key,
    JSON.stringify({ data: fresh, timestamp: Date.now() }),
    { expirationTtl: parseInt(env.TTL || "300") }
  );
  return fresh;
}

async function getInstances(env: Env): Promise<Instance[]> {
  return withCache(env, "instances:raw", async () => {
    const res = await fetch(env.SOURCE_URL);
    return await res.json();
  });
}

async function checkInstance(instance: Instance, env: Env): Promise<Instance> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    parseInt(env.TIMEOUT_MS || "2000")
  );

  try {
    let ping = await fetch(instance.url, {
      method: "HEAD",
      signal: controller.signal,
    });
    if ([403, 405].includes(ping.status)) {
      ping = await fetch(instance.url, {
        method: "GET",
        signal: controller.signal,
      });
    }
    clearTimeout(timeout);

    // Consider 403 responses as an up status
    if (ping.ok || ping.status === 403) return { ...instance, status: "up" };
    if (env.WHITELIST?.split(",").includes(instance.url))
      return { ...instance, status: "up", note: "whitelisted" };
    return { ...instance, status: `error (${ping.status})` };
  } catch (err: any) {
    clearTimeout(timeout);
    if (env.WHITELIST?.split(",").includes(instance.url))
      return { ...instance, status: "up", note: "whitelisted (fetch failed)" };
    return { ...instance, status: "down", error: err.message };
  }
}

async function getChecks(env: Env): Promise<Instance[]> {
  return withCache(env, "instances:all", async () => {
    const instances = await getInstances(env);
    const limit = parseInt(env.CONCURRENCY_LIMIT || "5");
    const results: Instance[] = [];
    const queue = [...instances];

    const workers = Array(limit)
      .fill(null)
      .map(async () => {
        while (queue.length) {
          results.push(await checkInstance(queue.shift() as Instance, env));
        }
      });
    await Promise.all(workers);
    return results;
  });
}

const app = new Hono<{ Bindings: Env }>();

// Test KV storage
app.get("/kv-test", async (c) => {
  await c.env.BIBLIOREADS_KV.put("hello", "world");
  const val = await c.env.BIBLIOREADS_KV.get("hello");
  return c.text(`KV says: ${val}`);
});

// Main route
app.get("/", (c) =>
  c.html(`
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>BiblioReads Monitor</title>
      <style>
        body {
          font-family: sans-serif;
          margin: 2rem;
          line-height: 1.6;
        }
        h1 {
          margin-bottom: 1rem;
        }
        ul {
          padding-left: 1rem;
        }
        a {
          color: #0066cc;
          text-decoration: none;
        }
        a:hover {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      <h1>BiblioReads Monitor</h1>
      <ul>
        <li><a href="/instances">Raw Instance List</a></li>
        <li><a href="/all">All Instances</a></li>
        <li><a href="/up">Up Instances</a></li>
        <li><a href="/down">Down Instances</a></li>
        <li><a href="/random">Random Up Instance</a></li>
        <li><a href="/api-check">API Health Check</a></li>
      </ul>
    </body>
  </html>
`)
);

app.get("/instances", async (c) => c.json(await getInstances(c.env)));
app.get("/all", async (c) => c.json(await getChecks(c.env)));
app.get("/up", async (c) =>
  c.json((await getChecks(c.env)).filter((i: Instance) => i.status === "up"))
);
app.get("/down", async (c) =>
  c.json(
    (await getChecks(c.env)).filter(
      (i: Instance) => i.status === "down" || i.status.startsWith("error")
    )
  )
);
app.get("/random", async (c) => {
  const up = (await getChecks(c.env)).filter(
    (i: Instance) => i.status === "up"
  );
  return c.json(up[Math.floor(Math.random() * up.length)]);
});

app.get("/api-check", async (c) => {
  return c.json(
    await withCache(c.env, "api:check", async () => {
      const domain = c.env.API_DOMAIN;
      const routes = [
        {
          path: "/api/search/books",
          body: {
            queryURL: "https://www.goodreads.com/search?q=harry%20potter",
          },
        },
        {
          path: "/api/book-scraper",
          body: {
            queryURL:
              "https://www.goodreads.com/book/show/2767052-the-hunger-games",
          },
        },
        {
          path: "/api/similar-scraper",
          body: { queryURL: "https://goodreads.com/book/similar/1540236" },
        },
        {
          path: "/api/author/info",
          body: {
            queryURL:
              "https://www.goodreads.com/author/show/1077326.J_K_Rowling",
          },
        },
        {
          path: "/api/works/quotes",
          body: { queryURL: "https://www.goodreads.com/work/quotes/1540236" },
        },
      ];

      const results: any[] = [];
      const failures: any[] = [];

      await Promise.all(
        routes.map(async (route) => {
          const url = `https://${domain}${route.path}`;
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(route.body),
            });

            const raw = await res.text();
            try {
              JSON.parse(raw);
            } catch {
              throw new Error("Invalid JSON");
            }

            const passed = res.ok;
            results.push({ url, status: res.status, passed });
            if (!passed)
              failures.push({
                url,
                status: res.status,
                snippet: raw.slice(0, 200),
              });
          } catch (err: any) {
            results.push({ url, passed: false, error: err.message });
            failures.push({ url, error: err.message });
          }
        })
      );

      if (failures.length > 0) {
        const message = `API check failed:\n${failures
          .map(
            (f) =>
              `${f.url} -> ${f.error || "bad response"}\n${f.snippet || ""}`
          )
          .join("\n\n")}`;
        await fetch(c.env.NTFY_URL, {
          method: "POST",
          body: message,
          headers: { title: "API Health Check Failure", priority: "3" },
        });
      }

      return { results, failures };
    })
  );
});

export default app;

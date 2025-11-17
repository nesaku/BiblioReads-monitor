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
        body { font-family: sans-serif; margin: 2rem; background: #f9fafb; }
        h1 { margin-bottom: 1rem; }
        nav { margin-bottom: 1rem; }
        nav a { margin-right: 1rem; color: #007acc; text-decoration: none; }
        nav a:hover { text-decoration: underline; }
        #output { margin-top: 1rem; }
        table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
        th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
        th { background: #f0f0f0;  text-transform: capitalize; }
        .status-up { color: green; font-weight: bold; }
        .status-down { color: red; font-weight: bold; }
        .loading { font-style: italic; color: #555; }
      </style>
    </head>
    <body>
      <h1>BiblioReads Monitor</h1>
      <nav>
        <a href="#" onclick="loadData('/instances')">Raw List</a>
        <a href="#" onclick="loadData('/all')">All</a>
        <a href="#" onclick="loadData('/up')">Up</a>
        <a href="#" onclick="loadData('/down')">Down</a>
        <a href="#" onclick="loadRandom()">Random</a>
        <a href="#" onclick="loadApiCheck()">API Check</a>
      </nav>
      <div id="output">Select an endpoint above.</div>

      <script>
        async function loadData(endpoint) {
          document.getElementById('output').innerHTML = '<div class="loading">Loading...</div>';
          try {
            const res = await fetch(endpoint);
            const data = await res.json();
            renderInstances(data);
          } catch (err) {
            document.getElementById('output').innerHTML = '<div style="color:red">Error loading data</div>';
          }
        }

        function renderInstances(data) {
          if (!Array.isArray(data)) {
            document.getElementById('output').innerHTML =
              '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
            return;
          }
          let html = '<table><thead><tr>';
          const keys = Object.keys(data[0] || {});
          keys.forEach(k => html += '<th>' + k + '</th>');
          html += '</tr></thead><tbody>';
          data.forEach(row => {
            html += '<tr>';
            keys.forEach(k => {
              let val = row[k];
              if (val === undefined) { html += '<td></td>'; return; }
              if (k.toLowerCase().includes('url') || k.toLowerCase().includes('instance')) {
                val = '<a href="' + row[k] + '" target="_blank">' + row[k] + '</a>';
              }
              if (k.toLowerCase().includes('status')) {
                const cls = val === 'up' ? 'status-up' : 'status-down';
                val = '<span class="' + cls + '">' + val + '</span>';
              }
              html += '<td>' + val + '</td>';
            });
            html += '</tr>';
          });
          html += '</tbody></table>';
          document.getElementById('output').innerHTML = html;
        }

        async function loadRandom() {
          document.getElementById('output').innerHTML = '<div class="loading">Loading random instance...</div>';
          try {
            const res = await fetch('/random');
            const data = await res.json();
            if (data.url) {
              document.getElementById('output').innerHTML =
                '<p>Random instance: <a href="' + data.url + '" target="_blank">' + data.url + '</a></p>';
            } else {
              document.getElementById('output').innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
            }
          } catch (err) {
            document.getElementById('output').innerHTML = '<div style="color:red">Error loading random instance</div>';
          }
        }

        async function loadApiCheck() {
          document.getElementById('output').innerHTML = '<div class="loading">Running API health check...</div>';
          try {
            const res = await fetch('/api-check');
            const data = await res.json();
            renderApiCheck(data);
          } catch (err) {
            document.getElementById('output').innerHTML = '<div style="color:red">Error running API check</div>';
          }
        }

        function renderApiCheck(data) {
          if (!data.results) {
            document.getElementById('output').innerHTML =
              '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
            return;
          }
          let html = '<h2>API Health Check Results</h2><table><thead><tr><th>Endpoint</th><th>Status</th><th>Passed</th></tr></thead><tbody>';
          data.results.forEach(item => {
            const statusClass = item.passed ? 'status-up' : 'status-down';
            html += '<tr>';
            html += '<td><a href="' + item.url + '" target="_blank">' + item.url + '</a></td>';
            html += '<td>' + item.status + '</td>';
            html += '<td><span class="' + statusClass + '">' + (item.passed ? '✔' : '✖') + '</span></td>';
            html += '</tr>';
          });
          html += '</tbody></table>';
          if (data.failures && data.failures.length > 0) {
            html += '<h3>Failures</h3><ul>';
            data.failures.forEach(f => {
              html += '<li><a href="' + f.url + '" target="_blank">' + f.url + '</a></li>';
            });
            html += '</ul>';
          }
          document.getElementById('output').innerHTML = html;
        }
      </script>
    </body>
  </html>
`)
);

// API Routes
app.get("/routes", (c) =>
  c.html(`
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>BiblioReads Monitor Routes</title>
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

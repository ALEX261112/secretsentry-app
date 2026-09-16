// SecretSentry backend — scan de fuite via l'API GitHub Code Search.
//
// Important par conception : ce serveur ne reçoit et ne stocke jamais la
// VALEUR d'un secret, seulement son NOM (ex. "STRIPE_SECRET_KEY"). On
// cherche des dépôts publics où ce nom de variable apparaît assigné en dur
// (ex. "STRIPE_SECRET_KEY=sk_live_..."), ce qui est le signal réel d'une
// fuite — jamais la vraie clé de l'utilisateur.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 8787;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

app.use(express.json({ limit: "16kb" }));
app.use(cors({ origin: ALLOWED_ORIGIN }));

// Protège notre propre serveur (indépendamment des limites GitHub)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests", message: "Trop de scans, réessaie dans une minute." },
});
app.use("/api/", limiter);

// Cache mémoire simple (5 min) pour éviter de re-taper l'API GitHub sur les
// mêmes requêtes répétées — l'API search de GitHub est limitée à 10 req/min
// sans token, 30 req/min avec un token.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  cache.set(key, { value, at: Date.now() });
}

// Construit une requête GitHub Code Search ciblée sur une assignation en
// dur du nom de variable — réduit fortement les faux positifs par rapport
// à une simple recherche du nom seul.
function buildQuery(secretName) {
  const cleaned = String(secretName).trim().slice(0, 100);
  return `${cleaned} in:file`;
}

async function searchGitHubCode(secretName) {
  const query = buildQuery(secretName);
  const cacheKey = `code:${query}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, from_cache: true };

  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=5`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "SecretSentry-Scanner",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  const remaining = res.headers.get("x-ratelimit-remaining");
  const resetAt = res.headers.get("x-ratelimit-reset");

  if (res.status === 403 || res.status === 429) {
    const err = new Error("github_rate_limited");
    err.code = "rate_limited";
    err.resetAt = resetAt ? new Date(Number(resetAt) * 1000).toISOString() : null;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`github_error_${res.status}`);
    err.code = "upstream_error";
    err.detail = body.slice(0, 300);
    throw err;
  }

  const data = await res.json();
  const result = {
    query,
    total_count: data.total_count || 0,
    sample: (data.items || []).slice(0, 5).map((item) => ({
      repo: item.repository && item.repository.full_name,
      path: item.path,
      url: item.html_url,
    })),
    rate_remaining: remaining ? Number(remaining) : null,
  };
  setCached(cacheKey, result);
  return { ...result, from_cache: false };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, github_token_configured: Boolean(GITHUB_TOKEN) });
});

// POST /api/scan  body: { secrets: [{ name, service }] }
app.post("/api/scan", async (req, res) => {
  const secrets = Array.isArray(req.body && req.body.secrets) ? req.body.secrets : [];
  if (!secrets.length) {
    return res.status(400).json({ error: "invalid_argument", message: "Envoie au moins un secret { name, service }." });
  }
  if (secrets.length > 10) {
    return res.status(400).json({ error: "invalid_argument", message: "10 secrets maximum par scan." });
  }

  const results = [];
  for (const s of secrets) {
    const name = s && s.name ? String(s.name) : null;
    if (!name) continue;
    try {
      const r = await searchGitHubCode(name);
      results.push({
        name,
        service: s.service || null,
        exposed_hits: r.total_count,
        sample: r.sample,
        from_cache: r.from_cache,
      });
    } catch (e) {
      results.push({
        name,
        service: s.service || null,
        error: e.code || "unknown_error",
        message:
          e.code === "rate_limited"
            ? "Limite de l'API GitHub atteinte — ajoute un GITHUB_TOKEN dans .env pour augmenter le quota (30 req/min au lieu de 10)."
            : "Le scan a échoué pour ce secret.",
        reset_at: e.resetAt || null,
      });
    }
  }

  res.json({
    scanned_at: new Date().toISOString(),
    github_authenticated: Boolean(GITHUB_TOKEN),
    results,
  });
});

app.listen(PORT, () => {
  console.log(`SecretSentry backend en écoute sur http://localhost:${PORT}`);
  console.log(`GitHub token configuré : ${Boolean(GITHUB_TOKEN)}`);
});

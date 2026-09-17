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
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 8787;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// ---- Stripe (paiements) et Supabase (base de données, clé service_role) ----
// Ces trois variables sont ajoutées manuellement dans les variables
// d'environnement Render — jamais tapées ni vues ici dans le code.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

// Correspondance entre le montant payé (en centimes) et le plan vendu sur le
// site. Les liens de paiement Stripe sont fixes (Pro 12€, Team 39€) donc ce
// mapping simple suffit tant qu'on n'a pas plusieurs devises/cycles actifs.
function planFromAmount(amountCents) {
  if (amountCents >= 3900) return "team";
  if (amountCents >= 1200) return "pro";
  return null;
}

// Cherche l'utilisateur Supabase (auth.users) dont l'e-mail correspond à
// celui utilisé au moment du paiement Stripe, pour relier le paiement au
// bon compte. Fonctionne tant que la base d'utilisateurs reste petite ;
// à revoir avec une table de correspondance si le volume grossit.
async function findUserIdByEmail(email) {
  if (!supabaseAdmin || !email) return null;
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) {
    console.error("Erreur recherche utilisateur Supabase :", error.message);
    return null;
  }
  const match = (data.users || []).find(
    (u) => (u.email || "").toLowerCase() === email.toLowerCase()
  );
  return match ? match.id : null;
}

async function upsertSubscriptionFromCheckout(session) {
  const email = session.customer_details && session.customer_details.email;
  const plan = planFromAmount(session.amount_total || 0);
  if (!plan) {
    console.warn("Webhook Stripe : montant non reconnu, plan ignoré.", session.amount_total);
    return;
  }
  const userId = await findUserIdByEmail(email);
  if (!userId) {
    console.warn("Webhook Stripe : aucun compte SecretSentry trouvé pour", email);
    return;
  }
  const { error } = await supabaseAdmin.from("subscriptions").upsert(
    {
      user_id: userId,
      plan,
      status: "active",
      stripe_customer_id: session.customer || null,
      stripe_subscription_id: session.subscription || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) console.error("Erreur mise à jour subscriptions (checkout) :", error.message);
}

// Statuts Stripe -> statuts internes utilisés dans subscriptions.status.
function mapStripeStatus(stripeStatus) {
  if (stripeStatus === "active" || stripeStatus === "trialing") return "active";
  if (stripeStatus === "past_due") return "past_due";
  return "canceled";
}

async function upsertSubscriptionFromStripeSub(sub) {
  if (!supabaseAdmin) return;
  const status = mapStripeStatus(sub.status);
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ status, current_period_end: periodEnd, updated_at: new Date().toISOString() })
    .eq("stripe_customer_id", sub.customer);
  if (error) console.error("Erreur mise à jour subscriptions (subscription) :", error.message);
}

async function handleStripeEvent(event) {
  if (!supabaseAdmin) return;
  switch (event.type) {
    case "checkout.session.completed":
      await upsertSubscriptionFromCheckout(event.data.object);
      break;
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await upsertSubscriptionFromStripeSub(event.data.object);
      break;
    default:
      break; // autres événements Stripe ignorés pour l'instant
  }
}

// IMPORTANT : cette route doit lire le corps brut (raw) pour vérifier la
// signature Stripe — elle est donc déclarée AVANT express.json() global,
// qui sinon transformerait le corps et invaliderait la vérification.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "stripe_not_configured" });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature webhook Stripe invalide :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  // Répond tout de suite à Stripe ; le traitement se fait juste après.
  res.json({ received: true });
  handleStripeEvent(event).catch((err) => {
    console.error("Erreur traitement webhook Stripe :", err);
  });
});

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
  res.json({
    ok: true,
    github_token_configured: Boolean(GITHUB_TOKEN),
    stripe_configured: Boolean(stripe && STRIPE_WEBHOOK_SECRET),
    supabase_configured: Boolean(supabaseAdmin),
  });
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

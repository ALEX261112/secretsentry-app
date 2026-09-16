# SecretSentry — de la démo au Play Store

Suivi de rotation de secrets/clés API pour développeurs, avec scan de fuite via
l'API GitHub Code Search. Ce dossier contient tout le code ; ce README est le
chemin complet jusqu'à une appli publiée.

## Ce qu'il y a dedans

```
secretsentry-app/
├── www/index.html       ← la web app (front-end, autonome)
├── server/               ← le backend (scan de fuite réel)
│   ├── index.js
│   ├── package.json
│   └── .env.example
├── android/               ← projet Android généré par Capacitor (icônes + splash déjà intégrés)
├── assets/                ← sources de l'icône/splash (icon.png, icon-foreground.png, ...)
├── capacitor.config.json
├── render.yaml            ← déploiement en un clic du backend sur Render
└── package.json
```

Une version en ligne (sans backend, scan en mode démo) est déjà publiée ici :
elle sert de vitrine/pitch, pas de base pour l'appli Android — pour ça, pars
du dossier `www/`.

## 1. Lancer le backend en local (avec ton propre token GitHub)

**Important : ce token n'est à toi. Ne le colle jamais dans le chat avec moi
ni avec personne — il va uniquement dans le fichier `.env` local, qui n'est
jamais commité (déjà dans `.gitignore`).**

1. Va sur [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
   (tokens "fine-grained", plus sûrs que les classiques)
2. **Generate new token** → donne-lui un nom (`secretsentry-dev`) → expiration
   30 ou 90 jours → **Repository access : Public Repositories (read-only)**
   suffit, aucune permission en écriture n'est nécessaire
3. Génère, copie le token (il ne sera affiché qu'une fois)

```bash
cd server
cp .env.example .env
# ouvre .env et colle ton token après GITHUB_TOKEN=
npm install
npm start
```

Le serveur écoute sur `http://localhost:8787`. Teste avec :

```bash
curl -X POST http://localhost:8787/api/scan \
  -H "Content-Type: application/json" \
  -d '{"secrets":[{"name":"STRIPE_SECRET_KEY","service":"Stripe"}]}'
```

**Important, dès la conception :** le backend ne reçoit jamais la valeur d'un
secret, seulement son nom (ex. `STRIPE_SECRET_KEY`). Il cherche des dépôts
publics où ce nom apparaît assigné en dur — jamais la vraie clé de
l'utilisateur. Garde ce principe si tu étends le produit : ne fais jamais
transiter une vraie clé API vers ton serveur.

## 2. Tester la web app avec le vrai backend

```bash
cd www
python3 -m http.server 8899
# ouvre http://localhost:8899 — le bouton "Scanner les fuites" appelle
# maintenant le backend réel (repli automatique en mode démo s'il est injoignable)
```

## 3. Builder l'appli Android

Prérequis sur ta machine : [Android Studio](https://developer.android.com/studio)
(il installe le SDK et le JDK dont tu as besoin).

```bash
npm install
npx cap sync android
npx cap open android   # ouvre le projet dans Android Studio
```

Dans Android Studio : **Build → Generate Signed Bundle / APK**, choisis
**Android App Bundle (.aab)** (format exigé par le Play Store), crée une clé
de signature (garde-la précieusement, tu en as besoin pour chaque mise à
jour), et build.

Avant de builder en prod, mets à jour l'URL du backend : dans
`www/index.html`, remplace `http://localhost:8787` par l'URL de ton backend
déployé (`window.SECRETSENTRY_API_BASE`), puis relance `npx cap sync android`.

**Icône et splash screen** : déjà générés et intégrés (toutes les densités
Android + mode sombre) à partir des sources dans `assets/` — thème marine/laiton
assorti à la démo. Pour changer de design, remplace `assets/icon.png`,
`assets/icon-foreground.png`, `assets/icon-background.png` et `assets/splash.png`,
puis relance `npx capacitor-assets generate --android`.

## 4. Déployer le backend en production — et la question de la carte bancaire

**Tant que tu es en phase de validation, tu n'as besoin d'aucun compte
d'hébergement ni d'aucune carte bancaire.** Le mode local (section 1) suffit
pour tester, faire des démos, montrer le produit à des gens. Ne saute à
cette section que quand tu es prêt à avoir une URL publique en permanence.

Ce dossier a déjà un repo Git local avec un premier commit (`git log` te le
montre) — il ne reste qu'à le pousser toi-même, avec ton propre compte :

```bash
# crée un repo vide sur github.com (bouton "New repository"), puis :
cd secretsentry-app
git remote add origin https://github.com/<toi>/secretsentry-app.git
git push -u origin main
```

Je ne touche jamais à tes identifiants — ça reste ta session GitHub, sur ta
machine.

Pour l'hébergement, sois vigilant : **certains hébergeurs "gratuits"
(Render inclus) demandent quand même une carte bancaire pour vérifier
l'identité**, même sur le plan gratuit — c'est inconsistant et ça a changé
plusieurs fois ces dernières années. Aucune carte n'est débitée sur un plan
gratuit, mais si l'idée de la renseigner te bloque, tu as deux options sans
carte :
- **Rester en local plus longtemps** (le plus simple, zéro friction)
- **Un PC toujours allumé** (le tien, ou un Raspberry Pi) exposé via un
  tunnel gratuit comme [ngrok](https://ngrok.com) ou
  [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) —
  aucune carte, aucun compte cloud payant

Si tu choisis quand même un hébergeur cloud, `render.yaml` est prêt à
l'emploi (Render lit la config tout seul via "New → Blueprint") ; Railway et
Fly.io fonctionnent pareil, juste sans blueprint automatique.

## 5. Comment tu reçois l'argent des abonnements

**Recevoir de l'argent ne demande jamais de carte bancaire** — une carte
sert à *payer*, pas à *être payé*. Pour encaisser des abonnements (via ta
web app, en dehors du Play Store — voir la section légale ci-dessous), le
chemin standard est **Stripe** :

1. Crée un compte sur [dashboard.stripe.com/register](https://dashboard.stripe.com/register)
   — gratuit, aucune carte demandée à l'inscription
2. Stripe te demande de "activer les paiements" : une pièce d'identité, ton
   **IBAN/RIB** (pas une carte — c'est là que l'argent arrive), et un
   **numéro SIRET** puisque tu factures à titre professionnel
3. Le SIRET vient du statut auto-entrepreneur — inscription gratuite sur
   [autoentrepreneur.urssaf.fr](https://www.autoentrepreneur.urssaf.fr),
   tu reçois ton SIRET sous quelques jours
4. Une fois activé, Stripe prélève sa commission (environ 1,5% + 0,25€ par
   transaction en France) et vire le reste sur ton compte bancaire
   automatiquement (tous les jours ou toutes les semaines, réglable)

Je ne suis pas conseiller financier, donc pour les détails fiscaux exacts
(régime auto-entrepreneur, seuils de TVA, etc.) une vérification auprès de
l'URSSAF ou d'un comptable reste utile — mais côté mécanique technique,
c'est bien : ID + IBAN + SIRET, jamais de carte.

## 6. Publier sur le Google Play Store

Ça, c'est la partie que tu dois faire toi-même (compte + paiement) :

1. Crée un compte [Google Play Console](https://play.google.com/console) —
   25$ de frais unique, vérification d'identité (1-2 jours parfois)
2. Crée une nouvelle appli, remplis la fiche store (description, captures
   d'écran, catégorie "Outils" ou "Productivité")
3. **Politique de confidentialité obligatoire** — même en stockant seulement
   des noms de secrets côté client, tu dois publier une page de politique de
   confidentialité (un simple markdown hébergé suffit) et remplir le
   formulaire "Data safety" de Google
4. Upload le `.aab` signé, choisis une piste de test interne d'abord (rapide,
   pas de review), puis passe en production quand tu es prêt (review Google :
   1-3 jours en général)

### Le point légal à connaître avant de fixer tes prix

Si tu vends l'abonnement Pro/Team **depuis l'appli Android**, Google t'oblige
à utiliser **Google Play Billing** — tu ne peux pas rediriger vers Stripe
directement dans l'appli pour un abonnement numérique (violation de policy,
appli rejetée). Google prend une commission (15% en général en dessous de 1M$
de revenu annuel, via leur programme pour petits développeurs). Deux options
réalistes :
- Vendre l'abonnement uniquement sur ta web app (Stripe, 0 commission
  plateforme), et faire de l'appli Android un simple client qui se connecte à
  un compte déjà payant — c'est ce que font Spotify, Netflix, etc.
- Intégrer Google Play Billing directement dans l'appli si tu veux vendre
  depuis le Store

## 7. Avant de te lancer pour de vrai

- Statut : en France, il te faut un statut (auto-entrepreneur suffit pour
  démarrer) pour facturer légalement des abonnements
- RGPD : même des métadonnées de secrets sont des données utilisateur —
  CGU/CGV + politique de confidentialité + hébergement des données en UE de
  préférence
- Le scan de fuite actuel ne couvre que le code source public GitHub — les
  concurrents sérieux (GitGuardian, TruffleHog) couvrent aussi les gists, les
  paquets npm/PyPI publiés, Docker Hub... de quoi étoffer le produit une fois
  les premiers retours utilisateurs en main

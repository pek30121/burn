# CLAUDE.md — instructions permanentes

Moteur universel de burn/progression pour tokens SPL Solana (Pump.fun en priorité). Backend uniquement, indépendant de tout frontend.

## Commandes
- `npm run typecheck` — TypeScript strict, sans émission.
- `npm test` — runner `node:test` (Node ≥ 22.18, TypeScript exécuté nativement).
- `npm run check` — les deux ; à lancer avant chaque commit. Avec `TEST_DATABASE_URL` (base de test dédiée, voir `.env.example`) les tests PostgreSQL réels s'exécutent ; sans elle ils sont **ignorés** (ne jamais les compter comme réussis).
- `npm start` — lance le moteur (`.env` lu si présent ; `src/main.ts`). Arrêt propre sur SIGINT/SIGTERM.
- `npm run db:migrate` — applique `migrations/` à `DATABASE_URL`.

## Méthode de travail (permanente)
- Une seule étape technique à la fois ; implémenter directement quand les exigences sont précises ; aucune fonctionnalité non demandée ; pas de refactorisation de code fonctionnel sans nécessité démontrée.
- Lire uniquement les fichiers nécessaires ; ne consulter/mettre à jour CLAUDE.md et DECISIONS.md que pour des décisions durables ; ne jamais redemander une information déjà validée ; ne poser de question que pour une décision bloquante non déductible.
- Tests ciblés d'abord, puis `npm run check` complet en fin d'étape ; ne jamais affirmer qu'une fonctionnalité marche sans test correspondant ; ne jamais réduire les contrôles essentiels (sécurité, exactitude on-chain, déduplication, finalité, reprise après incident).
- Blocage : chercher une solution ciblée avant de proposer une refonte. Garder l'architecture multi-tokens et l'indépendance du frontend. Ne pousser que du code testé, sur la branche de développement existante.
- Rapport final, sans quiz ni long récapitulatif : Développé (3 lignes max) / Tests (résultats exacts) / Limites ou blocages (si présents) / Prochaine étape (une phrase).

## Règles non négociables
- Montants : `bigint` en unités brutes. Jamais de `number`, `parseFloat` ou `Math.round` sur un montant de token.
- Ne jamais faire confiance à un montant ou un statut venant du navigateur : seule une transaction relue via RPC fait foi.
- Un burn = `(signature, instructionPath)` ; toute écriture est idempotente.
- Les événements de niveau ne partent que du total finalisé.
- Aucune clé privée côté serveur ; aucune clé API dans les logs, réponses ou fichiers commités (`.env` est ignoré, seul `.env.example` est versionné).
- Pas de Mainnet ni de service payant dans les tests ; tests réseau uniquement sur Devnet, et isolés des tests unitaires.
- Toute donnée est clée par `project_id` ; aucun état partagé entre projets. Erreurs/logs : jamais l'URL ni le mot de passe de la base (passer par `StoreError`).
- Jamais présenter l'estimation de crédits RPC (`RpcMeter`) comme la facturation réelle du fournisseur.
- API publique : lecture seule, jamais d'action ni de configuration modifiable ; montants en **chaînes** décimales ; rien d'interne dans les réponses (URL RPC, SQL, textes d'erreur, détails d'incidents) ; SSE/événements uniquement depuis le journal durable `project_events` (burns finalisés), ids alloués sous le verrou des compteurs. Toute évolution de ce chemin exige les tests de non-perte/ordre (`api-sse`, `api.pg`).
- Devnet : n'annoncer un scénario comme validé que s'il a réellement été exécuté (voir `docs/DEVNET.md` pour ce qui l'est et ne l'est pas) ; une simulation locale n'est jamais présentée comme un test réel. Le moteur ne dépend jamais des logs de programme.
- Parseur : une réponse `malformed` ou un résultat `complete: false` n'est **pas** « aucun burn » — l'appelant doit réessayer ou alerter, jamais l'ignorer. Les transactions `failed` ne comptent jamais.
- Ne jamais annoncer une couverture exhaustive des burns sans preuve : citer les expériences de DECISIONS.md (E1) et leurs limites.

- Wallet : le compteur ne bouge que sur un burn listé par le journal du moteur (jamais sur une signature envoyée) ; le module ne signe jamais ; extensions Token-2022 inconnues = bloquées. Identifiants de programmes : toujours vérifiés contre des données on-chain réelles (D23).
- H2 (D25) : `tokenProgram` doit être le propriétaire on-chain du mint, sinon refus de démarrer ; le transport en lot (D26) ne remplace jamais la découverte par `getSignaturesForAddress` et se replie sur `getTransaction` ; la surveillance de quota (D27) reste une estimation locale.
- Preuve par la supply (D32) : jamais « prouvé » avec une autorité de mint active, `ConfidentialMintBurn` ou le mint SOL natif ; `history.reason` expose un code public, jamais le texte interne ; les incidents de contenu ne s'effacent jamais seuls.
- La clé Helius du moteur ne doit jamais être utilisée par un navigateur.

## Conventions de code
- ESM, imports relatifs avec extension `.ts`, syntaxe effaçable uniquement (`erasableSyntaxOnly` : pas d'`enum`, pas de propriétés de paramètres de constructeur).
- Fonctions pures dans `src/core`, I/O (RPC, base, HTTP) dans des modules séparés, injectables pour les tests.
- Dépendances : n'en ajouter une que si elle est nettement moins risquée que le code équivalent ; le justifier dans DECISIONS.md.
- Ne jamais annoncer qu'un test passe sans l'avoir exécuté.

## Structure
- `src/core/` — montants, base58, progression, ledger de référence.
- `src/config/` — schéma et registre des projets.
- `src/chain/` — lecture de la chaîne : `burn-parser.ts` (pur, sans I/O), `rpc.ts` (client JSON-RPC, `fetch` injectable). Entrée : réponse `getTransaction` en `encoding: "json"` avec `maxSupportedTransactionVersion: 1`.
- `src/indexer/` — `indexer.ts` (un par projet : backfill, tail, confirmé/finalisé, reconcile), `store.ts` (interface de stockage + curseur), `memory-store.ts`, `pg-store.ts` (PostgreSQL, mêmes tests que la mémoire).
- `src/engine/` — assemblage : `config.ts` (env), `engine.ts` (`startEngine`/`stop`/`status`), `runner.ts` (un par projet : bail, backoff), `limiter.ts` + `meter.ts` (débit et compteurs RPC, estimation locale ≠ facturation), `logger.ts` (JSON expurgé). `src/main.ts` : point d'entrée.
- `src/engine/activation.ts` + `src/chain/mint-history.ts` — projets `awaitMint` (mint pas encore créé) : surveillance, validation depuis la chaîne, activation sans redéploiement, blocage du seul projet fautif ; voir DECISIONS D41 et `docs/VIRUS-INTEGRATION.md`. `deploy/projects.mainnet.json` = VIRUS seul (FLAPY retiré).
- `src/api/` — API publique **en lecture seule** : `http.ts` (routes, CORS, limites), `sse.ts` (flux), `serialize.ts` (formes publiques), `limits.ts`, `types.ts` (contrat `ApiSource`, implémenté par `PgStore`).
- `src/wallet/` — module wallet côté navigateur, **sans design ni clé** : `tx.ts` (transaction non signée), `token-info.ts` (Token/Token-2022, fail-closed), `wallet-standard.ts`, `rpc.ts`, `engine-client.ts`, `controller.ts` (machine à états), `errors.ts`. Voir `docs/WALLET.md` et DECISIONS D24.
- `web/wallet-test/` + `scripts/wallet-test/` — page de test wallet **sans design**, proxy RPC navigateur (clé serveur jamais exposée), setup Devnet, test Chromium ; voir `docs/WALLET-TEST.md` et D28. `web/dist/` est généré (`npm run web:build`).
- `scripts/replit/` + `.replit` + `deploy/` — superviseur moteur + page pour un seul Replit (Devnet uniquement) ; voir `deploy/README.md` et D31. `dist/` et `web/serve-dist/` sont générés (`npm run build:replit`).
- `web/virus/` — site VIRUS.EXE (statique, visuel inchangé) servi sous `/virus/` ; `js/project.js` = unique point de configuration (projet, mint attendu), `js/engine-bridge.js` = pont réel vers l'API du moteur, `js/burn-ui.js` = fenêtre BURN sur le module wallet. `css/win98.css` = couche de peinture seule (la géométrie des fenêtres/popups est figée par `tests/virus-geometry.test.ts`, ne jamais la modifier sans accord ; voir `docs/VIRUS-VISUAL-REFIT.md`, D39). Voir `docs/VIRUS-INTEGRATION.md` et D36. Aucun token VIRUS n'existe tant que le mint n'est pas renseigné ; ne jamais y mettre FLAPY ni l'adresse provisoire du ZIP.
- `scripts/virus-preview/` + `web/virus-preview/` — prévisualisation VIRUS.EXE **isolée** sur données simulées (`npm run virus:preview`) ; refuse de tourner avec les secrets du vrai moteur ; jamais démarrée par la production. `scripts/replit/{git-check.sh,verify-deploy.mjs,build-info.mjs}` — synchronisation Git sûre, vérification HTTP d'un déploiement, `/build-info`. Voir `docs/REPLIT-WORKFLOW.md` et D38.
- `scripts/mainnet/` — audit **lecture seule** du Mainnet (liste blanche de méthodes RPC, garde par hash de genèse) ; voir `docs/MAINNET.md`. Jamais d'envoi de transaction.
- `scripts/devnet/` — outillage et scénarios Devnet (voir `docs/DEVNET.md`) ; jamais de Mainnet, jamais de clé affichée/commitée (`.devnet/` ignoré).
- `src/db/` — `config.ts` (env → pool), `errors.ts` (erreurs expurgées), `migrate.ts`. `migrations/` — SQL versionné, jamais modifié après application (checksum).
- `config/projects.example.json` — exemple de configuration multi-tokens.
- `tests/` — tests unitaires (`*.test.ts`) ; `fake-chain.ts` simule un nœud avec pannes injectables. `tests/fixtures/` : vraies transactions Devnet enregistrées (réponses `getTransaction` brutes), à ne pas modifier à la main.
- `DECISIONS.md` — décisions d'architecture : à mettre à jour à chaque choix structurant.

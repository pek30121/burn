# CLAUDE.md — instructions permanentes

Moteur universel de burn/progression pour tokens SPL Solana (Pump.fun en priorité). Backend uniquement, indépendant de tout frontend.

## Commandes
- `npm run typecheck` — TypeScript strict, sans émission.
- `npm test` — runner `node:test` (Node ≥ 22.18, TypeScript exécuté nativement).
- `npm run check` — les deux ; à lancer avant chaque commit.

## Règles non négociables
- Montants : `bigint` en unités brutes. Jamais de `number`, `parseFloat` ou `Math.round` sur un montant de token.
- Ne jamais faire confiance à un montant ou un statut venant du navigateur : seule une transaction relue via RPC fait foi.
- Un burn = `(signature, instructionPath)` ; toute écriture est idempotente.
- Les événements de niveau ne partent que du total finalisé.
- Aucune clé privée côté serveur ; aucune clé API dans les logs, réponses ou fichiers commités (`.env` est ignoré, seul `.env.example` est versionné).
- Pas de Mainnet ni de service payant dans les tests ; tests réseau uniquement sur Devnet, et isolés des tests unitaires.
- Toute donnée est clée par `project_id` ; aucun état partagé entre projets.
- Parseur : une réponse `malformed` ou un résultat `complete: false` n'est **pas** « aucun burn » — l'appelant doit réessayer ou alerter, jamais l'ignorer. Les transactions `failed` ne comptent jamais.
- Ne jamais annoncer une couverture exhaustive des burns sans preuve : citer les expériences de DECISIONS.md (E1) et leurs limites.

## Conventions de code
- ESM, imports relatifs avec extension `.ts`, syntaxe effaçable uniquement (`erasableSyntaxOnly` : pas d'`enum`, pas de propriétés de paramètres de constructeur).
- Fonctions pures dans `src/core`, I/O (RPC, base, HTTP) dans des modules séparés, injectables pour les tests.
- Dépendances : n'en ajouter une que si elle est nettement moins risquée que le code équivalent ; le justifier dans DECISIONS.md.
- Ne jamais annoncer qu'un test passe sans l'avoir exécuté.

## Structure
- `src/core/` — montants, base58, progression, ledger de référence.
- `src/config/` — schéma et registre des projets.
- `src/chain/` — lecture de la chaîne : `burn-parser.ts` (pur, sans I/O). Entrée : réponse `getTransaction` en `encoding: "json"` avec `maxSupportedTransactionVersion: 1`.
- `config/projects.example.json` — exemple de configuration multi-tokens.
- `tests/` — tests unitaires (`*.test.ts`). `tests/fixtures/` : vraies transactions Devnet enregistrées (réponses `getTransaction` brutes), à ne pas modifier à la main.
- `DECISIONS.md` — décisions d'architecture : à mettre à jour à chaque choix structurant.

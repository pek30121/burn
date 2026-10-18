# DECISIONS

Journal des décisions d'architecture. Chaque entrée : décision, raison, alternatives rejetées.
Statuts : **ACTÉ** (implémenté et testé), **RETENU** (choisi, pas encore implémenté), **À VÉRIFIER** (hypothèse), **À VALIDER** (attend l'accord du propriétaire).

---

## D1 — Montants : `bigint` en unités brutes partout — ACTÉ
Les montants on-chain sont des u64 en unités de base. Le moteur les garde en `bigint` de bout en bout (parsing RPC, ledger, seuils, API) et ne passe jamais par un `number` JS (2^53 < u64 max, plus les erreurs d'arrondi des flottants).
- Les seuils de la config sont écrits en unités UI sous forme de **chaînes décimales** (`"5000.5"`) et convertis exactement avec les `decimals` du mint. Un `number` n'est accepté que s'il est un entier sûr.
- Si une valeur a plus de décimales que le mint, elle est refusée (pas d'arrondi silencieux).
- La progression est exprimée en points de base entiers (0–10000, arrondi vers le bas : une barre n'affiche jamais « 100 % » avant le seuil).
- Rejeté : `number` + arrondi, ou librairie de décimales (dépendance inutile).

## D2 — Isolation multi-tokens par configuration — ACTÉ
Un projet = `{ id, name, ticker, cluster, mint, decimals, tokenProgram, startSlot, levels[] }`, chargé depuis un JSON (`PROJECTS_CONFIG`). Aucun élément visuel dans le moteur.
- `id` unique ; un couple `(cluster, mint)` appartient à un seul projet → un burn ne peut jamais être attribué à deux projets.
- Config validée champ par champ (tous les problèmes sont listés d'un coup) puis gelée en profondeur (immuable à l'exécution).
- Chaque `BurnLedger` refuse les burns d'un autre mint ; en base, toutes les tables seront clés par `project_id`.
- Rejeté : une instance (et une base) par token → coût d'hébergement multiplié pour un gain d'isolation que les clés apportent déjà.

## D3 — Niveaux : premier seuil à 0, strictement croissants, inclusifs — ACTÉ
Le niveau `i` est atteint quand `total >= threshold_i`. Un seul burn peut franchir plusieurs niveaux : un événement par niveau, dans l'ordre. Chaque niveau ne se déclenche **qu'une fois** (garde par id ; en base : `UNIQUE(project_id, level_id)`).

## D4 — Identité d'un burn : `(signature, chemin d'instruction)` — ACTÉ
Une transaction peut contenir plusieurs burns (instructions directes ou CPI). La clé est `signature#outer` ou `signature#outer.inner`. Rejouer une même instruction est un no-op ; la rejouer avec des données différentes est **rejeté** (signe d'un bug de parsing ou d'une source corrompue), jamais fusionné.
- Rejeté : déduplication par signature seule (perd les burns multiples d'une même tx) ou par (owner, montant, slot) (collisions possibles).

## D5 — Confirmé vs finalisé — ACTÉ (modèle), RETENU (indexeur)
- Un burn `confirmed` compte dans le total **optimiste** (affichage live), pas dans le total officiel.
- Promu en `finalized` quand l'indexeur le revoit en commitment `finalized` ; un burn finalisé n'est jamais rétrogradé ni supprimé.
- Un burn `confirmed` dont le bloc est abandonné est supprimé (`drop`).
- **Les événements de niveau ne partent que du total finalisé** (~13 s de délai typique) : on ne déclenche jamais une mutation qui pourrait disparaître. Le frontend peut montrer « en cours de finalisation » à partir du total optimiste. → À VALIDER (Q4).

## D6 — Définition d'un burn : instruction SPL `Burn` / `BurnChecked` réussie — RETENU, À VALIDER (Q1)
Compté : instructions `burn` / `burnChecked` (programme Token ou Token-2022), en instruction directe **ou interne (CPI)**, dans une transaction **réussie** (`meta.err == null`), sur le mint du projet, à partir de `startSlot`.
Non compté par défaut : transferts vers l'incinérateur / adresses « dead » (la supply ne baisse pas, ce n'est pas vérifiable par la supply).
Raison : c'est la seule définition vérifiable indépendamment par la supply du mint (D8).

## D7 — Détection exhaustive : indexation par polling RPC, pas par webhook — RETENU
Fait technique : les instructions `Burn`/`BurnChecked` ont le compte **mint** dans leurs comptes (il est modifié : la supply baisse), y compris en CPI. Toute transaction contenant un burn apparaît donc dans `getSignaturesForAddress(mint)`, **quel que soit le wallet ou le site d'origine**.
Stratégie :
1. **Backfill** : pagination arrière de `getSignaturesForAddress(mint)` jusqu'à `startSlot`.
2. **Tail** : polling avec `until = dernière signature vue`, curseur persistant en base → reprise exacte après redémarrage, aucun événement manqué.
3. Pour chaque signature non échouée : `getTransaction(jsonParsed)`, extraction des burns (outer + inner).
4. **Passe de finalisation** : re-vérification en `finalized` des burns `confirmed`.
5. Webhooks / websockets (Helius) = **accélérateur optionnel uniquement**, jamais source de vérité (livraisons perdues, doublons, ordre non garanti).
- Rejeté : webhook seul (pas de garantie de livraison, pas de reprise) ; comptage via les seules tx du site (les burns externes seraient ignorés) ; scraper un explorer (non vérifiable, fragile).

## D8 — Réconciliation par la supply du mint — RETENU, À VÉRIFIER (H1)
Si l'autorité de mint est révoquée (cas Pump.fun), la supply ne peut que baisser, et uniquement par des burns. Donc :
`supply(startSlot) − supply(maintenant, finalized) == Σ burns finalisés indexés`.
Un appel `getTokenSupply` (très bon marché) détecte tout burn manqué ; en cas d'écart → re-scan de la fenêtre récente + alerte. Si l'autorité de mint n'est pas révoquée, la réconciliation est désactivée et signalée.

## D9 — RPC : JSON-RPC via `fetch`, sans SDK côté serveur — RETENU
Le serveur n'a besoin que de 4–5 méthodes (`getSignaturesForAddress`, `getTransaction`, `getTokenSupply`, `getAccountInfo`, `getSlot`) et le format `jsonParsed` décode déjà les instructions SPL. Un client `fetch` maison (retry/backoff, limitation de débit, clé API masquée dans les logs) évite une dépendance lourde. Helius = simple URL RPC (interchangeable).
- Rejeté pour le serveur : `@solana/web3.js` v1 (en maintenance) / `@solana/kit` (utile côté navigateur pour construire la tx de burn, pas nécessaire pour lire).

## D10 — Burn depuis le navigateur : signature par le wallet, vérification par le serveur — RETENU
Le navigateur construit et signe une tx `burnChecked` avec le wallet de l'utilisateur ; le serveur ne détient **aucune clé privée**. Le navigateur peut notifier `POST /burns/notify { signature }` pour accélérer l'affichage : le serveur **refetch la tx lui-même** et applique le même parser. Le montant envoyé par le navigateur n'est jamais lu. Sans notification, l'indexeur la trouve de toute façon.
- Rejeté : smart contract dédié — aucune nécessité démontrée (le programme Token sait brûler, la supply prouve le total).

## D11 — Persistance PostgreSQL, idempotente — RETENU
Tables prévues : `burns` (`UNIQUE(project_id, signature, instruction_path)`), `cursors` (dernière signature/slot par projet et commitment), `level_events` (`UNIQUE(project_id, level_id)`), `outbox` (événements à diffuser). Chaque lot ingéré = une transaction SQL (burns + curseur + événements) → un crash ne laisse jamais un état à moitié appliqué. Le `BurnLedger` en mémoire est le modèle de référence de ces règles et ses tests serviront de tests de conformité au store Postgres.

## D12 — Diffusion temps réel : REST + Server-Sent Events — RETENU
`GET /projects/:id` (snapshot), `GET /projects/:id/burns` (historique paginé), `GET /projects/:id/stream` (SSE). SSE suffit (flux serveur → client), passe les proxies/CDN, reconnexion native avec `Last-Event-ID`. Tous les visiteurs voient le même état car il vient de la base, pas du navigateur.
- Rejeté : WebSocket (bidirectionnel inutile), Firebase/Supabase realtime (dépendance et coût).

## D13 — Outillage minimal : TypeScript + `node:test`, Node ≥ 22.18 — ACTÉ
Exécution TypeScript native de Node (type stripping), tests avec le runner intégré : dépendances de dev = `typescript` + `@types/node`. `erasableSyntaxOnly` garantit que le code reste exécutable sans transpileur.
- Rejeté : vitest (npm 10 échoue à résoudre ses peers optionnels dans cet environnement, et il n'apporte rien d'indispensable ici), ts-node/tsx (inutiles avec Node 22).

---

## Hypothèses à vérifier
- **H1** : les mints Pump.fun ont l'autorité de mint révoquée après création (vérifiable via `getAccountInfo` du mint ; le moteur le vérifiera au démarrage).
- **H2** : programme des mints Pump.fun — SPL Token classique ou Token-2022 selon la date/la méthode de création. Le moteur vérifiera que `tokenProgram` de la config correspond au propriétaire on-chain du mint, et refusera de démarrer sinon.
- **H3** : volume de `getSignaturesForAddress(mint)` — le mint apparaît aussi dans chaque `transferChecked` (trades), donc beaucoup de signatures sans burn. À mesurer sur un token réel pour dimensionner le coût RPC ; options si trop cher : filtrer côté Helius (API « enhanced transactions » par type BURN) en complément, ou ne récupérer que les tx dont les logs contiennent `Instruction: Burn`.
- **H4** : délai observé confirmed → finalized et taux de blocs abandonnés sur devnet/mainnet (mesure pendant les tests devnet).
- **H5** : limites du plan gratuit Helius (requêtes/s, crédits mensuels) compatibles avec le polling choisi.

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

## D6 — Définition d'un burn : instruction SPL `Burn` / `BurnChecked` réussie — ACTÉ (validée par l'utilisateur ; parseur : D14)
Compté : instructions `burn` / `burnChecked` (programme Token ou Token-2022), en instruction directe **ou interne (CPI)**, dans une transaction **réussie** (`meta.err == null`), sur le mint du projet, à partir de `startSlot`.
Validé : Token et Token-2022 uniquement. Non compté : transferts vers l'incinérateur / adresses « dead » (la supply ne baisse pas, ce n'est pas vérifiable par la supply).
Raison : c'est la seule définition vérifiable indépendamment par la supply du mint (D8).

## D7 — Détection exhaustive : indexation par polling RPC, pas par webhook — RETENU
Fait technique : les instructions `Burn`/`BurnChecked` ont le compte **mint** dans leurs comptes (il est modifié : la supply baisse), y compris en CPI. Toute transaction réussie contenant un burn **devrait** donc apparaître dans `getSignaturesForAddress(mint)`, quel que soit le wallet ou le site d'origine. C'est un raisonnement appuyé par l'expérience E1 (116/116 burns Devnet retrouvés), **pas une preuve** : voir E1 pour les cas non observés, et D8 pour le contrôle indépendant.
Stratégie :
1. **Backfill** : pagination arrière de `getSignaturesForAddress(mint)` jusqu'à `startSlot`.
2. **Tail** : polling avec `until = dernière signature vue`, curseur persistant en base → reprise exacte après redémarrage, aucun événement manqué.
3. Pour chaque signature non échouée : `getTransaction(jsonParsed)`, extraction des burns (outer + inner).
4. **Passe de finalisation** : re-vérification en `finalized` des burns `confirmed`.
5. Webhooks / websockets (Helius) = **accélérateur optionnel uniquement**, jamais source de vérité (livraisons perdues, doublons, ordre non garanti).
- Rejeté : webhook seul (pas de garantie de livraison, pas de reprise) ; comptage via les seules tx du site (les burns externes seraient ignorés) ; scraper un explorer (non vérifiable, fragile).

## D8 — Réconciliation par la supply du mint — RETENU, À VÉRIFIER (H1)
Si l'autorité de mint est révoquée (cas Pump.fun), la supply ne peut que baisser, et uniquement par des burns. Donc :
`supplyInitiale − supply(maintenant, finalized) == Σ burns finalisés indexés`.
`getTokenSupply` ne donne que la supply **actuelle** : il faut donc connaître la supply initiale (pour Pump.fun, fixe et connue à la création ; à ajouter à la config du projet sous `initialSupply` lors de l'étape indexeur, ou à lire dans la transaction de création). La formule n'est valable que si rien n'a été minté depuis et que l'autorité de mint est révoquée.
Un appel `getTokenSupply` (très bon marché) détecte tout burn manqué ; en cas d'écart → re-scan de la fenêtre récente + alerte. Si l'autorité de mint n'est pas révoquée, la réconciliation est désactivée et signalée.

## D9 — RPC : JSON-RPC via `fetch`, sans SDK côté serveur — RETENU (paramètres de `getTransaction` : voir D15)
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

---

## D14 — Parseur de transactions : octets décodés par le moteur, pas par le RPC — ACTÉ
`src/chain/burn-parser.ts` (fonction pure) lit une réponse `getTransaction` en `encoding: "json"` et décode lui-même les instructions : programme (`programIdIndex` → clé), tag (`8` Burn, `15` BurnChecked), montant u64 little-endian, decimals. Il ne dépend donc pas du format `jsonParsed` ni de la version du parseur côté RPC, et un `bigint` est produit directement.
- **Vérifié** pour chaque burn : programme ∈ {Token, Token-2022} (optionnellement celui du projet), compte n°2 == mint du projet, au moins 3 comptes, données assez longues (les octets en trop sont acceptés, comme le dépaqueteur on-chain), `meta.err == null`, signature de la réponse == signature demandée (`expectedSignature`), decimals de BurnChecked == decimals de la config.
- **Position** : `"i"` pour l'instruction principale `i`, `"i.j"` pour la `j`-ième instruction interne (CPI) enregistrée sous `i` ; ordre d'exécution. Clé = `signature#chemin` (D4).
- **Comptes** : clés statiques + `loadedAddresses.writable` + `loadedAddresses.readonly` (ordre des tables d'adresses). Si le nombre d'adresses chargées ne correspond pas aux `addressTableLookups`, la réponse est `malformed` (on ne devine jamais).
- **Trois issues** : `ok` (avec `complete`), `failed` (jamais compté), `malformed` (≠ « aucun burn » : l'indexeur doit réessayer/alerter).
- `complete: false` si `meta.innerInstructions` est absent/null : le nœud n'a pas enregistré les CPI, un burn par CPI ne peut pas être exclu. Distinct d'une liste vide (`[]`, complète).
- Burns de montant 0 : ignorés avec avertissement (aucun effet sur la supply, refusés par le ledger).
- `holder` (propriétaire du compte de tokens, lu dans `pre/postTokenBalances` et recoupé avec le mint) est conservé à part de `authority` (signataire, éventuellement un délégué ou un multisig). Pour le ledger : `owner = holder ?? authority`.
- Rejeté : `jsonParsed` (dépend du parseur du fournisseur RPC, noms de programme variables), `@solana/web3.js` (dépendance lourde pour décoder 2 instructions).

## D15 — `getTransaction` : `encoding: "json"` et `maxSupportedTransactionVersion: 1` — ACTÉ (constat Devnet)
Constaté sur Devnet le 2026-10-18 : des transactions **de version 1** existent déjà ; avec `maxSupportedTransactionVersion: 0` le RPC répond l'erreur `-32015` pour tout bloc/transaction en contenant. Le client RPC devra donc demander `1`, et traiter `-32015` comme un signal « version non supportée » (alerte + arrêt de l'avancée du curseur), jamais comme « transaction absente ». Le parseur accepte `legacy`, `0`, `1` et refuse toute autre version (`malformed`) plutôt que de deviner un format inconnu. La disposition des instructions d'une vraie transaction v1 a été vérifiée (fixture).

## D16 — Client RPC (`src/chain/rpc.ts`) — ACTÉ
`fetch` injectable. Réessaie seulement les pannes transitoires (réseau, timeout, HTTP 429/5xx, RPC `-32005`, corps non JSON) avec backoff exponentiel plafonné et `Retry-After` (≤ 30 s) ; max 4 retries. `-32015` → `RpcUnsupportedVersionError`, jamais réessayé ni confondu avec « introuvable ». `getTransaction` renvoie `null` quand le nœud n'a pas la transaction à ce commitment (l'indexeur devra réessayer, pas conclure « pas de burn »). Les messages d'erreur n'incluent jamais l'URL (clé API) ni le texte brut du nœud.

## D17 — Indexeur (`src/indexer/`) — ACTÉ
- **Un `Indexer` par projet** ; le stockage (`IndexerStore`, async, clé `project_id`) est une interface — `MemoryStore` pour cette étape, PostgreSQL ensuite avec les mêmes tests.
- **Curseurs** : `finalizedHead` (tout ce qui est plus récent que lui reste à faire, tout ce qui est plus ancien est traité) et `backfillBefore`. Ils n'avancent qu'**après** l'enregistrement idempotent des burns couverts ; le tail est traité du plus ancien au plus récent pour que le curseur ne saute jamais une signature. Aucune transaction multi-écritures nécessaire.
- **Passes** : init/tail et backfill en `finalized` ; passe `confirmed` optionnelle (`trackConfirmed`, coûte des appels RPC, désactivée par défaut) qui alimente seulement le total optimiste. Seul le total finalisé produit des événements de niveau. Un burn confirmé absent de l'historique finalisé une fois la frontière finalisée dépassée est supprimé (fork abandonné).
- **Événements** : boîte d'envoi (outbox) dans le stockage, livraison au moins une fois, ack après succès du consommateur ; redélivrés après redémarrage. Les consommateurs dédupliquent sur (projet, niveau).
- **Erreurs** : une erreur RPC arrête la synchro sans bouger le curseur. Une signature illisible (`null`, `malformed`) est réessayée `maxSignatureAttempts` fois (compteur en mémoire), puis **mise en quarantaine comme incident visible** (`status().issues`) pour ne pas bloquer l'indexation ; `-32015` est mis en quarantaine immédiatement ; `complete:false` du parseur crée un incident `incomplete_parse`.
- **Trous** : ordre des slots non croissant ou signature en double ⇒ `history_inconsistent` ; plus de `maxTailPages × pageSize` signatures plus récentes que le curseur (ex. curseur élagué côté nœud, `until` ignoré) ⇒ `tail_gap_too_large`. Dans les deux cas : arrêt + incident, curseur inchangé.
- **Exhaustivité** : `status().complete` n'est vrai qu'après `reconcile()` réussi (supply initiale − supply actuelle == burns finalisés indexés, supply lue avant une synchro de rattrapage, relue si la chaîne a bougé). Nécessite `initialSupply` dans la config, `startSlot` 0, backfill terminé, autorité de mint révoquée (non vérifiée par le moteur). Toute modification ultérieure des burns remet la preuve à « unverified ». Les états de backfill `done_exhausted` (« le nœud n'a plus rien de plus ancien ») et `done_start_slot` ne prouvent PAS que la création du token est atteinte.
- Rejeté : persister les compteurs de tentatives (complexité sans gain tant que le redémarrage les remet à zéro avec un nouvel essai complet) ; suivre la finalité via `getSlot` (la frontière dérivée de l'historique finalisé suffit et économise un appel).

## D18 — Stockage PostgreSQL (`src/indexer/pg-store.ts`, `migrations/`, `src/db/`) — ACTÉ
- **Pilote** : `pg` 8 (seule dépendance runtime ajoutée ; réimplémenter le protocole serait nettement plus risqué), `@types/pg` en dev. Aucun service payant : Replit PostgreSQL ou tout PostgreSQL ≥ 14 via `DATABASE_URL`.
- **Schéma** (migration `0001_init.sql`, sans schéma codé en dur) : `projects`, `levels` (instantané de la config), `burns` (clé primaire `(project_id, signature, instruction_path)` = clé d'idempotence), `project_counters`, `level_events` (clé primaire `(project_id, level_id)` : un niveau ne se déclenche qu'une fois ; `delivered_at` ne suit que la livraison), `index_state` (curseurs + vérification + `version`), `index_issues`. Montants en `numeric(20,0)` avec CHECK `0 < x ≤ u64 max`, jamais de flottant ; chaque table est clée par `project_id` avec clés étrangères.
- **Atomicité** : `recordBurn` / `dropConfirmed` = une transaction (ligne de burn + compteurs + niveaux/outbox), les écrivains d'un projet sont sérialisés par un verrou de ligne sur ses compteurs. Les règles de validation ne sont pas réécrites : un `BurnLedger` jetable juge chaque entrée (mêmes raisons de rejet que la mémoire).
- **Curseur** : `saveState` reste un appel séparé, **après** les burns qu'il couvre (règle existante de l'indexeur) ; une coupure entre les deux est réparée par rejeu, qui est sans effet. Verrou optimiste (`version`) : un écrivain périmé échoue (`StaleStateError`) au lieu de déplacer un curseur à tort.
- **Outbox** : la livraison est au moins une fois ; l'effet métier (niveau atteint) est unique par construction (clé primaire, `ON CONFLICT DO NOTHING`), même si les compteurs sont restaurés à une ancienne valeur.
- **Exclusivité** : `tryLockProject` / `releaseProject` (verrou consultatif de session, par schéma et projet) pour qu'un seul processus indexe un projet ; libéré à la déconnexion.
- **Migrations** : `NNNN_nom.sql`, numérotation sans trou, une transaction chacune, checksum vérifié (fichier modifié après application = refus), exécuteurs concurrents sérialisés par verrou consultatif. `npm run db:migrate`.
- **Config/erreurs** : `DATABASE_URL`, `PG_POOL_MAX`, `PG_IDLE_TIMEOUT_MS`, `PG_CONNECTION_TIMEOUT_MS`, `PG_STATEMENT_TIMEOUT_MS`. Toute erreur de base est réécrite en `StoreError` (SQLSTATE conservé, cause supprimée) avec expurgation de l'URL et du mot de passe.
- **Tests** : la suite de l'indexeur (`tests/indexer-suite.ts`) est exécutée à l'identique sur la mémoire et sur PostgreSQL ; `tests/pg-store.test.ts` couvre ce qui est propre à PostgreSQL. `TEST_DATABASE_URL` (base dédiée dont le nom contient « test », un schéma jetable par test) ; sans elle les tests PostgreSQL sont **ignorés et signalés comme tels**.
- Hors périmètre / non fait : purge des anciens incidents, partitionnement de `burns`, réplicas de lecture, rotation des identifiants.

---

## E1 — Expérience : l'historique des signatures du mint suffit-il à découvrir tous les burns ?
**Verdict : plausible et cohérent avec toutes les observations, mais NON démontré.** Aucune couverture exhaustive n'est revendiquée.

### Argument (raisonnement)
1. Les instructions Burn/BurnChecked ont toujours le mint comme 2ᵉ compte, et le mint doit être **writable** (la supply change). Le parseur impose cette position.
2. `getSignaturesForAddress(mint)` renvoie les transactions dont la liste de comptes contient le mint, quel que soit le wallet, le site ou le programme appelant (CPI inclus : les comptes de la transaction englobent ceux des CPI).
3. Donc toute transaction réussie contenant un burn du mint devrait apparaître dans cet historique, si le fournisseur RPC en renvoie l'historique complet.

### Observations (Devnet, RPC public `api.devnet.solana.com`, 2026-10-18, lecture seule)
- Scan de ≈ 750 blocs finalisés (slots ≈ 512 380 760 – 512 381 515) : **116 burns réels** trouvés (tous programme Token classique) : 115 par CPI (110 en v0, 5 en legacy) et 1 direct (legacy).
- **116/116** parsés par `parseBurns` sans erreur ; montants égaux à la baisse du solde du compte de tokens (égalité stricte sur 43 d'entre eux ; contrôle « somme des burns du compte, ou ≥ » sur les 73 autres).
- **116/116** signatures retrouvées dans `getSignaturesForAddress(mint, finalized)` (≤ 5 pages de 1000).
- Comptes chargés via table d'adresses : **16/16 comptes writable** retrouvés dans l'historique de leur adresse (3 transactions). Le seul compte readonly de l'échantillon était un Sysvar, non indexé (clés réservées) — **non concluant** pour un compte readonly ordinaire (sans importance pour un mint, toujours writable lors d'un burn).
- 0 faux positif : 117 couples (transaction de token sans burn, adresse quelconque de la transaction prise comme mint).
- Un échantillon de blocs ne prouve rien sur un burn qui n'y figure pas : la méthode ne mesure que les faux négatifs **parmi les burns trouvés par scan de blocs**, indépendamment de l'index.

### NON observé (donc non vérifié)
- Aucun burn **Token-2022** ; aucun **BurnChecked** réel (seulement des cas synthétiques) ; aucun burn **multisig/délégué** ; aucun burn dont le **mint** vient d'une table d'adresses (seulement l'indexation des comptes writable ALT, indirectement).
- Comportement sur **Mainnet** et chez **Helius** (rétention, archivage, historique > 1000 signatures, limites de débit).
- **Burns confidentiels Token-2022** (extension confidential mint/burn, montant chiffré) : non décodables par ce parseur. À ne pas supposer absents.
- Un nœud qui élague son historique renvoie un historique incomplet **sans erreur**.

### Conséquences / stratégies
- Le **contrôle indépendant de complétude est la réconciliation par la supply (D8)**, pas l'historique des signatures. Tout écart ⇒ alerte + re-scan ; le moteur ne doit afficher « historique vérifié » que si l'égalité est exacte.
- Si un écart apparaît, alternatives (par ordre de coût) : (a) API « enhanced transactions » Helius filtrée sur le type BURN pour recouper ; (b) scan de blocs/Geyser filtré sur le mint (payant, exhaustif par construction) ; (c) `logsSubscribe` avec `mentions: [mint]` comme accélérateur seulement (non exhaustif).
- Les transactions `err != null` renvoyées par `getSignaturesForAddress` peuvent être écartées sans appeler `getTransaction` (économie d'API).
- **À faire avant tout lancement** : rejouer E1 sur Devnet avec un mint de test créé par nous (burn direct, BurnChecked, Token-2022, mint chargé via table d'adresses) — nécessite du SOL Devnet (le faucet public a refusé les requêtes depuis cet environnement).

---

## Hypothèses ajoutées / mises à jour
- **H3** (volume du mint) : inchangée, à mesurer sur un token réel.
- **H6** : les burns confidentiels Token-2022 sont absents des tokens ciblés (Pump.fun). À vérifier ; détectés de toute façon par D8.
- **H7** : l'API Helius (ou tout RPC choisi) renvoie l'historique complet du mint depuis sa création. À vérifier par D8 sur un token réel avant de déclarer « historique complet ».
- **H8** : le format `json` des réponses v1 peut évoluer (version très récente) ; surveiller l'erreur `-32015`/`malformed` en production.

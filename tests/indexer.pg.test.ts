import { suite } from 'node:test';
import { freshStore, pgSkip } from './pg-harness.ts';
import { indexerSuite } from './indexer-suite.ts';

// Same contract tests as the in-memory store, against a real PostgreSQL.
if (pgSkip) suite(`[postgres] indexer suite (${pgSkip})`, { skip: true }, () => {});
else indexerSuite('postgres', async (projects) => (await freshStore(projects)).store);

import { bulkSuite } from './indexer-bulk.ts';
import { freshStore, pgSkip } from './pg-harness.ts';
import { test } from 'node:test';

if (pgSkip) test('[pg][bulk] skipped', { skip: pgSkip }, () => {});
else bulkSuite('pg', async (projects) => (await freshStore(projects)).store);

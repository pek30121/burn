import { MemoryStore } from '../src/indexer/memory-store.ts';
import { bulkSuite } from './indexer-bulk.ts';

bulkSuite('memory', async (projects) => new MemoryStore(projects));

import { MemoryStore } from '../src/indexer/memory-store.ts';
import { indexerSuite } from './indexer-suite.ts';

indexerSuite('memory', async (projects) => new MemoryStore(projects));

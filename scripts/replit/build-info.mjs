/* Writes web/serve-dist/build-info.json (served as GET /build-info): the commit and branch this build was made from.
 * Plain Node, no dependency. It NEVER fails the build: when git is not available (some build containers) the fields are "unknown". */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const out = process.argv[2] ?? 'web/serve-dist/build-info.json';
const git = (...args) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown'; } catch { return 'unknown'; } };
const info = { commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), builtAt: new Date().toISOString() };
try {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(info) + '\n');
  console.log(`build-info: ${info.commit.slice(0, 12)} on ${info.branch}`);
} catch (e) {
  console.log(`build-info: not written (${e instanceof Error ? e.message : 'error'}); the build continues`);
}

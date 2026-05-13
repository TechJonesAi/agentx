#!/usr/bin/env node
/**
 * Post-build asset copier — tsc only emits .ts→.js, but the migrations
 * module reads `*.sql` files relative to its compiled location via
 * `import.meta.dirname`. Without this step a clean clone fails to boot
 * with ENOENT on the migration files.
 *
 * Surfaces a clear stderr message + non-zero exit when source files are
 * missing, so build failures aren't silent.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const srcDir = path.join(pkgRoot, 'src', 'db', 'migrations');
const dstDir = path.join(pkgRoot, 'dist', 'db', 'migrations');

if (!fs.existsSync(srcDir)) {
  console.error(`[copy-sql-assets] source dir missing: ${srcDir}`);
  process.exit(1);
}
fs.mkdirSync(dstDir, { recursive: true });

const sqlFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.sql'));
if (sqlFiles.length === 0) {
  console.error(`[copy-sql-assets] no .sql files in ${srcDir}`);
  process.exit(1);
}

for (const f of sqlFiles) {
  fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
}
console.log(`[copy-sql-assets] copied ${sqlFiles.length} .sql files → dist/db/migrations/`);

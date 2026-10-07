// Installs the packed tarball into a scratch consumer and checks what a real
// install sees: the `files` list, the `exports` map, and declarations that
// typecheck with skipLibCheck off both Node-only (no DOM lib) and browser-style
// (DOM lib, bundler resolution). Offline: reuses this repo's typescript and
// @types/node instead of installing them.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const dir = await mkdtemp(join(tmpdir(), 'spacemolt-consumer-'));

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed:\n${out}${err}`);
}

try {
  // prepack rebuilds dist, so this never checks a stale build.
  await run(['npm', 'pack', '--pack-destination', dir], ROOT);
  await mkdir(join(dir, 'node_modules/@spacemolt/lib'), { recursive: true });
  await run(['sh', '-c', 'tar -xzf *.tgz -C node_modules/@spacemolt/lib --strip-components=1'], dir);
  await mkdir(join(dir, 'node_modules/@types'), { recursive: true });
  await symlink(join(ROOT, 'node_modules/@types/node'), join(dir, 'node_modules/@types/node'));

  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  // Same source checked by tsc (.ts) and plain node (.mjs, so no TS-stripping flag).
  const consumer = `import { SpacemoltClient } from '@spacemolt/lib';
import { FileCredentialStore } from '@spacemolt/lib/node';
for (const [name, value] of Object.entries({ SpacemoltClient, FileCredentialStore })) {
  if (typeof value !== 'function') throw new Error(\`packed export \${name} is \${typeof value}\`);
}
`;
  await writeFile(join(dir, 'consumer.ts'), consumer);
  await writeFile(join(dir, 'consumer.mjs'), consumer);
  const configs = {
    node: { module: 'nodenext', moduleResolution: 'nodenext', lib: ['es2023'], types: ['node'] },
    browser: { module: 'esnext', moduleResolution: 'bundler', lib: ['es2023', 'dom', 'dom.iterable'], types: [] },
  };
  for (const [name, options] of Object.entries(configs)) {
    const compilerOptions = { ...options, strict: true, target: 'es2023', skipLibCheck: false, noEmit: true };
    await writeFile(join(dir, `tsconfig.${name}.json`), JSON.stringify({ compilerOptions, files: ['consumer.ts'] }));
    await run([join(ROOT, 'node_modules/.bin/tsc'), '-p', `tsconfig.${name}.json`], dir);
  }
  await run(['node', 'consumer.mjs'], dir);
  console.log(
    'consumer check: packed tarball typechecks (Node-only and DOM/bundler, no skipLibCheck) and imports under Node',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

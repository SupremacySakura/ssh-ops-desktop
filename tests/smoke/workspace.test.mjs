import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function commandForPlatform(command, platform = process.platform) {
  return platform === 'win32' ? `${command}.cmd` : command;
}

function json(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const workspaceManifestPaths = [
  'package.json',
  'apps/agent-runtime/package.json',
  'apps/desktop/package.json',
  'packages/config/package.json',
  'packages/contracts/package.json',
];

test('selects the Windows command shim used by Corepack', () => {
  assert.equal(commandForPlatform('pnpm', 'win32'), 'pnpm.cmd');
  assert.equal(commandForPlatform('pnpm', 'darwin'), 'pnpm');
});

test('package managers discover every runnable workspace', () => {
  const pnpm = json(commandForPlatform('pnpm'), [
    '--recursive', 'list', '--depth', '-1', '--json',
  ]);
  const root = pnpm.find(({ path }) => path === process.cwd());
  assert.equal(root?.name, 'ssh-ops-desktop');
  const packageNames = new Set(
    pnpm.filter(({ path }) => path !== process.cwd()).map(({ name }) => name),
  );
  assert.deepEqual(packageNames, new Set([
    '@opspilot/desktop', '@opspilot/agent-runtime',
    '@opspilot/contracts', '@opspilot/config',
  ]));

  const cargo = json('cargo', ['metadata', '--no-deps', '--format-version', '1']);
  assert.ok(cargo.packages.some(({ name }) => name === 'opspilot-domain'));
  const desktop = cargo.packages.find(({ name }) => name === 'opspilot-desktop');
  assert.ok(desktop, 'Cargo workspace must include opspilot-desktop');
  assert.ok(desktop.targets.some(({ kind, name }) => (
    name === 'opspilot_desktop_lib' && kind.some((type) => type.endsWith('lib'))
  )));

  const tauri = readJson('src-tauri/tauri.conf.json');
  assert.equal(tauri.productName, 'OpsPilot');
  assert.equal(tauri.identifier, 'com.opspilot.desktop');
  assert.equal(tauri.build.frontendDist, '../apps/desktop/dist');
  assert.equal(tauri.build.devUrl, 'http://localhost:1420');
});

test('declared verification scripts only reference checked-in entrypoints', () => {
  const rootPackage = readJson('package.json');
  const cargo = json('cargo', ['metadata', '--no-deps', '--format-version', '1']);
  const missing = new Set();

  for (const script of Object.values(rootPackage.scripts)) {
    for (const match of script.matchAll(/\b(?:apps|crates|packages|tests)\/[\w@./-]+/g)) {
      if (!existsSync(match[0])) {
        missing.add(match[0]);
      }
    }

    for (const match of script.matchAll(/cargo test -p ([\w-]+).*?--test ([\w-]+)/g)) {
      const cargoPackage = cargo.packages.find(({ name }) => name === match[1]);
      const testTarget = cargoPackage
        ? resolve(dirname(cargoPackage.manifest_path), 'tests', `${match[2]}.rs`)
        : `unknown Cargo package ${match[1]}`;
      if (!existsSync(testTarget)) {
        missing.add(testTarget);
      }
    }
  }

  assert.deepEqual([...missing], []);
});

test('workspace dependency ranges never use an unbounded latest tag', () => {
  for (const manifestPath of workspaceManifestPaths) {
    const manifest = readJson(manifestPath);
    for (const dependencyGroup of ['dependencies', 'devDependencies']) {
      for (const [name, range] of Object.entries(manifest[dependencyGroup] ?? {})) {
        assert.notEqual(range, 'latest', `${manifestPath}: ${name} must be version-bounded`);
        assert.notEqual(range, '*', `${manifestPath}: ${name} must be version-bounded`);
      }
    }
  }
});

test('workspace lint and typecheck scripts perform real source checks', () => {
  const knownNoOp = /(?:tsc\s+--version|JSON\.parse\()/;

  for (const manifestPath of workspaceManifestPaths.slice(1)) {
    const { scripts = {} } = readJson(manifestPath);
    assert.ok(scripts.lint, `${manifestPath}: lint script is required`);
    assert.ok(scripts.typecheck, `${manifestPath}: typecheck script is required`);
    assert.doesNotMatch(scripts.lint, knownNoOp, `${manifestPath}: lint must inspect sources`);
    assert.doesNotMatch(
      scripts.typecheck,
      knownNoOp,
      `${manifestPath}: typecheck must inspect sources`,
    );
    assert.notEqual(scripts.lint, scripts.typecheck, `${manifestPath}: lint and typecheck differ`);
  }
});

test('the root test command executes the workspace smoke suite', {
  skip: process.env.OPSPILOT_SMOKE_CHILD === '1',
}, () => {
  const childEnv = { ...process.env, OPSPILOT_SMOKE_CHILD: '1' };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(commandForPlatform('pnpm'), ['test'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv,
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /package managers discover every runnable workspace/);
});

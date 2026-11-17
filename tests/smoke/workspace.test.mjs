import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function commandForPlatform(command, args, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }

  return { command, args };
}

function run(command, args, options) {
  const invocation = commandForPlatform(command, args);
  return spawnSync(invocation.command, invocation.args, options);
}

function json(command, args) {
  const result = run(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const workspaceManifestPaths = [
  'package.json',
  'apps/desktop/package.json',
  'packages/config/package.json',
  'packages/contracts/package.json',
];

const removedPaths = [
  'apps/agent-runtime',
  'crates/agent-bridge',
  'crates/audit',
  'crates/task-engine',
  'packages/agent-core',
  'packages/model-providers',
  'src-tauri/resources/agent-runtime',
  'tests/e2e/native',
];

test('builds a shell-backed pnpm invocation on Windows only', () => {
  assert.deepEqual(commandForPlatform('pnpm', ['--version'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'pnpm', '--version'],
  });
  assert.deepEqual(commandForPlatform('pnpm', ['--version'], 'darwin'), {
    command: 'pnpm',
    args: ['--version'],
  });
});

test('provides every required Windows icon resource size', () => {
  const iconPath = 'src-tauri/icons/icon.ico';
  assert.ok(existsSync(iconPath), `${iconPath} must be checked in for Windows builds`);

  const icon = readFileSync(iconPath);
  assert.ok(icon.length >= 6, `${iconPath} must contain an ICO header`);
  assert.equal(icon.readUInt16LE(0), 0, `${iconPath} must use the ICO reserved value`);
  assert.equal(icon.readUInt16LE(2), 1, `${iconPath} must be an ICO image`);

  const imageCount = icon.readUInt16LE(4);
  assert.ok(
    icon.length >= 6 + (imageCount * 16),
    `${iconPath} must contain every declared directory entry`,
  );

  const sizes = [];
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + (index * 16);
    const width = icon[entryOffset] || 256;
    const height = icon[entryOffset + 1] || 256;
    assert.equal(width, height, `${iconPath} layer ${index} must be square`);
    sizes.push(width);
  }

  assert.deepEqual(sizes.toSorted((left, right) => left - right), [16, 24, 32, 48, 64, 256]);
});

test('package managers discover only the Harbor foundation workspaces', () => {
  const pnpm = json('pnpm', [
    '--recursive', 'list', '--depth', '-1', '--json',
  ]);
  const root = pnpm.find(({ path }) => path === process.cwd());
  assert.equal(root?.name, 'ssh-ops-desktop');
  const packageNames = new Set(
    pnpm.filter(({ path }) => path !== process.cwd()).map(({ name }) => name),
  );
  assert.deepEqual(packageNames, new Set([
    '@opspilot/config',
    '@opspilot/contracts',
    '@opspilot/desktop',
  ]));

  const cargo = json('cargo', ['metadata', '--no-deps', '--format-version', '1']);
  const packageNamesCargo = new Set(cargo.packages.map(({ name }) => name));
  assert.deepEqual(packageNamesCargo, new Set([
    'opspilot-desktop',
    'opspilot-domain',
    'opspilot-persistence',
    'opspilot-remote-adapters',
    'opspilot-secrets',
    'opspilot-ssh-core',
  ]));

  const tauri = readJson('src-tauri/tauri.conf.json');
  assert.equal(tauri.productName, 'Harbor');
  assert.equal(tauri.identifier, 'com.harbor.desktop');
  assert.equal(tauri.app.windows[0].title, 'Harbor');
  assert.equal(tauri.app.windows[0].minWidth, 1024);
  assert.equal(tauri.build.frontendDist, '../apps/desktop/dist');
  assert.equal(tauri.build.devUrl, 'http://localhost:1420');
  assert.equal('externalBin' in tauri.bundle, false);
});

test('removed OpsPilot subsystems and native E2E sources are absent', () => {
  for (const path of removedPaths) {
    assert.equal(existsSync(path), false, `${path} must be removed`);
  }
});

test('Harbor commands are registered and authorized exactly once', () => {
  const expectedCommands = [
    'core_health',
    'server_list',
    'server_create',
    'server_update',
    'server_delete',
    'server_credential_set',
    'server_group_list',
    'server_group_create',
    'server_group_update',
    'server_group_delete',
    'connection_connect',
    'connection_trust_host_key',
    'connection_disconnect',
    'terminal_open',
    'terminal_write',
    'terminal_resize',
    'terminal_close',
    'file_list',
    'file_read',
    'file_write',
    'file_download',
    'docker_list',
    'docker_logs',
    'docker_action',
    'docker_exec',
    'monitor_snapshot',
    'ssh_config_import_preview',
    'ssh_config_import_apply',
  ];
  const expectedAllowPermissions = expectedCommands.map(
    (command) => `allow-${command.replaceAll('_', '-')}`,
  );
  const expectedCapabilityPermissions = [
    ...expectedAllowPermissions,
    'core:event:allow-listen',
    'core:event:allow-unlisten',
  ];
  const expectedPermissions = expectedCommands
    .flatMap((command) => [
      `allow-${command.replaceAll('_', '-')}`,
      `deny-${command.replaceAll('_', '-')}`,
    ])
    .toSorted();
  const handlerSource = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const buildSource = readFileSync('src-tauri/build.rs', 'utf8');
  const handlerBlock = handlerSource.match(/generate_handler!\s*\[([\s\S]*?)\]/)?.[1];
  const buildBlock = buildSource.match(/\.commands\(&\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(handlerBlock, 'src-tauri/src/lib.rs must register an invoke handler');
  assert.ok(buildBlock, 'src-tauri/build.rs must declare the app command manifest');

  const handlerCommands = handlerBlock.split(',').map((command) => command.trim()).filter(Boolean);
  const buildCommands = [...buildBlock.matchAll(/"([a-z][a-z0-9_]+)"/g)]
    .map(([, command]) => command);
  assert.deepEqual(handlerCommands, expectedCommands);
  assert.deepEqual(buildCommands, expectedCommands);
  assert.equal(new Set(handlerCommands).size, handlerCommands.length);
  assert.equal(new Set(buildCommands).size, buildCommands.length);

  for (const forbiddenPrefix of [
    'agent_',
    'audit_',
    'model_profile_',
    'nginx_',
    'operation_',
    'project_',
    'task_',
  ]) {
    assert.equal(handlerSource.includes(forbiddenPrefix), false);
    assert.equal(buildSource.includes(forbiddenPrefix), false);
  }

  const mainCapability = readJson('src-tauri/capabilities/main.json');
  assert.deepEqual(mainCapability.permissions, expectedCapabilityPermissions);
  assert.equal(
    new Set(mainCapability.permissions).size,
    mainCapability.permissions.length,
  );
  const generatedCapabilities = readJson('src-tauri/gen/schemas/capabilities.json');
  assert.deepEqual(
    generatedCapabilities.main.permissions,
    expectedCapabilityPermissions,
  );
  assert.equal(
    new Set(generatedCapabilities.main.permissions).size,
    generatedCapabilities.main.permissions.length,
  );
  const appAcl = readJson('src-tauri/gen/schemas/acl-manifests.json')['__app-acl__'];
  assert.deepEqual(Object.keys(appAcl.permissions).toSorted(), expectedPermissions);

  for (const command of expectedCommands) {
    const permission = readFileSync(
      `src-tauri/permissions/autogenerated/${command}.toml`,
      'utf8',
    );
    const identifier = `allow-${command.replaceAll('_', '-')}`;
    assert.match(permission, new RegExp(`identifier = "${identifier}"`));
    assert.match(
      permission,
      new RegExp(`commands\\.allow = \\["${command}"\\]`),
    );
  }
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
  skip: process.env.HARBOR_SMOKE_CHILD === '1',
}, () => {
  const childEnv = { ...process.env, HARBOR_SMOKE_CHILD: '1' };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = run('pnpm', ['test'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv,
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /package managers discover only the Harbor foundation workspaces/);
});

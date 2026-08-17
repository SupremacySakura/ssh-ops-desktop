import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '../..');
const outputDirectory = resolve(workspaceRoot, 'src-tauri/resources/agent-runtime');
const outputFile = resolve(outputDirectory, 'main.mjs');
// esbuild 声明为本包 devDependency；用 node 直接执行其 JS bin，避免依赖 .bin 符号链接，
// 也规避 Windows 下 spawn .cmd 报 EINVAL 的问题（node 跨平台执行 JS 脚本）。
const esbuildBin = resolve(
  dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),
  'bin/esbuild',
);

mkdirSync(outputDirectory, { recursive: true });
execFileSync(process.execPath, [esbuildBin,
  'src/main.ts',
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node24',
  "--banner:js=import{createRequire as __opspilotCreateRequire}from'node:module';const require=__opspilotCreateRequire(import.meta.url);",
  `--outfile=${outputFile}`,
], { cwd: packageRoot, stdio: 'inherit' });
const nativePackage = nativePackageForHost();
const packageRequire = createRequire(import.meta.url);
const mastraPackage = packageRequire.resolve('@mastra/libsql/package.json');
const mastraRequire = createRequire(mastraPackage);
const clientEntry = mastraRequire.resolve('@libsql/client');
const clientRequire = createRequire(clientEntry);
const libsqlEntry = clientRequire.resolve('libsql');
const libsqlRequire = createRequire(libsqlEntry);
const nativeEntry = libsqlRequire.resolve(nativePackage);
const nativeManifest = libsqlRequire.resolve(`${nativePackage}/package.json`);
const nativeOutput = resolve(outputDirectory, 'node_modules', nativePackage);

mkdirSync(nativeOutput, { recursive: true });
copyFileSync(nativeEntry, resolve(nativeOutput, 'index.node'));
copyFileSync(nativeManifest, resolve(nativeOutput, 'package.json'));

const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE || rustHostTriple();
const sidecarDirectory = resolve(workspaceRoot, 'src-tauri/binaries');
const sidecarName = `opspilot-agent-node-${targetTriple}${process.platform === 'win32' ? '.exe' : ''}`;
const sidecarOutput = resolve(sidecarDirectory, sidecarName);
mkdirSync(sidecarDirectory, { recursive: true });
copyFileSync(process.execPath, sidecarOutput);
if (process.platform !== 'win32') chmodSync(sidecarOutput, 0o755);

function nativePackageForHost() {
  const platform = process.platform;
  const architecture = process.arch;
  if (platform === 'darwin' && (architecture === 'arm64' || architecture === 'x64')) {
    return `@libsql/darwin-${architecture}`;
  }
  if (platform === 'win32' && architecture === 'x64') return '@libsql/win32-x64-msvc';
  if (platform === 'linux') {
    const libc = process.report?.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl';
    if (architecture === 'arm64' || architecture === 'x64') {
      return `@libsql/linux-${architecture}-${libc}`;
    }
    if (architecture === 'arm') return `@libsql/linux-arm-${libc}eabihf`;
  }
  throw new Error(`unsupported Agent runtime target: ${platform}-${architecture}`);
}

function rustHostTriple() {
  const details = execFileSync(process.env.RUSTC || 'rustc', ['-vV'], { encoding: 'utf8' });
  const host = details.match(/^host: (.+)$/mu)?.[1];
  if (!host) throw new Error('rustc did not report its host target triple');
  return host;
}

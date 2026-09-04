#!/usr/bin/env node

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLOUD_MOBILE_ROOT = resolve(SCRIPT_DIR, '..');
const REPOSITORY_ROOT = resolve(CLOUD_MOBILE_ROOT, '..', '..');
const RELEASE_KINDS = Object.freeze(['major', 'minor', 'patch']);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const PATHS = Object.freeze({
  hostPackage: resolve(REPOSITORY_ROOT, 'repos/cc-agent-host/package.json'),
  hostLock: resolve(REPOSITORY_ROOT, 'repos/cc-agent-host/package-lock.json'),
  mobilePackage: resolve(CLOUD_MOBILE_ROOT, 'package.json'),
  mobileLock: resolve(CLOUD_MOBILE_ROOT, 'package-lock.json'),
  expoConfig: resolve(CLOUD_MOBILE_ROOT, 'app.json'),
  iosProject: resolve(CLOUD_MOBILE_ROOT, 'ios/Cloud.xcodeproj/project.pbxproj'),
  androidGradle: resolve(CLOUD_MOBILE_ROOT, 'android/app/build.gradle'),
  runtimeStore: resolve(CLOUD_MOBILE_ROOT, 'src/features/runtime/runtimeStore.ts'),
});

function fail(message) {
  throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} 应为 ${expected}，实际为 ${String(actual)}`);
  }
}

function parsePositiveInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${label} 必须是正整数，实际为 ${String(value)}`);
  }
  return parsed;
}

function replaceExpected(source, search, replacement, expectedCount, label) {
  const count = source.split(search).length - 1;
  if (count !== expectedCount) {
    fail(`${label} 预期匹配 ${expectedCount} 处，实际匹配 ${count} 处`);
  }
  return source.replaceAll(search, replacement);
}

export function incrementSemver(version, releaseKind) {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) {
    fail(`仅支持 major.minor.patch 形式的稳定版本，实际为 ${version}`);
  }
  if (!RELEASE_KINDS.includes(releaseKind)) {
    fail(`版本类型必须是 ${RELEASE_KINDS.join('、')} 之一`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (releaseKind === 'major') return `${major + 1}.0.0`;
  if (releaseKind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function createReleasePlan(releaseKind) {
  const [
    hostPackage,
    hostLock,
    mobilePackage,
    mobileLock,
    appConfig,
    iosProject,
    androidGradle,
    runtimeStore,
  ] = await Promise.all([
    readJson(PATHS.hostPackage),
    readJson(PATHS.hostLock),
    readJson(PATHS.mobilePackage),
    readJson(PATHS.mobileLock),
    readJson(PATHS.expoConfig),
    readFile(PATHS.iosProject, 'utf8'),
    readFile(PATHS.androidGradle, 'utf8'),
    readFile(PATHS.runtimeStore, 'utf8'),
  ]);

  const currentVersion = mobilePackage.version;
  if (typeof currentVersion !== 'string' || !SEMVER_PATTERN.test(currentVersion)) {
    fail(`Mobile package version 无效：${String(currentVersion)}`);
  }
  assertEqual(hostPackage.version, currentVersion, 'Host package version');
  assertEqual(hostLock.version, currentVersion, 'Host lockfile version');
  assertEqual(hostLock.packages?.['']?.version, currentVersion, 'Host lockfile root package version');
  assertEqual(mobileLock.version, currentVersion, 'Mobile lockfile version');
  assertEqual(mobileLock.packages?.['']?.version, currentVersion, 'Mobile lockfile root package version');
  assertEqual(appConfig.expo?.version, currentVersion, 'Expo version');

  const iosBuildNumber = parsePositiveInteger(appConfig.expo?.ios?.buildNumber, 'Expo iOS buildNumber');
  const androidVersionCode = parsePositiveInteger(appConfig.expo?.android?.versionCode, 'Expo Android versionCode');
  const nextVersion = incrementSemver(currentVersion, releaseKind);
  const nextIosBuildNumber = iosBuildNumber + 1;
  const nextAndroidVersionCode = androidVersionCode + 1;

  const nextIosProject = replaceExpected(
    replaceExpected(
      iosProject,
      `MARKETING_VERSION = ${currentVersion};`,
      `MARKETING_VERSION = ${nextVersion};`,
      2,
      'iOS MARKETING_VERSION',
    ),
    `CURRENT_PROJECT_VERSION = ${iosBuildNumber};`,
    `CURRENT_PROJECT_VERSION = ${nextIosBuildNumber};`,
    2,
    'iOS CURRENT_PROJECT_VERSION',
  );
  const nextAndroidGradle = replaceExpected(
    replaceExpected(
      androidGradle,
      `versionName "${currentVersion}"`,
      `versionName "${nextVersion}"`,
      1,
      'Android versionName',
    ),
    `versionCode ${androidVersionCode}`,
    `versionCode ${nextAndroidVersionCode}`,
    1,
    'Android versionCode',
  );
  const nextRuntimeStore = replaceExpected(
    runtimeStore,
    `version: '${currentVersion}',`,
    `version: '${nextVersion}',`,
    1,
    'Mobile clientInfo.version',
  );

  hostPackage.version = nextVersion;
  hostLock.version = nextVersion;
  hostLock.packages[''].version = nextVersion;
  mobilePackage.version = nextVersion;
  mobileLock.version = nextVersion;
  mobileLock.packages[''].version = nextVersion;
  appConfig.expo.version = nextVersion;
  appConfig.expo.ios.buildNumber = String(nextIosBuildNumber);
  appConfig.expo.android.versionCode = nextAndroidVersionCode;

  return {
    summary: Object.freeze({
      releaseKind,
      currentVersion,
      nextVersion,
      iosBuildNumber: { current: iosBuildNumber, next: nextIosBuildNumber },
      androidVersionCode: { current: androidVersionCode, next: nextAndroidVersionCode },
    }),
    files: new Map([
      [PATHS.hostPackage, `${JSON.stringify(hostPackage, null, 2)}\n`],
      [PATHS.hostLock, `${JSON.stringify(hostLock, null, 2)}\n`],
      [PATHS.mobilePackage, `${JSON.stringify(mobilePackage, null, 2)}\n`],
      [PATHS.mobileLock, `${JSON.stringify(mobileLock, null, 2)}\n`],
      [PATHS.expoConfig, `${JSON.stringify(appConfig, null, 2)}\n`],
      [PATHS.iosProject, nextIosProject],
      [PATHS.androidGradle, nextAndroidGradle],
      [PATHS.runtimeStore, nextRuntimeStore],
    ]),
  };
}

async function writeReleasePlan(files) {
  const temporaryFiles = [];
  try {
    let index = 0;
    for (const [path, contents] of files) {
      const temporaryPath = `${path}.ccvibe-version-${process.pid}-${index}`;
      index += 1;
      await writeFile(temporaryPath, contents, 'utf8');
      temporaryFiles.push([temporaryPath, path]);
    }
    for (const [temporaryPath, path] of temporaryFiles) {
      await rename(temporaryPath, path);
    }
  } finally {
    await Promise.all(temporaryFiles.map(([temporaryPath]) => rm(temporaryPath, { force: true })));
  }
}

async function main() {
  const releaseKind = process.argv[2];
  const dryRun = process.argv[3] === '--dry-run';
  if (!RELEASE_KINDS.includes(releaseKind) || (process.argv.length > 3 && !dryRun) || process.argv.length > 4) {
    console.error('用法：node scripts/bump-cloud-version.mjs <major|minor|patch> [--dry-run]');
    process.exitCode = 2;
    return;
  }
  const plan = await createReleasePlan(releaseKind);
  if (dryRun) {
    console.log(JSON.stringify(plan.summary));
    return;
  }
  await writeReleasePlan(plan.files);
  console.log(
    `Cloud ${plan.summary.currentVersion} → ${plan.summary.nextVersion}；`
    + `iOS build ${plan.summary.iosBuildNumber.current} → ${plan.summary.iosBuildNumber.next}；`
    + `Android versionCode ${plan.summary.androidVersionCode.current} → ${plan.summary.androidVersionCode.next}`,
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

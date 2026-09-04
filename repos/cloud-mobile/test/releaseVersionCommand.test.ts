import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { incrementSemver } from '../scripts/bump-cloud-version.mjs';

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = resolve(MOBILE_ROOT, 'scripts/bump-cloud-version.mjs');
const PACKAGE_PATH = resolve(MOBILE_ROOT, 'package.json');

describe('release version command', () => {
  it('increments major, minor, and patch versions with SemVer reset rules', () => {
    expect(incrementSemver('1.2.3', 'major')).toBe('2.0.0');
    expect(incrementSemver('1.2.3', 'minor')).toBe('1.3.0');
    expect(incrementSemver('1.2.3', 'patch')).toBe('1.2.4');
    expect(() => incrementSemver('1.2', 'patch')).toThrow(/major\.minor\.patch/);
  });

  it('dry-runs against the synchronized repository without changing files', () => {
    const before = readFileSync(PACKAGE_PATH, 'utf8');
    const currentVersion = (JSON.parse(before) as { version: string }).version;
    const output = execFileSync(process.execPath, [SCRIPT_PATH, 'patch', '--dry-run'], {
      cwd: MOBILE_ROOT,
      encoding: 'utf8',
    });
    const summary = JSON.parse(output) as {
      currentVersion: string;
      nextVersion: string;
      releaseKind: string;
    };

    expect(summary).toMatchObject({
      currentVersion,
      nextVersion: incrementSemver(currentVersion, 'patch'),
      releaseKind: 'patch',
    });
    expect(readFileSync(PACKAGE_PATH, 'utf8')).toBe(before);
  });
});

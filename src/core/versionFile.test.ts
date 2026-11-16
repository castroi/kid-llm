import { describe, expect, it, vi } from 'vitest';
import { deployedCommit } from './update';
import { versionFile } from './versionFile';

const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Runs the plugin's step at the end of a build and returns the files it wrote. */
function build(commit: string) {
  const emitFile = vi.fn();
  const plugin = versionFile(commit);
  const step = plugin.generateBundle as unknown as (this: { emitFile: typeof emitFile }) => void;
  step.call({ emitFile });
  return { plugin, emitted: emitFile.mock.calls.map(([file]) => file as { type: string; fileName: string; source: string }) };
}

describe('versionFile', () => {
  it('runs only when the app is built, not while it is developed', () => {
    expect(versionFile(SHA).apply).toBe('build');
  });

  it('writes version.json with the commit, in the form the app reads back', () => {
    const { emitted } = build(SHA);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'asset', fileName: 'version.json' });
    expect(deployedCommit(JSON.parse(emitted[0]!.source))).toBe(SHA);
  });

  it.each(['', 'dev', SHA.slice(0, 7), SHA.toUpperCase(), `${SHA}\n`])('writes no file for a build that does not know its commit: %j', (commit) => {
    expect(build(commit).emitted).toEqual([]);
  });
});

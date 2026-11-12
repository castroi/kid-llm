import { describe, expect, it } from 'vitest';
import { APP_VERSION, appVersion, REPO_URL } from './version';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('appVersion', () => {
  it('shows the short commit, links to that commit, and keeps its date', () => {
    const version = appVersion(SHA, '2026-11-12T14:05:00+02:00');
    expect(version.label).toBe('0123456');
    expect(version.url).toBe(`https://github.com/castroi/kid-llm/commit/${SHA}`);
    expect(version.date?.toISOString()).toBe('2026-11-12T12:05:00.000Z');
  });

  it('keeps the commit and drops a date it cannot read', () => {
    expect(appVersion(SHA, '')).toEqual({ label: '0123456', url: `${REPO_URL}/commit/${SHA}`, date: null });
    expect(appVersion(SHA, 'yesterday').date).toBeNull();
  });

  it.each(['', 'main', SHA.slice(0, 39), `${SHA}0`, SHA.toUpperCase(), `${SHA.slice(0, 30)}/../../evil`, 'javascript:alert(1)', ` ${SHA}`, `${SHA}\n`])(
    'is "dev", with a link to the repository only, for a commit name that is not 40 hex characters: %j',
    (commit) => {
      expect(appVersion(commit, '2026-11-12T14:05:00+02:00')).toEqual({ label: 'dev', url: REPO_URL, date: null });
    },
  );
});

describe('APP_VERSION', () => {
  it('is this build: a link into the repository and nowhere else', () => {
    expect(APP_VERSION.url).toMatch(/^https:\/\/github\.com\/castroi\/kid-llm(\/commit\/[0-9a-f]{40})?$/);
    expect(APP_VERSION.label).toMatch(/^(dev|[0-9a-f]{7})$/);
  });
});

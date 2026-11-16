import { describe, expect, it, vi } from 'vitest';
import { deployedCommit, fetchDeployedCommit, isCommit, VERSION_FILE } from './update';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('isCommit', () => {
  it('takes a full commit name only', () => {
    expect(isCommit(SHA)).toBe(true);
    for (const value of ['', 'dev', SHA.slice(0, 39), `${SHA}0`, SHA.toUpperCase(), ` ${SHA}`, `${SHA}\n`, 42, null, undefined, {}]) {
      expect(isCommit(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('deployedCommit', () => {
  it('reads the commit a version file names', () => {
    expect(deployedCommit({ commit: SHA })).toBe(SHA);
  });

  it.each([null, undefined, 'x', 42, [], [SHA], {}, { commit: '' }, { commit: 'main' }, { commit: SHA.toUpperCase() }, { commit: 7 }, { version: SHA }])(
    'is null for anything that is not a version file: %j',
    (body) => {
      expect(deployedCommit(body)).toBeNull();
    },
  );
});

describe('fetchDeployedCommit', () => {
  const answering = (response: Response | Error) =>
    vi.fn<typeof fetch>(async () => {
      if (response instanceof Error) throw response;
      return response;
    });

  it('asks its own origin for the version file, past every cache, with no cookies and no redirects', async () => {
    const fetchFn = answering(new Response(JSON.stringify({ commit: SHA })));
    expect(await fetchDeployedCommit(fetchFn)).toBe(SHA);
    expect(fetchFn).toHaveBeenCalledWith(VERSION_FILE, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    expect(VERSION_FILE).toBe('/version.json');
  });

  it('is null when the site has no version file or fails', async () => {
    expect(await fetchDeployedCommit(answering(new Response('missing', { status: 404 })))).toBeNull();
    expect(await fetchDeployedCommit(answering(new Response('oops', { status: 500 })))).toBeNull();
  });

  it('is null when the phone is offline or the request is refused', async () => {
    expect(await fetchDeployedCommit(answering(new TypeError('Failed to fetch')))).toBeNull();
  });

  it('is null for an answer that is not a version file', async () => {
    expect(await fetchDeployedCommit(answering(new Response('<!doctype html><html></html>')))).toBeNull();
    expect(await fetchDeployedCommit(answering(new Response(JSON.stringify({ commit: 'main' }))))).toBeNull();
  });
});

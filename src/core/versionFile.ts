import type { Plugin } from 'vite';
import { isCommit, VERSION_FILE } from './update';

/**
 * The build's side of the update check (vite.config.ts): writes version.json next to the app
 * with the commit this build is, so an app left open on the phone can tell that another one
 * was deployed (src/core/update.ts). Only a full commit name is written; a build that doesn't
 * know its commit writes no file, and its app never asks.
 */
export function versionFile(commit: string): Plugin {
  return {
    name: 'version-file',
    apply: 'build',
    generateBundle() {
      if (!isCommit(commit)) return;
      this.emitFile({ type: 'asset', fileName: VERSION_FILE.slice(1), source: `${JSON.stringify({ commit })}\n` });
    },
  };
}

// Project folder listing for the files panel. Adapted from
// ninehills/claude-agent-ui (MIT), trimmed to what the panel needs.
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { DirectoryTree, TreeNode } from '../shared/protocol.js';

const IGNORE = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.DS_Store', 'tmp', '.idea',
]);

export async function buildTree(
  root: string,
  opts: { maxDepth?: number; maxEntries?: number } = {},
): Promise<DirectoryTree> {
  const maxDepth = opts.maxDepth ?? 6;
  const maxEntries = opts.maxEntries ?? 2500;
  const rootPath = resolve(root);
  let files = 0;
  let dirs = 0;
  let count = 0;
  let truncated = false;

  async function walk(dir: string, rel: string, depth: number): Promise<TreeNode> {
    const node: TreeNode = { name: rel ? basename(rel) : basename(rootPath), path: rel, type: 'dir', children: [] };
    if (depth >= maxDepth || truncated) return node;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return node;
    }
    entries = entries
      .filter((e) => !IGNORE.has(e.name))
      .sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad - bd || a.name.localeCompare(b.name);
      });
    for (const e of entries) {
      if (count >= maxEntries) {
        truncated = true;
        break;
      }
      const childRel = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        dirs++;
        count++;
        node.children!.push(await walk(join(dir, e.name), childRel, depth + 1));
      } else if (e.isFile()) {
        files++;
        count++;
        node.children!.push({ name: e.name, path: childRel, type: 'file' });
      }
    }
    return node;
  }

  const tree = await walk(rootPath, '', 0);
  return { root: rootPath, files, dirs, truncated, tree };
}

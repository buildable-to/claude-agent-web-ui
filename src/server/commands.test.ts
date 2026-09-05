import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installedSkills, toCommandInfo } from './commands.js';

test('installed skills come from <claude dir>/skills, the frontmatter name first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-'));
  await mkdir(join(dir, '.claude/skills/compose'), { recursive: true });
  await writeFile(join(dir, '.claude/skills/compose/SKILL.md'), '---\nname: compose-project\ndescription: x\n---\nbody');
  await mkdir(join(dir, '.claude/skills/edit-drawing'), { recursive: true });
  await writeFile(join(dir, '.claude/skills/edit-drawing/SKILL.md'), 'no frontmatter');
  await mkdir(join(dir, '.claude/skills/not-a-skill'), { recursive: true });
  const names = await installedSkills([join(dir, '.claude'), join(dir, 'missing')]);
  assert.deepEqual([...names].sort(), ['compose-project', 'edit-drawing']);
});

test('the composer offers only the installed skills when told so', () => {
  const all = [
    { name: 'usage', description: 'Show usage', argumentHint: '' },
    { name: 'compose-project', description: 'Compose', argumentHint: '' },
    { name: 'compact', description: '', argumentHint: '' },
  ];
  assert.deepEqual(
    toCommandInfo(all).map((c) => c.name),
    ['compact', 'compose-project', 'usage'],
  );
  assert.deepEqual(
    toCommandInfo(all, [], new Set(['compose-project'])).map((c) => c.name),
    ['compose-project'],
  );
});

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteSkillFile,
  discoverSkills,
  formatSkillCatalogForPrompt,
  readSkillDetail,
  readSkillResource,
  saveSkillFile,
} from '../../electron/tools/agents-skills';
import { BUILTIN_SKILLS } from '../../electron/tools/builtin-skills';

const cleanDirs: string[] = [];

afterEach(() => {
  while (cleanDirs.length > 0) {
    const d = cleanDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('Expanded Skills discovery, authoring, and SmolCode repo skills', () => {
  it('discovers built-in skills and SmolCode repository skills with tags and precedence', () => {
    const smolRoot = resolve(__dirname, '../..');
    const skills = discoverSkills(smolRoot);
    const names = skills.map((s) => s.name);

    // Built-in universal starters (including grill-me)
    expect(BUILTIN_SKILLS.some((s) => s.name === 'grill-me')).toBe(true);
    for (const bi of BUILTIN_SKILLS) {
      expect(names).toContain(bi.name);
    }

    const grill = readSkillDetail(skills, 'grill-me');
    expect(grill.found).toBe(true);
    expect(grill.output).toContain('request_user_input');
    expect(grill.output).toContain('(Recommended)');

    // SmolCode workspace skills
    expect(names).toEqual(
      expect.arrayContaining([
        'smolcode-architecture',
        'smolcode-agent-tools',
        'smolcode-ui-tokens',
        'smolcode-testing',
      ]),
    );

    const arch = skills.find((s) => s.name === 'smolcode-architecture');
    expect(arch?.scope).toBe('repo');
    expect(arch?.tags).toContain('ipc');

    const catalog = formatSkillCatalogForPrompt(skills, 1600);
    expect(catalog).toContain('smolcode-architecture [repo]');
    expect(catalog).toContain('skill-creator [builtin]');
  });

  it('saves, updates, reads companion files safely, overrides builtin, and deletes repo skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-skills-'));
    cleanDirs.push(dir);

    const saved = saveSkillFile({
      projectRoot: dir,
      scope: 'repo',
      name: 'API Error Rules',
      description: 'Standardize API error envelopes across endpoints',
      content: '## Rules\nReturn `{ error, code }`.',
      tags: ['api', 'errors'],
      companionFiles: [
        { path: 'references/codes.md', content: '# Error Codes\n- E_AUTH\n' },
        { path: '../escape.txt', content: 'should be ignored' },
      ],
    });

    expect(saved.name).toBe('api-error-rules');
    expect(saved.scope).toBe('repo');
    expect(saved.sourcePath).toContain(join('.smolcode', 'skills', 'api-error-rules', 'SKILL.md'));
    expect(saved.companionFiles).toEqual(['references/codes.md']);
    expect(existsSync(join(dir, '.smolcode', 'skills', 'escape.txt'))).toBe(false);

    // Override a built-in skill in repo scope
    saveSkillFile({
      projectRoot: dir,
      scope: 'repo',
      name: 'bug-triage',
      description: 'Repo-specific bug triage',
      content: 'Custom triage steps.',
    });

    const discovered = discoverSkills(dir);
    const overridden = discovered.find((s) => s.name === 'bug-triage');
    expect(overridden?.scope).toBe('repo');
    expect(overridden?.content).toBe('Custom triage steps.');

    // Progressive disclosure via readSkillDetail & readSkillResource
    const detail = readSkillDetail(discovered, 'api-error-rules');
    expect(detail.found).toBe(true);
    expect(detail.output).toContain('Companion files');
    expect(detail.output).toContain('references/codes.md');

    const refOut = readSkillDetail(discovered, 'api-error-rules', 'references/codes.md');
    expect(refOut.output).toContain('E_AUTH');

    // Path traversal blocked
    expect(() => readSkillResource(saved.sourcePath, '../../package.json')).toThrow();
    expect(() => deleteSkillFile('builtin://skill-creator/SKILL.md', dir)).toThrow(/Built-in/i);

    // Delete repo skill cleanly
    deleteSkillFile(saved.sourcePath, dir);
    expect(existsSync(saved.sourcePath)).toBe(false);

    // Legacy .agents/skills still discovered cleanly
    mkdirSync(join(dir, '.agents', 'skills', 'legacy-one'), { recursive: true });
    writeFileSync(
      join(dir, '.agents', 'skills', 'legacy-one', 'SKILL.md'),
      '---\nname: legacy-one\ndescription: Legacy\n---\nBody\n',
      'utf8',
    );
    expect(discoverSkills(dir).some((s) => s.name === 'legacy-one')).toBe(true);
  });
});

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SkillEntry } from '../../src/shared/types';
import { BUILTIN_SKILLS } from './builtin-skills';

const COMPANION_SUBDIRS = ['references', 'scripts', 'examples', 'resources'];

export function compactAgentsInstructions(raw: string, maxChars = 2400): string {
  const cleaned = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n')
    .trim();

  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}\n...[AGENTS.md truncated for context budget]`;
}

export function loadWorkspaceAgentsPrompt(projectRoot: string): string {
  const candidates = [
    join(homedir(), '.smolcode', 'AGENTS.md'),
    join(homedir(), '.codex', 'AGENTS.md'),
    join(projectRoot, 'AGENTS.md'),
    join(projectRoot, 'AGENTS.override.md'),
  ];

  const sections: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const content = readFileSync(candidate, 'utf8').trim();
      if (content) {
        sections.push(compactAgentsInstructions(content, 1600));
      }
    } catch {
      // Ignore unreadable AGENTS files
    }
  }
  return sections.join('\n\n');
}

function parseSkillFrontmatter(raw: string, fallbackName: string): {
  name: string;
  description: string;
  tags: string[];
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { name: fallbackName, description: '', tags: [], body: raw.trim() };
  }
  const frontmatter = match[1];
  const body = match[2].trim();
  const nameMatch = frontmatter.match(/^name:\s*["']?(.+?)["']?$/m);
  const descMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?$/m);
  const tagsMatch = frontmatter.match(/^tags:\s*(.+)$/m);
  const tags = tagsMatch
    ? tagsMatch[1]
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    : [];

  return {
    name: nameMatch ? nameMatch[1].trim() : fallbackName,
    description: descMatch ? descMatch[1].trim() : '',
    tags,
    body,
  };
}

function discoverCompanionFiles(skillDir: string): string[] {
  const found: string[] = [];
  for (const sub of COMPANION_SUBDIRS) {
    const subAbs = join(skillDir, sub);
    if (!existsSync(subAbs)) continue;
    const walk = (dir: string) => {
      if (found.length >= 30) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= 30) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          found.push(relative(skillDir, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(subAbs);
  }
  return found.sort();
}

export function getSkillSearchDirs(
  projectRoot?: string,
): Array<{ dir: string; scope: 'repo' | 'global' }> {
  const dirs: Array<{ dir: string; scope: 'repo' | 'global' }> = [];
  // Highest precedence first: repo -> global -> builtin
  if (projectRoot) {
    dirs.push(
      { dir: join(projectRoot, '.smolcode', 'skills'), scope: 'repo' },
      { dir: join(projectRoot, '.agents', 'skills'), scope: 'repo' },
      { dir: join(projectRoot, '.codex', 'skills'), scope: 'repo' },
    );
  }
  dirs.push(
    { dir: join(homedir(), '.smolcode', 'skills'), scope: 'global' },
    { dir: join(homedir(), '.codex', 'skills'), scope: 'global' },
  );
  return dirs;
}

export function discoverSkills(projectRoot?: string): SkillEntry[] {
  const searchDirs = getSkillSearchDirs(projectRoot);
  const seen = new Set<string>();
  const skills: SkillEntry[] = [];

  for (const { dir, scope } of searchDirs) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      try {
        const raw = readFileSync(skillFile, 'utf8');
        const parsed = parseSkillFrontmatter(raw, entry.name);
        if (seen.has(parsed.name)) continue;
        seen.add(parsed.name);
        const companionFiles = discoverCompanionFiles(skillDir);
        skills.push({
          id: createHash('sha1').update(skillFile).digest('hex').slice(0, 12),
          name: parsed.name,
          description: parsed.description,
          sourcePath: skillFile,
          scope,
          content: parsed.body,
          ...(parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
          ...(companionFiles.length > 0 ? { companionFiles } : {}),
        });
      } catch {
        // Ignore broken skill markdown
      }
    }
  }

  for (const builtin of BUILTIN_SKILLS) {
    if (seen.has(builtin.name)) continue;
    seen.add(builtin.name);
    skills.push({ ...builtin });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeSkillSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'custom-skill'
  );
}

export function saveSkillFile(input: {
  projectRoot?: string;
  scope: 'repo' | 'global';
  name: string;
  description: string;
  content: string;
  tags?: string[];
  companionFiles?: Array<{ path: string; content: string }>;
}): SkillEntry {
  const slug = normalizeSkillSlug(input.name);
  if (input.scope === 'repo' && !input.projectRoot) {
    throw new Error('Cannot save a workspace skill without an active project root.');
  }
  const baseDir =
    input.scope === 'repo' && input.projectRoot
      ? join(input.projectRoot, '.smolcode', 'skills', slug)
      : join(homedir(), '.smolcode', 'skills', slug);

  mkdirSync(baseDir, { recursive: true });
  const skillFile = join(baseDir, 'SKILL.md');
  const cleanTags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const tagLine = cleanTags.length > 0 ? `\ntags: [${cleanTags.join(', ')}]` : '';
  const cleanDesc = input.description.trim() || 'Custom workspace skill';
  const cleanBody = input.content.trim();
  const md = `---\nname: ${slug}\ndescription: ${cleanDesc}${tagLine}\n---\n\n${cleanBody}\n`;
  writeFileSync(skillFile, md, 'utf8');

  if (input.companionFiles && input.companionFiles.length > 0) {
    const absBase = resolve(baseDir);
    for (const cf of input.companionFiles.slice(0, 12)) {
      const rel = cf.path.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || isAbsolute(rel)) continue;
      const target = resolve(absBase, rel);
      const back = relative(absBase, target).replace(/\\/g, '/');
      if (back === '..' || back.startsWith('../') || isAbsolute(back)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, cf.content, 'utf8');
    }
  }

  const companionFiles = discoverCompanionFiles(baseDir);
  return {
    id: createHash('sha1').update(skillFile).digest('hex').slice(0, 12),
    name: slug,
    description: cleanDesc,
    sourcePath: skillFile,
    scope: input.scope,
    content: cleanBody,
    ...(cleanTags.length > 0 ? { tags: cleanTags } : {}),
    ...(companionFiles.length > 0 ? { companionFiles } : {}),
  };
}

export function createSkillFile(input: {
  projectRoot?: string;
  scope: 'repo' | 'global';
  name: string;
  description: string;
  content: string;
  tags?: string[];
  companionFiles?: Array<{ path: string; content: string }>;
}): SkillEntry {
  return saveSkillFile(input);
}

export function deleteSkillFile(sourcePath: string, projectRoot?: string): void {
  if (!sourcePath || sourcePath.startsWith('builtin://')) {
    throw new Error('Built-in skills cannot be deleted. Override them in Workspace or Global scope instead.');
  }
  const absSource = resolve(sourcePath);
  const allowedRoots = getSkillSearchDirs(projectRoot).map((d) => resolve(d.dir));
  const isAllowed = allowedRoots.some((root) => {
    const rel = relative(root, absSource).replace(/\\/g, '/');
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) && rel.endsWith('/SKILL.md');
  });
  if (!isAllowed) {
    throw new Error(`Refusing to delete skill outside managed skill directories: ${sourcePath}`);
  }
  const skillDir = dirname(absSource);
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true });
  }
}

export function readSkillResource(sourcePath: string, relFile: string): string {
  if (!sourcePath || sourcePath.startsWith('builtin://')) {
    throw new Error('Built-in skills have no external companion files on disk.');
  }
  const skillDir = resolve(dirname(sourcePath));
  const cleaned = relFile.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || isAbsolute(cleaned)) {
    throw new Error(`Invalid skill resource path: ${relFile}`);
  }
  const target = resolve(skillDir, cleaned);
  const rel = relative(skillDir, target).replace(/\\/g, '/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !existsSync(target)) {
    throw new Error(`Skill resource not found: ${relFile}`);
  }
  const st = statSync(target);
  if (!st.isFile() || st.size > 256 * 1024) {
    throw new Error(`Skill resource unreadable or too large: ${relFile}`);
  }
  return readFileSync(target, 'utf8');
}

export function readSkillDetail(
  skills: SkillEntry[],
  name: string,
  referencePath?: string,
): { found: boolean; skill?: SkillEntry; output: string } {
  const q = name.trim().replace(/^\/+/, '').toLowerCase();
  const matched =
    skills.find((s) => s.name.toLowerCase() === q) ??
    skills.find((s) => normalizeSkillSlug(s.name) === normalizeSkillSlug(q));

  if (!matched) {
    const available = skills.map((s) => s.name).join(', ') || 'none';
    return {
      found: false,
      output: `Skill "${name}" not found. Available skills: ${available}`,
    };
  }

  if (referencePath?.trim()) {
    const content = readSkillResource(matched.sourcePath, referencePath);
    return {
      found: true,
      skill: matched,
      output: `Skill "${matched.name}" resource (${referencePath}):\n\n${content}`,
    };
  }

  const parts = [
    `# Skill: /${matched.name} [${matched.scope}]`,
    matched.description ? `Description: ${matched.description}` : '',
    matched.tags && matched.tags.length > 0 ? `Tags: ${matched.tags.join(', ')}` : '',
    matched.companionFiles && matched.companionFiles.length > 0
      ? `Companion files (call read_skill with referencePath to load): ${matched.companionFiles.join(', ')}`
      : '',
    '',
    matched.content,
  ].filter((line) => line !== '');

  return {
    found: true,
    skill: matched,
    output: parts.join('\n'),
  };
}

export function formatSkillCatalogForPrompt(
  skills: SkillEntry[],
  maxChars = 1600,
): string {
  if (skills.length === 0) return '';
  const lines: string[] = [];
  let len = 0;

  for (const sk of skills) {
    const desc = (sk.description || 'Workspace instructions').replace(/\s+/g, ' ').slice(0, 140);
    const line = `- ${sk.name} [${sk.scope}]: ${desc}`;
    if (len + line.length + 1 > maxChars && lines.length >= 4) {
      lines.push(`... (+${skills.length - lines.length} more skills)`);
      break;
    }
    lines.push(line);
    len += line.length + 1;
  }

  return lines.join('\n');
}

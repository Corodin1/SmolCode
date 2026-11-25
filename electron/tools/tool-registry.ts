import type { InteractionMode, McpServerConfig } from '../../src/shared/types';
import type { OllamaToolDef } from '../ollama/client';

export const CORE_READ_ONLY_TOOLS: OllamaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List directory tree entries inside the workspace up to maxDepth (default 2).',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string' },
          maxDepth: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files by glob or filename pattern across code, config, and asset files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          pathPrefix: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_search',
      description: 'Search indexed code/text files and symbols by pattern. Returns file:line:hash| hits.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          pathPrefix: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_symbol',
      description: 'Read AST symbol body with line:hash| anchors.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          symbolName: { type: 'string' },
        },
        required: ['filePath', 'symbolName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_range',
      description: 'Read bounded line slice (max 180 lines) with line:hash| anchors.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
        },
        required: ['filePath', 'startLine', 'endLine'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description:
        'Load full SKILL.md instructions (or a companion reference/script file) for a skill listed in Available Skills.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          referencePath: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
];

export const WEB_LOOKUP_TOOL: OllamaToolDef = {
  type: 'function',
  function: {
    name: 'web_lookup',
    description: 'Look up external documentation, library APIs, or web pages via Obscura (pass url or query).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        query: { type: 'string' },
      },
    },
  },
};

export const READ_ONLY_TOOLS: OllamaToolDef[] = [
  ...CORE_READ_ONLY_TOOLS,
  WEB_LOOKUP_TOOL,
];

export const READ_ONLY_TOOL_NAMES = new Set(
  READ_ONLY_TOOLS.map((t) => t.function.name),
);

export const MUTATING_TOOLS: OllamaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'patch_hashline',
      description:
        'Apply one or more line:hash anchored edits (replace_range, insert_after, delete_range) to a file; auto-checks syntax.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['replace_range', 'insert_after', 'delete_range'],
                },
                startAnchor: { type: 'string' },
                endAnchor: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['op', 'startAnchor'],
            },
          },
        },
        required: ['filePath', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Replace short unique oldText with newText in a file (indent-tolerant); auto-checks syntax.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['filePath', 'oldText', 'newText'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create new file and check syntax.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file inside the active workspace.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move or rename a file inside the active workspace.',
      parameters: {
        type: 'object',
        properties: {
          fromPath: { type: 'string' },
          toPath: { type: 'string' },
          overwrite: { type: 'boolean' },
        },
        required: ['fromPath', 'toPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run shell command in workspace; returns digested output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_skill',
      description:
        'Create or update a reusable SKILL.md (and optional companionFiles under references/ or scripts/) in .smolcode/skills (repo) or ~/.smolcode/skills (global).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          content: { type: 'string' },
          scope: { type: 'string', enum: ['repo', 'global'] },
          tags: { type: 'array', items: { type: 'string' } },
          companionFiles: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        },
        required: ['name', 'description', 'content'],
      },
    },
  },
];

export const PLANNING_TOOLS: OllamaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'request_user_input',
      description:
        'Ask the user 1-3 clarifying questions (single question or structured questions[] round) with 2-4 concise options and optional multiSelect before finalizing a plan or making ambiguous design choices.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
          },
          allowCustom: { type: 'boolean' },
          multiSelect: { type: 'boolean' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                question: { type: 'string' },
                multiSelect: { type: 'boolean' },
                allowCustom: { type: 'boolean' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['label'],
                  },
                },
              },
              required: ['question', 'options'],
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_plan',
      description:
        'Publish a structured step-by-step implementation plan for user review and approval.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          steps: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['title', 'summary', 'steps'],
      },
    },
  },
];

export const UPDATE_PLAN_STEP_TOOL: OllamaToolDef = {
  type: 'function',
  function: {
    name: 'update_plan_step',
    description:
      'Update progress status (pending, in_progress, done) of a step in the active approved plan.',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done'],
        },
      },
      required: ['stepId', 'status'],
    },
  },
};

export const FINISH_TOOL: OllamaToolDef = {
  type: 'function',
  function: {
    name: 'finish_turn',
    description: 'Complete turn with concise summary once verified.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        needsUserInput: { type: 'boolean' },
      },
      required: ['summary'],
    },
  },
};

export const AGENT_TOOLS: OllamaToolDef[] = [
  ...READ_ONLY_TOOLS,
  ...MUTATING_TOOLS,
  ...PLANNING_TOOLS,
  UPDATE_PLAN_STEP_TOOL,
  FINISH_TOOL,
];

export function buildToolListForThread(
  interactionMode: InteractionMode,
  mcpServers: McpServerConfig[] = [],
  options?: { webLookupEnabled?: boolean; hasActivePlan?: boolean },
): OllamaToolDef[] {
  const readOnly =
    options?.webLookupEnabled === false ? CORE_READ_ONLY_TOOLS : READ_ONLY_TOOLS;

  const base =
    interactionMode === 'plan'
      ? [...readOnly, ...PLANNING_TOOLS, FINISH_TOOL]
      : [
          ...readOnly,
          ...MUTATING_TOOLS,
          ...PLANNING_TOOLS,
          ...(options?.hasActivePlan ? [UPDATE_PLAN_STEP_TOOL] : []),
          FINISH_TOOL,
        ];

  const mcpTools: OllamaToolDef[] = [];
  for (const srv of mcpServers) {
    if (!srv.enabled || !srv.tools?.length) continue;
    for (const t of srv.tools) {
      const safeSrv = srv.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeTool = t.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      mcpTools.push({
        type: 'function',
        function: {
          name: `mcp__${safeSrv}__${safeTool}`,
          description: `[MCP ${srv.name}] ${t.description || t.name}`,
          parameters: t.inputSchema ?? {
            type: 'object',
            properties: {},
          },
        },
      });
    }
  }
  return [...base, ...mcpTools];
}

export const FAST_SCOUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          symbolName: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
        },
        required: ['filePath'],
      },
    },
    searchQueries: {
      type: 'array',
      items: { type: 'string' },
    },
    directAnswerPossible: { type: 'boolean' },
  },
  required: ['targets', 'searchQueries', 'directAnswerPossible'],
};

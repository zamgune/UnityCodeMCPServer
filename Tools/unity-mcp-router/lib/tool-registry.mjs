import { createHash } from 'node:crypto';

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function schemaFingerprint(tool) {
  const stable = JSON.stringify(sortValue({
    name: tool?.name,
    inputSchema: tool?.inputSchema ?? null,
    outputSchema: tool?.outputSchema ?? null,
  }));
  return createHash('sha256').update(stable).digest('hex');
}

export function toolListFingerprint(tools) {
  const rows = [...tools]
    // Notification equality covers the complete public Tool object. Routing
    // compatibility remains schema-only through schemaFingerprint below.
    .map((tool) => JSON.stringify(sortValue(tool)))
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

export function decorateTools(tools, { projectNames, defaultProject }) {
  return tools.map((tool) => {
    const schema = tool.inputSchema ? structuredClone(tool.inputSchema) : { type: 'object', properties: {} };
    if (schema.type !== 'object') return { ...tool };
    schema.properties = schema.properties ?? {};
    if (!schema.properties.project) {
      schema.properties.project = {
        type: 'string',
        ...(projectNames.length ? { enum: projectNames } : {}),
        description: `Which Unity project to target. Defaults to "${defaultProject}".`,
      };
    }
    if (schema.additionalProperties === false) delete schema.additionalProperties;
    return { ...tool, inputSchema: schema };
  });
}

export class ToolRegistry {
  constructor() {
    this.byProject = new Map();
    this.invalidatedProjects = new Set();
  }

  update(projectId, tools) {
    const previous = this.byProject.get(projectId);
    const fingerprint = toolListFingerprint(tools);
    const changed = previous != null && previous.fingerprint !== fingerprint;
    const becameAvailable = (previous?.tools?.length ?? 0) === 0 && tools.length > 0;
    const entry = {
      tools: structuredClone(tools),
      fingerprint,
      byName: new Map(tools.map((tool) => [tool.name, { tool, fingerprint: schemaFingerprint(tool) }])),
      updatedAt: Date.now(),
    };
    this.byProject.set(projectId, entry);
    // Clear invalidation only after fingerprinting, cloning, and committing
    // the replacement entry all succeeded.
    const wasInvalidated = this.invalidatedProjects.delete(projectId);
    return { changed, becameAvailable, fingerprint, wasInvalidated };
  }

  invalidate(projectId) {
    const newlyInvalidated = !this.invalidatedProjects.has(projectId);
    this.invalidatedProjects.add(projectId);
    return { newlyInvalidated };
  }

  get(projectId) {
    if (this.invalidatedProjects.has(projectId)) return null;
    return this.byProject.get(projectId) ?? null;
  }

  hasKnownNonEmptyCatalog(projectId) {
    return (this.byProject.get(projectId)?.tools.length ?? 0) > 0;
  }

  compatible(sourceProjectId, targetProjectId, toolName) {
    if (this.invalidatedProjects.has(sourceProjectId) || this.invalidatedProjects.has(targetProjectId)) {
      return false;
    }
    const source = this.byProject.get(sourceProjectId)?.byName.get(toolName);
    const target = this.byProject.get(targetProjectId)?.byName.get(toolName);
    return Boolean(source && target && source.fingerprint === target.fingerprint);
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getPersonalAccessTokenHandler, WebApi } from 'azure-devops-node-api';
import { z } from 'zod';
import { DomainsManager } from './upstream/shared/domains.js';
import { configureAllTools } from './upstream/tools.js';

const serverUrl = normalizeServerUrl(process.env.ADO_SERVER_URL);
const pat =
  process.env.ADO_PAT || process.env.ADO_MCP_AUTH_TOKEN || process.env.PERSONAL_ACCESS_TOKEN;
const apiVersion = process.env.ADO_API_VERSION || '7.0';
const domainsInput = parseDomainsInput(process.env.ADO_DOMAINS);
const defaultTop = 50;
const maxTop = 200;
const serverVersion = '0.3.0';

if (!serverUrl) {
  throw new Error('Missing ADO_SERVER_URL environment variable.');
}

if (!pat) {
  throw new Error(
    'Missing ADO_PAT (or ADO_MCP_AUTH_TOKEN/PERSONAL_ACCESS_TOKEN) environment variable.',
  );
}

const mcp = new McpServer({
  name: 'ado-server-2022-onprem',
  version: serverVersion,
});

const connectionProvider = async () => {
  const authHandler = getPersonalAccessTokenHandler(pat);
  return new WebApi(serverUrl, authHandler, undefined, {
    productName: 'AzureDevOps.MCP.OnPrem',
    productVersion: serverVersion,
    userAgent: userAgentProvider(),
  });
};

const tokenProvider = async () => pat;

const enabledDomains = new DomainsManager(domainsInput).getEnabledDomains();

// Upstream tools may use Bearer auth headers for token-based cloud auth.
// For on-prem PAT mode, rewrite those to Basic consistently.
installBearerToBasicFetchInterceptor(pat);

configureAllTools(mcp, tokenProvider, connectionProvider, userAgentProvider, enabledDomains);

mcp.registerTool(
  'list_projects',
  {
    title: 'List Projects',
    description: 'List projects from Azure DevOps Server collection.',
    inputSchema: z.object({
      top: z.number().int().min(1).max(maxTop).optional(),
    }),
  },
  async ({ top = defaultTop }) => {
    const boundedTop = clampTop(top);
    const url = buildApiUrl('_apis/projects', {
      'api-version': apiVersion,
      $top: String(boundedTop),
    });

    const data = await adoFetchJson(url);
    const projects = (data.value || []).map((p) => ({
      id: p.id,
      name: p.name,
      state: p.state,
      visibility: p.visibility,
      url: p.url,
    }));

    return asJson({ count: projects.length, projects });
  },
);

mcp.registerTool(
  'tfvc_list_changesets',
  {
    title: 'List Changesets',
    description:
      'List TFVC changesets from Azure DevOps Server with optional filtering by path or author.',
    inputSchema: z.object({
      itemPath: z.string().min(1).optional(),
      author: z.string().min(1).optional(),
      fromId: z.number().int().min(1).optional(),
      toId: z.number().int().min(1).optional(),
      top: z.number().int().min(1).max(maxTop).optional(),
    }),
  },
  async ({ itemPath, author, fromId, toId, top = defaultTop }) => {
    const boundedTop = clampTop(top);
    const url = buildApiUrl('_apis/tfvc/changesets', {
      'api-version': apiVersion,
      $top: String(boundedTop),
      'searchCriteria.itemPath': itemPath,
      'searchCriteria.author': author,
      'searchCriteria.fromId': fromId,
      'searchCriteria.toId': toId,
    });

    const data = await adoFetchJson(url);
    const changesets = (data.value || []).map(minimalChangeset);
    return asJson({ count: changesets.length, changesets });
  },
);

mcp.registerTool(
  'tfvc_get_changeset',
  {
    title: 'Get Changeset',
    description:
      'Get details for a TFVC changeset, including linked work items and optional changed items.',
    inputSchema: z.object({
      id: z.number().int().min(1),
      includeChanges: z.boolean().optional(),
      top: z.number().int().min(1).max(maxTop).optional(),
      skip: z.number().int().min(0).optional(),
    }),
  },
  async ({ id, includeChanges = true, top = 100, skip = 0 }) => {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('id must be a positive integer.');
    }

    const boundedTop = clampTop(top);
    const url = buildApiUrl(`_apis/tfvc/changesets/${id}`, {
      'api-version': apiVersion,
      includeDetails: 'true',
      includeWorkItems: 'true',
      maxChangeCount: String(boundedTop),
    });

    const changeset = await adoFetchJson(url);
    let changes = [];

    if (includeChanges) {
      const changesUrl = buildApiUrl(`_apis/tfvc/changesets/${id}/changes`, {
        'api-version': apiVersion,
        $top: String(boundedTop),
        $skip: String(Math.max(0, Number(skip) || 0)),
      });

      const changesResult = await adoFetchJson(changesUrl);
      changes = (changesResult.value || []).map(minimalTfvcChange);
    }

    return asJson({
      ...minimalChangeset(changeset),
      changes,
      workItems: normalizeAssociatedWorkItems(changeset.workItems || []),
      checkinNotes: changeset.checkinNotes || [],
      policyOverride: changeset.policyOverride || null,
    });
  },
);

function userAgentProvider() {
  return `ado-server-mcp-onprem/${serverVersion}`;
}

function minimalChangeset(changeset) {
  return {
    id: changeset.changesetId ?? changeset.id,
    url: changeset.url,
    comment: changeset.comment || null,
    createdDate: changeset.createdDate || null,
    author: normalizeIdentity(changeset.author),
    checkedInBy: normalizeIdentity(changeset.checkedInBy),
    owner: normalizeIdentity(changeset.owner),
  };
}

function minimalTfvcChange(change) {
  return {
    changeType: change.changeType || null,
    item: normalizeTfvcItem(change.item),
    mergeSources: change.mergeSources || [],
  };
}

function normalizeAssociatedWorkItems(workItems) {
  return workItems.map((workItem) => ({
    id: workItem.id,
    url: workItem.url,
    title: workItem.title || null,
  }));
}

function normalizeIdentity(identity) {
  if (!identity) {
    return null;
  }

  if (typeof identity === 'string') {
    return identity;
  }

  return {
    displayName: identity.displayName || null,
    uniqueName: identity.uniqueName || null,
    id: identity.id || null,
  };
}

function normalizeTfvcItem(item) {
  if (!item) {
    return null;
  }

  return {
    path: item.path || item.serverItem || null,
    isFolder: item.isFolder ?? false,
    url: item.url || null,
    version: item.version || null,
    deletionId: item.deletionId || 0,
  };
}

function clampTop(value) {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) {
    return defaultTop;
  }
  return Math.max(1, Math.min(maxTop, Math.floor(asNumber)));
}

function normalizeServerUrl(raw) {
  if (!raw) {
    return '';
  }
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function parseDomainsInput(value) {
  if (!value || !value.trim()) {
    return 'all';
  }

  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function installBearerToBasicFetchInterceptor(rawPat) {
  const basicHeaderValue = `Basic ${Buffer.from(`:${rawPat}`).toString('base64')}`;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    const authHeader = headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      headers.set('Authorization', basicHeaderValue);
    }

    return originalFetch(input, {
      ...init,
      headers,
    });
  };
}

function buildApiUrl(path, query = {}) {
  const cleanPath = path.replace(/^\//, '');
  const url = new URL(cleanPath, serverUrl);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && String(v).length > 0) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

function authHeader() {
  const token = Buffer.from(`:${pat}`).toString('base64');
  return `Basic ${token}`;
}

async function adoFetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: authHeader(),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    let details = '';
    try {
      details = await response.text();
    } catch {
      details = '';
    }

    const summary = [
      `Azure DevOps request failed: ${response.status} ${response.statusText}`,
      details ? `Details: ${truncate(details, 800)}` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    throw new Error(summary);
  }

  return response.json();
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function asJson(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

const transport = new StdioServerTransport();
await mcp.connect(transport);

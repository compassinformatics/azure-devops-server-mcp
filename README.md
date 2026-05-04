# Azure DevOps Server MCP (On-Prem)

MCP server for Azure DevOps Server on-prem collections. Implements the full upstream toolset from [microsoft/azure-devops-mcp](https://github.com/microsoft/azure-devops-mcp) with on-prem patches (auth, identity, and search endpoints routed through the collection URL instead of Azure cloud hosts).

Available tool domains: `core`, `work`, `work-items`, `repositories`, `pipelines`, `wiki`, `search`, `test-plans`, `advanced-security`.

Additional local tools for TFVC:

- `list_projects` — list projects in the collection
- `list_changesets` — list TFVC changesets with optional path/author/range filters
- `get_changeset` — get full changeset details including work items and changed items

## Requirements

- Node.js 20+
- Personal Access Token (PAT) for your Azure DevOps Server instance

## Configuration

Set these environment variables before running:

- ADO_SERVER_URL: Azure DevOps Server collection URL, for example https://tfs.compass.ie/tfs/DefaultCollection/
- ADO_PAT: PAT with required permissions for the operations you want (or ADO_MCP_AUTH_TOKEN / PERSONAL_ACCESS_TOKEN)
- ADO_API_VERSION (optional): defaults to 7.0
- ADO_DOMAINS (optional): comma-separated domains to load, defaults to all

Example:

```
ADO_SERVER_URL=https://tfs.compass.ie/tfs/DefaultCollection/
ADO_PAT=<your_pat>
ADO_DOMAINS=core,work,work-items,repositories,pipelines,wiki,search,test-plans,advanced-security
```

## Run

1. Install dependencies:
   npm install
2. Start server:
   npm start

## Example prompts

- List my open work items for project LAWPRO
- Get work item 47091
- Search for code containing "ApplicationService"
- List recent changesets
- List changesets for item path $/LAWPRO/Main
- List changesets by author pavel
- Get changeset 12345
- List repositories in project LAWPRO
- List recent pipeline runs

## Notes

- This server uses PAT auth for on-prem compatibility.
- Search and identity APIs are routed through your on-prem collection URL instead of cloud-only hosts.
- Some upstream tools depend on features/services that may not be installed in a given on-prem deployment; those tools will return API errors from the server if unavailable.
- TFVC changeset support remains available via the legacy tools and is read-only.

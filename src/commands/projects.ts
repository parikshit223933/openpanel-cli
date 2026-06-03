import type { Command } from 'commander';
import { requireAuth } from '../guards.js';
import { trpcQuery } from '../trpc.js';
import { render, table } from '../output.js';

interface Organization {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
  organizationId?: string;
}

/** Fetch all organizations and their projects for the current user. */
export async function listOrgsAndProjects(): Promise<
  Array<{ organization: Organization; projects: Project[] }>
> {
  const orgs = await trpcQuery<Organization[]>('organization.list');
  const result: Array<{ organization: Organization; projects: Project[] }> = [];
  for (const org of orgs ?? []) {
    const projects = await trpcQuery<Project[]>('project.list', {
      organizationId: org.id,
    });
    result.push({ organization: org, projects: projects ?? [] });
  }
  return result;
}

export function registerProjectCommands(program: Command): void {
  const projects = program
    .command('projects')
    .description('List organizations and projects (to find your project IDs)');

  projects
    .command('list', { isDefault: true })
    .description('List all organizations and their projects')
    .action(async () => {
      requireAuth();
      const data = await listOrgsAndProjects();
      render(data, () => {
        const rows = data.flatMap(({ organization, projects: ps }) =>
          ps.length === 0
            ? [{ organization: organization.name, project: '(no projects)', projectId: '' }]
            : ps.map((p) => ({
                organization: organization.name,
                project: p.name,
                projectId: p.id,
              })),
        );
        table(rows, ['organization', 'project', 'projectId']);
      });
    });
}

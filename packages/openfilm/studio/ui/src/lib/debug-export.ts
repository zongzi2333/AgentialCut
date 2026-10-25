/**
 * The project's debugging record as one JSON file.
 *
 * Studio already keeps the browser conversations, the model calls and the HTTP log in separate places. A programmer
 * looking at a failed agent turn needs them together, with the run plan and the project identity. Everything here is
 * read-only and already visible to Studio; this only joins it into a downloadable snapshot.
 */
import { api, type AgentChatMessage, type Project } from '@/api';

type Failure = { source: string; error: string };

const messageKey = (messages: AgentChatMessage[]) => JSON.stringify(messages);

async function read<T>(source: string, run: () => Promise<T>, failures: Failure[]): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    failures.push({ source, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

function fileName(name: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `openfilm-debug-${name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60) || 'project'}-${stamp}.json`;
}

/** Download everything a programmer needs to read one project's agent work. */
export async function exportProjectDebug(project: Pick<Project, 'id' | 'name'>): Promise<void> {
  const failures: Failure[] = [];
  const [storyboardMessages, editMessages, audioMessages, modelLogs, apiLogs, run, agents, problems] = await Promise.all([
    read('agent-chat:storyboard', () => api.agentChatHistory(project.id, 'storyboard'), failures),
    read('agent-chat:edit', () => api.agentChatHistory(project.id, 'edit'), failures),
    read('agent-chat:audio', () => api.agentChatHistory(project.id, 'audio'), failures),
    read('model-logs', () => api.modelLogs(2000), failures),
    read('api-logs', () => api.apiLogs(2000), failures),
    read('roughcut-run', () => api.storyboardRun(project.id), failures),
    read('agent-cards', () => api.agentCards(), failures),
    read('diagnostics/problems', () => api.problems(), failures),
  ]);

  /* Older servers answer an unknown scope with the storyboard list. Keep one copy instead of inventing a second one. */
  const chats: Record<string, unknown> = {
    storyboard: storyboardMessages ?? [],
    edit: editMessages ?? [],
  };
  if (audioMessages && messageKey(audioMessages) !== messageKey(storyboardMessages ?? [])) chats.audio = audioMessages;
  else chats.audio = { messages: [], note: 'audio scope is not available yet, or shares the storyboard history' };

  const bundle = {
    format: 'openfilm-debug',
    version: 1,
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name },
    studio: {
      href: typeof location === 'undefined' ? '' : location.href,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    },
    chats,
    modelLogs: modelLogs ?? [],
    apiLogs: apiLogs ?? [],
    roughcutRun: run ?? null,
    agentCards: agents ?? null,
    problems: problems ?? [],
    failures,
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName(project.name);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

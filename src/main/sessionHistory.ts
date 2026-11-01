import type { HistoryContent, HistorySnapshot, HistoryToken } from '../shared/history';
import type { Workspace } from '../shared/types';
import { editorPath, hostPath } from '../shared/wsl';
import type { SessionClient } from './sessionClient';
import type { SessionInteraction } from './sessionInteraction';

export class SessionHistory {
  constructor(
    private readonly workspace: Workspace,
    private readonly client: SessionClient,
    private readonly interaction: SessionInteraction,
    private readonly isStopped: () => boolean
  ) {}

  async historySnapshots(tokens: HistoryToken[]): Promise<HistorySnapshot[]> {
    if (this.isStopped() || this.workspace.kind === 'terminal') {
      return [];
    }
    const mode = (await this.client.request('nvim_get_mode', [])) as { blocking: boolean };
    if (mode.blocking) {
      return [];
    }
    const result = (await this.client.request('nvim_exec_lua', [
      "return require('nido_history').changed(...)",
      [tokens]
    ])) as HistorySnapshot[];
    return Array.isArray(result)
      ? result.map((value) => ({
          ...value,
          path: hostPath(this.workspace.root, value.path)
        }))
      : [];
  }

  historyCurrent(): Promise<HistorySnapshot> {
    return this.interaction.enqueue(async () => {
      const mode = (await this.client.request('nvim_get_mode', [])) as { blocking: boolean };
      if (mode.blocking) {
        throw new Error('Finish the current Neovim command before opening Time Machine.');
      }
      return this.historyResult("return require('nido_history').current()", []);
    });
  }

  historyDiff(before: string, after: string): Promise<string> {
    return this.client.request('nvim_exec_lua', [
      "return require('nido_history').diff(...)",
      [before, after]
    ]);
  }

  historyRestore(path: string, token: string, content: HistoryContent): Promise<HistorySnapshot> {
    return this.interaction.enqueue(async () => {
      const mode = (await this.client.request('nvim_get_mode', [])) as { blocking: boolean };
      if (mode.blocking) {
        throw new Error('Finish the current Neovim command before restoring.');
      }
      return this.historyResult("return require('nido_history').restore(...)", [
        editorPath(this.workspace.root, path),
        token,
        content
      ]);
    });
  }

  private async historyResult(code: string, args: unknown[]): Promise<HistorySnapshot> {
    const result = (await this.client.request('nvim_exec_lua', [code, args])) as
      HistorySnapshot | { error: string };
    if ('error' in result) {
      throw new Error(result.error);
    }
    return { ...result, path: hostPath(this.workspace.root, result.path) };
  }
}

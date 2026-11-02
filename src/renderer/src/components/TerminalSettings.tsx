import { useEffect, useState } from 'react';
import type { TerminalShell } from '../../../shared/types';
import type { EditorSettings } from '../hooks/useEditorSettings';
import { useI18n } from '../i18n';

const shellLabels: Record<TerminalShell, string> = {
  auto: 'Auto (installed shell)',
  pwsh: 'PowerShell 7 (pwsh)',
  'powershell.exe': 'Windows PowerShell',
  'cmd.exe': 'Command Prompt (cmd)',
  'wsl.exe': 'WSL'
};

export default function TerminalSettings({
  terminalShell,
  setTerminalShell
}: Pick<EditorSettings, 'terminalShell' | 'setTerminalShell'>): React.JSX.Element {
  const t = useI18n();
  const [installedShells, setInstalledShells] = useState<TerminalShell[]>();
  const [shellError, setShellError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.nido
      .availableTerminalShells()
      .then((shells) => {
        if (!cancelled) {
          setInstalledShells(shells);
          setTerminalShell((current) => (shells.includes(current) ? current : 'auto'));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setShellError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setTerminalShell]);
  const shellChoices: TerminalShell[] = installedShells ?? ['auto'];

  return (
    <section aria-labelledby="settings-terminal">
      <h3 id="settings-terminal">{t('Terminal')}</h3>
      <label>
        {t('Shell')}
        <select
          value={installedShells?.includes(terminalShell) ? terminalShell : 'auto'}
          disabled={!installedShells}
          aria-busy={!installedShells && !shellError}
          aria-describedby="settings-shell-status"
          onChange={(event) => setTerminalShell(event.target.value as TerminalShell)}
        >
          {shellChoices.map((shell) => (
            <option key={shell} value={shell}>
              {t(shellLabels[shell])}
            </option>
          ))}
        </select>
      </label>
      <small id="settings-shell-status" role="status">
        {shellError
          ? t('Could not check installed shells.')
          : !installedShells
            ? t('Checking installed shells…')
            : t('Only installed shells are shown.')}
      </small>
      <small>{t('Applies to new terminals and Restart Shell. The selection is saved.')}</small>
    </section>
  );
}

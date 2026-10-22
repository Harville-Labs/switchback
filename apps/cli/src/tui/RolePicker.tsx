/** The picker `/current`, `/model`, or `/ladder` opens: a role's model, or the whole ladder. */
import { type ChosenRole, modelChoices } from '@switchback/client';
import type { ModelSummary, SessionRoles } from '@switchback/protocol';
import { LadderEditor } from './LadderEditor.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { pickModel, runSlashCommand, type SlashContext, setLadder } from './slash.ts';

export function RolePicker({
  role,
  models,
  roles,
  slash,
  onClose,
}: {
  role: ChosenRole;
  models: ModelSummary[];
  roles: SessionRoles | undefined;
  slash: SlashContext;
  onClose: () => void;
}) {
  const choices = modelChoices(models, roles, role);
  const onCommand = (text: string) => void runSlashCommand(slash, text);
  return role === 'escalate' ? (
    <LadderEditor
      choices={choices}
      ladder={roles?.escalate ?? []}
      onCancel={onClose}
      onCommand={onCommand}
      onApply={(ladder, save) => void setLadder(slash, ladder, save)}
    />
  ) : (
    <ModelPicker
      role={role}
      choices={choices}
      onCancel={onClose}
      onCommand={onCommand}
      onPick={(alias) => void pickModel(slash, roles, role, alias)}
    />
  );
}

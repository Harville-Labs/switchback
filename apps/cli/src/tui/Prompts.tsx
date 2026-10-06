/** Questions the engine asks: permission, plan approval, and escalation. */
import { estimateLabel, type PendingEscalation, type PendingPermission } from '@switchback/client';
import type { PermissionDecision } from '@switchback/protocol';
import { Box, Text } from 'ink';
import { DiffView, Keys } from './Chrome.tsx';
import { renderMarkdown } from './markdown.ts';

export interface PermissionAnswer {
  decision: PermissionDecision;
  save?: 'project';
}

/** The answer a key gives to a permission prompt, or undefined if the key means nothing here. */
export function permissionKey(
  p: PendingPermission,
  ch: string,
  escaped: boolean,
): PermissionAnswer | undefined {
  if (ch === 'y') return { decision: 'allow_once' };
  if (ch === 'n' || escaped) return { decision: 'deny' };
  if (ch === 'a' && (p.rules || p.plan)) return { decision: 'allow_always' };
  if (ch === 'p' && p.rules) return { decision: 'allow_always', save: 'project' };
  return undefined;
}

export function PermissionPrompt({
  permission: p,
  maxLines,
  width,
}: {
  permission: PendingPermission;
  maxLines: number;
  width: number;
}) {
  if (p.plan) return <PlanPrompt plan={p.plan} maxLines={maxLines} width={width} />;
  const always = p.rules?.join(', ');
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text>
        Allow <Text bold>{p.summary}</Text>?
      </Text>
      {p.askRule ? <Text dimColor>The rule {p.askRule} asks every time.</Text> : null}
      {p.preview ? <DiffView diff={p.preview} maxLines={maxLines} /> : null}
      <Keys
        keys={[
          ['y', 'once'],
          ...(always
            ? ([
                ['a', `always this session (${always})`],
                ['p', 'always in this project'],
              ] as [string, string][])
            : []),
          ['n', 'deny'],
        ]}
      />
    </Box>
  );
}

function PlanPrompt({ plan, maxLines, width }: { plan: string; maxLines: number; width: number }) {
  const lines = renderMarkdown(plan, width - 4).split('\n');
  const shown = lines.slice(0, maxLines);
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">
        Plan
      </Text>
      <Text>{shown.join('\n')}</Text>
      {lines.length > shown.length ? (
        <Text dimColor>… {lines.length - shown.length} more lines</Text>
      ) : null}
      <Keys
        keys={[
          ['y', 'approve'],
          ['a', 'approve and accept edits'],
          ['n', 'keep planning'],
        ]}
      />
    </Box>
  );
}

export function EscalationPrompt({ escalation }: { escalation: PendingEscalation }) {
  return (
    <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
      <Text>
        Escalate to <Text bold>{escalation.target.model}</Text>
        {escalation.estimatedCostUsd !== undefined ? (
          <Text color="yellow"> ({estimateLabel(escalation.estimatedCostUsd)})</Text>
        ) : null}
        ? {escalation.reason}
      </Text>
      <Keys
        keys={[
          ['y', 'escalate'],
          ['n', 'stay on the current model'],
        ]}
      />
    </Box>
  );
}

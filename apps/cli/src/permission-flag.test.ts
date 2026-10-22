import { expect, test } from 'bun:test';
import { permissionFlag } from './permission-flag.ts';

test('--permission-mode takes the levels and the old mode names', () => {
  expect(permissionFlag('auto')).toEqual({ permissionLevel: 'auto' });
  expect(permissionFlag('autoApprove')).toEqual({ permissionLevel: 'auto' });
  expect(permissionFlag('bypassPermissions')).toEqual({ permissionLevel: 'bypass' });
  expect(permissionFlag('default')).toEqual({ permissionLevel: 'ask' });
  expect(permissionFlag(undefined)).toEqual({});
});

test('plan starts the plan agent, and acceptEdits asks with a warning', () => {
  expect(permissionFlag('plan')).toEqual({ agent: 'plan' });
  const accept = permissionFlag('acceptEdits');
  expect(accept.permissionLevel).toBe('ask');
  expect(accept.warning).toContain('permissions.edit');
});

test('anything else names the accepted values', () => {
  expect(() => permissionFlag('yolo')).toThrow('must be ask, auto, or bypass');
});

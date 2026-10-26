import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizeToolCall,
  buildPolicy,
  filterConnectedSessionsResult,
} from './policy.mjs';

const tools = [
  {
    name: 'sessions-list',
    description: 'List sessions',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'chats-get-messages',
    description: 'Read messages',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'server-environment',
    description: 'Read environment',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'keys-list',
    description: 'Read keys',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'sessions-delete',
    description: 'Delete a session',
    annotations: { readOnlyHint: false },
  },
  {
    name: 'send-text',
    description: 'Send text',
    annotations: { readOnlyHint: false },
  },
];

test('exposes safe reads and the restricted send tools only', () => {
  const policy = buildPolicy(tools, 'indexs');
  assert.deepEqual(
    policy.exposedTools.map((tool) => tool.name),
    ['sessions-list', 'chats-get-messages', 'send-text'],
  );
  assert.match(policy.exposedTools[2].description, /indexs/);
});

test('allows reads across all working sessions', () => {
  const policy = buildPolicy(tools, 'indexs');
  const workingSessions = new Set(['default', 'indexs']);
  assert.equal(
    authorizeToolCall(
      'chats-get-messages',
      { session: 'default' },
      policy,
      workingSessions,
      'indexs',
    ).allowed,
    true,
  );
  assert.equal(
    authorizeToolCall(
      'chats-get-messages',
      { session: 'stopped' },
      policy,
      workingSessions,
      'indexs',
    ).allowed,
    false,
  );
});

test('restricts sends to the configured session', () => {
  const policy = buildPolicy(tools, 'indexs');
  const workingSessions = new Set(['default', 'indexs']);
  assert.equal(
    authorizeToolCall(
      'send-text',
      { session: 'indexs' },
      policy,
      workingSessions,
      'indexs',
    ).allowed,
    true,
  );
  assert.equal(
    authorizeToolCall(
      'send-text',
      { session: 'default' },
      policy,
      workingSessions,
      'indexs',
    ).allowed,
    false,
  );
});

test('filters the sessions-list response to connected sessions', () => {
  const payload = {
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { name: 'default', status: 'WORKING' },
            { name: 'offline', status: 'STOPPED' },
          ]),
        },
      ],
    },
  };
  filterConnectedSessionsResult(payload);
  assert.deepEqual(JSON.parse(payload.result.content[0].text), [
    { name: 'default', status: 'WORKING' },
  ]);
});


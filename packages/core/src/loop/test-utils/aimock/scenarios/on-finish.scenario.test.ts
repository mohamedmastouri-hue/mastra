import { stepCountIs } from '@internal/ai-sdk-v5';
import { it, expect } from 'vitest';
import { z } from 'zod/v4';
import { MockMemory } from '../../../../memory';
import type { MastraOnFinishCallbackArgs } from '../../../../stream/types';
import { createTool } from '../../../../tools';
import { createSharedAgent, runLoopScenario, useLoopScenarioAimock, describeForAllEngines } from '../aimock-scenario';

/**
 * Regression class: onFinish callback.
 *
 * The onFinish callback fires when execution completes. This pins the callback
 * invocation path, ensuring final result observability works correctly.
 */
describeForAllEngines(
  'AIMock loop scenario: onFinish callback',
  engine => {
    const getMock = useLoopScenarioAimock();

    it('onFinish fires when execution completes', async () => {
      const tickTool = createTool({
        id: 'tick',
        description: 'Advance a counter.',
        inputSchema: z.object({}),
        outputSchema: z.object({ count: z.number() }),
        execute: async () => ({ count: 1 }),
      });

      let finishCalled = false;
      let finishResult: any;

      await runLoopScenario({
        engine,
        llm: getMock(),
        prompt: 'Call tool then finish.',
        tools: { tick: tickTool },
        stopWhen: stepCountIs(3),
        onFinish: (result: any) => {
          finishCalled = true;
          finishResult = result;
        },
        fixtures: llm => {
          llm.on(
            { endpoint: 'chat', hasToolResult: false },
            { toolCalls: [{ id: 'call_tick', name: 'tick', arguments: {} }] },
          );
          llm.on({ endpoint: 'chat', hasToolResult: true }, { content: 'Done.' });
        },
      });

      expect(finishCalled).toBe(true);
      expect(finishResult.text).toBe('Done.');
      expect(finishResult.finishReason).toBe('stop');
      expect(finishResult.steps).toHaveLength(2);
    });

    it('onFinish receives text and steps', async () => {
      let resultText: string | undefined;
      let resultSteps: any[] | undefined;

      await runLoopScenario({
        engine,
        llm: getMock(),
        prompt: 'Simple test.',
        stopWhen: stepCountIs(1),
        onFinish: (result: any) => {
          resultText = result.text;
          resultSteps = result.steps;
        },
        fixtures: llm => {
          llm.on({ endpoint: 'chat' }, { content: 'Test response.' });
        },
      });

      expect(resultText).toBe('Test response.');
      expect(resultSteps).toHaveLength(1);
      expect(resultSteps![0].text).toBe('Test response.');
    });

    it('onFinish exposes tool calls and results as chunks at run and step level (#27428)', async () => {
      const tickTool = createTool({
        id: 'tick',
        description: 'Advance a counter.',
        inputSchema: z.object({}),
        outputSchema: z.object({ count: z.number() }),
        execute: async () => ({ count: 1 }),
      });

      const finishes: MastraOnFinishCallbackArgs[] = [];

      await runLoopScenario({
        engine,
        llm: getMock(),
        prompt: 'Call tool.',
        tools: { tick: tickTool },
        stopWhen: stepCountIs(3),
        onFinish: result => {
          finishes.push(result);
        },
        fixtures: llm => {
          llm.on(
            { endpoint: 'chat', hasToolResult: false },
            { toolCalls: [{ id: 'call_tick', name: 'tick', arguments: {} }] },
          );
          llm.on({ endpoint: 'chat', hasToolResult: true }, { content: 'Done.' });
        },
      });

      expect(finishes).toHaveLength(1);
      const finish = finishes[0];
      const toolCall = {
        type: 'tool-call',
        from: 'AGENT',
        payload: { toolCallId: 'call_tick', toolName: 'tick', args: {} },
      };
      const toolResult = {
        type: 'tool-result',
        from: 'AGENT',
        payload: { toolCallId: 'call_tick', toolName: 'tick', result: { count: 1 } },
      };
      expect(finish?.toolCalls).toMatchObject([toolCall]);
      expect(finish?.toolResults).toMatchObject([toolResult]);
      expect(finish?.steps[0]?.toolCalls).toMatchObject([toolCall]);
      expect(finish?.steps[0]?.toolResults).toMatchObject([toolResult]);
    });
  },
  {},
);

describeForAllEngines(
  'AIMock loop scenario: onFinish after resuming a tool',
  engine => {
    const getMock = useLoopScenarioAimock();

    it.each([
      { mode: 'separate steps', firstResult: 'success' },
      { mode: 'same step', firstResult: 'success' },
      { mode: 'separate steps', firstResult: 'error' },
      { mode: 'same step', firstResult: 'error' },
    ])(
      'keeps completed tool results across suspension ($mode, first result: $firstResult, #27428)',
      async ({ mode, firstResult }) => {
        const tick = createTool({
          id: 'tick',
          description: 'Advance a counter, confirming the second increment.',
          inputSchema: z.object({ count: z.number() }),
          outputSchema: z.object({ count: z.number() }),
          suspendSchema: z.object({}),
          resumeSchema: z.object({ confirmed: z.boolean() }),
          execute: async ({ count }, context) => {
            if (count === 1 && firstResult === 'error') {
              throw new Error('The first increment failed.');
            }
            if (count === 2 && !context?.agent?.resumeData?.confirmed) {
              return context?.agent?.suspend({});
            }
            return { count };
          },
        });
        const memory = new MockMemory();
        const shared = await createSharedAgent(getMock(), { tools: { tick }, memory, engine });
        const { output } = await runLoopScenario({
          engine,
          llm: getMock(),
          sharedAgent: shared,
          prompt: 'Increment the counter twice.',
          memory,
          threadId: 'on-finish-resume',
          resourceId: 'on-finish-user',
          stopWhen: stepCountIs(5),
          fixtures: llm => {
            const calls = [1, 2].map(count => ({ id: `tick-${count}`, name: 'tick', arguments: { count } }));
            if (mode === 'same step') {
              llm.on({ endpoint: 'chat', sequenceIndex: 0 }, { toolCalls: calls });
            } else {
              llm.on({ endpoint: 'chat', sequenceIndex: 0 }, { toolCalls: [calls[0]!] });
              llm.on({ endpoint: 'chat', sequenceIndex: 1 }, { toolCalls: [calls[1]!] });
            }
            llm.on({ endpoint: 'chat', sequenceIndex: mode === 'same step' ? 1 : 2 }, { content: 'Counted to two.' });
          },
        });

        const finishes: MastraOnFinishCallbackArgs[] = [];
        const resumed = await shared.agent.resumeStream(
          { confirmed: true },
          {
            runId: output.runId,
            onFinish: result => {
              finishes.push(result);
            },
          },
        );
        await resumed.consumeStream();

        expect(finishes).toHaveLength(1);
        const finish = finishes[0];
        expect(finish?.text).toBe('Counted to two.');
        const expectedResults = (firstResult === 'error' ? [2] : [1, 2]).map(count => ({
          type: 'tool-result',
          runId: output.runId,
          from: 'AGENT',
          payload: { toolCallId: `tick-${count}`, toolName: 'tick', result: { count } },
        }));
        expect(finish?.toolResults).toMatchObject(expectedResults);
        expect(finish?.steps.flatMap(step => step.toolResults)).toMatchObject(expectedResults);
        const expectedCalls = [1, 2].map(count => ({
          type: 'tool-call',
          runId: output.runId,
          from: 'AGENT',
          payload: { toolCallId: `tick-${count}`, toolName: 'tick', args: { count } },
        }));
        expect(finish?.toolCalls).toMatchObject(expectedCalls);
        expect(finish?.steps.flatMap(step => step.toolCalls)).toMatchObject(expectedCalls);
      },
    );
  },
  { skip: ['fs'] },
);

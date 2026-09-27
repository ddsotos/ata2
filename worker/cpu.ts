import prompts from '../data/jev_prompts.json' with { type: 'json' };

export type JevBinding = { run(model: string, input: unknown): Promise<unknown> };
export type CpuPrompts = { answer: string; dealer: string };
export type CpuDecision = { index: number; source: 'jev' | 'random'; reason?: string };
export const defaultCpuPrompts: CpuPrompts = { answer: prompts.answer, dealer: prompts.dealer };

export function typeSafeJevBinding(apiKey: string): JevBinding {
  return {
    async run(_model, input) {
      const response = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(input as Record<string, unknown>), model: 'jev-latest' }),
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
      return response.json();
    },
  };
}

export function createCpuJevInput(theme: string, candidates: string[], role: 'answer' | 'dealer', instructions = defaultCpuPrompts[role]) {
  return {
    state: { theme, choices: candidates },
    questions: {
      choice: {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(candidates.map((name, index) => [`choice_${index}`, name])),
      },
    },
  };
}

function randomChoice(count: number): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % count;
}

export async function chooseCpuCardDetailed(
  ai: JevBinding | undefined,
  theme: string,
  candidates: string[],
  role: 'answer' | 'dealer',
  instructions = defaultCpuPrompts[role],
): Promise<CpuDecision> {
  if (!candidates.length) throw new Error('CPUに選べるカードがありません');
  if (candidates.length === 1) return { index: 0, source: 'random', reason: '候補が1枚' };
  let reason = 'Jevの回答が候補外';
  try {
    if (!ai) throw new Error('Jev binding unavailable');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = ai.run('typesafe/jev', createCpuJevInput(theme, candidates, role, instructions));
    const response = await Promise.race([
      request,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Jev timed out')), 4000); }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); }) as { answers?: { choice?: { choice?: unknown } } };
    const choice = response.answers?.choice?.choice;
    const index = typeof choice === 'string' && /^choice_\d+$/.test(choice) ? Number(choice.slice(7)) : -1;
    if (index >= 0 && index < candidates.length) {
      console.info('CPU Jev choice accepted', { role, choice });
      return { index, source: 'jev' };
    }
    console.warn('CPU Jev returned an invalid choice', { role, choice });
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    console.warn('CPU Jev unavailable; using random choice', { role, reason });
    // The table keeps moving during local play or a temporary AI outage.
  }
  return { index: randomChoice(candidates.length), source: 'random', reason };
}

export async function chooseCpuCard(
  ai: JevBinding | undefined,
  theme: string,
  candidates: string[],
  role: 'answer' | 'dealer',
  instructions = defaultCpuPrompts[role],
): Promise<number> {
  return (await chooseCpuCardDetailed(ai, theme, candidates, role, instructions)).index;
}

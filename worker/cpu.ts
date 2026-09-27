import prompts from '../data/jev_prompts.json' with { type: 'json' };

export type JevBinding = { run(model: string, input: unknown): Promise<unknown> };

export function createCpuJevInput(theme: string, candidates: string[], role: 'answer' | 'dealer') {
  return {
    state: { theme, cards: candidates },
    questions: {
      card: {
        type: 'choice',
        instructions: prompts[role],
        criteria: Object.fromEntries(candidates.map((name, index) => [`card_${index}`, name])),
      },
    },
  };
}

function randomChoice(count: number): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % count;
}

export async function chooseCpuCard(
  ai: JevBinding | undefined,
  theme: string,
  candidates: string[],
  role: 'answer' | 'dealer',
): Promise<number> {
  if (!candidates.length) throw new Error('CPUに選べるカードがありません');
  if (candidates.length === 1) return 0;
  try {
    if (!ai) throw new Error('Jev binding unavailable');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = ai.run('typesafe/jev', createCpuJevInput(theme, candidates, role));
    const response = await Promise.race([
      request,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Jev timed out')), 4000); }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); }) as { answers?: { card?: { choice?: unknown } } };
    const choice = response.answers?.card?.choice;
    const index = typeof choice === 'string' && /^card_\d+$/.test(choice) ? Number(choice.slice(5)) : -1;
    if (index >= 0 && index < candidates.length) {
      console.info('CPU Jev choice accepted', { role, choice });
      return index;
    }
    console.warn('CPU Jev returned an invalid choice', { role, choice });
  } catch (error) {
    console.warn('CPU Jev unavailable; using random choice', { role, reason: error instanceof Error ? error.message : String(error) });
    // The table keeps moving during local play or a temporary AI outage.
  }
  return randomChoice(candidates.length);
}

export function parseRoomId(value: string): string | null {
  const input = value.trim();
  if (/^[a-f0-9]{12}$/i.test(input)) return input.toLowerCase();

  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.pathname.match(/^\/r\/([a-f0-9]{12})\/?$/i)?.[1].toLowerCase() ?? null;
  } catch {
    return null;
  }
}

const WORD_CHAR_CLASS = '[\\p{L}\\p{N}_]';

const isWordChar = (() => {
  const re = new RegExp(WORD_CHAR_CLASS, 'u');
  return (char: string | undefined): boolean => !!char && re.test(char);
})();

export function keywordsCheck(text: string, keywords: string[]): boolean {
  const sanitized = keywords
    .map((k) => k.replace(/[.,!?;:]+$/, ''))
    .filter((k) => k.length > 0);

  if (sanitized.length === 0) return false;

  const patterns = sanitized.map((k) => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chars = Array.from(k);
    const left = isWordChar(chars[0]) ? `(?<!${WORD_CHAR_CLASS})` : '';
    const right = isWordChar(chars[chars.length - 1]) ? `(?!${WORD_CHAR_CLASS})` : '';
    return `${left}${escaped}${right}`;
  });

  return new RegExp(`(?:${patterns.join('|')})`, 'giu').test(text);
}

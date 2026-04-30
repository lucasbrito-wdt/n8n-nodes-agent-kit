type Threshold = 'strict' | 'balanced' | 'permissive';

const COMMON_KEY_PREFIXES = [
  'key-', 'sk-', 'sk_', 'pk_', 'pk-', 'ghp_', 'AKIA', 'xox',
  'SG.', 'hf_', 'api-', 'apikey-', 'token-', 'secret-', 'SHA:', 'Bearer ',
];

const CONFIGS: Record<Threshold, { min_length: number; min_entropy: number; min_diversity: number; strict_mode: boolean }> = {
  strict:     { min_length: 10, min_entropy: 3.0, min_diversity: 2, strict_mode: true },
  balanced:   { min_length: 10, min_entropy: 3.8, min_diversity: 3, strict_mode: false },
  permissive: { min_length: 30, min_entropy: 4.0, min_diversity: 2, strict_mode: false },
};

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts: Record<string, number> = {};
  for (const c of s) counts[c] = (counts[c] || 0) + 1;
  return Object.values(counts).reduce((e, n) => {
    const p = n / s.length;
    return e - p * Math.log2(p);
  }, 0);
}

function charDiversity(s: string): number {
  return [
    /[a-z]/.test(s),
    /[A-Z]/.test(s),
    /\d/.test(s),
    /[^\w]/.test(s),
  ].filter(Boolean).length;
}

function isSecretCandidate(token: string, cfg: (typeof CONFIGS)[Threshold]): boolean {
  if (token.length < cfg.min_length) return false;
  if (COMMON_KEY_PREFIXES.some((p) => token.startsWith(p))) return true;
  if (charDiversity(token) < cfg.min_diversity) return false;
  return shannonEntropy(token) >= cfg.min_entropy;
}

export function secretKeysCheck(text: string, threshold: Threshold): boolean {
  const cfg = CONFIGS[threshold];
  const tokens = text.split(/\s+/).map((w) => w.replace(/[*#]/g, ''));
  return tokens.some((t) => isSecretCandidate(t, cfg));
}

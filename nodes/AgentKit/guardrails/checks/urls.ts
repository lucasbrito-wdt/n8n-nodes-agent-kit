function detectUrls(text: string): string[] {
  const CLEANUP = /[.,;:!?)\\\]]+$/;
  const found: string[] = [];
  const schemePatterns = [
    /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi,
    /ftp:\/\/[^\s<>"{}|\\^`[\]]+/gi,
    /javascript:[^\s<>"{}|\\^`[\]]+/gi,
    /mailto:[^\s<>"{}|\\^`[\]]+/gi,
  ];
  const schemeDomains = new Set<string>();

  for (const p of schemePatterns) {
    for (const m of text.match(p) ?? []) {
      const clean = m.replace(CLEANUP, '');
      if (!clean) continue;
      found.push(clean);
      if (clean.includes('://')) {
        const domain = clean.split('://', 2)[1].split('/')[0].split('?')[0].toLowerCase();
        schemeDomains.add(domain);
      }
    }
  }

  const domainMatches = text.match(/\b(?:www\.)?[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(?:\/[^\s]*)?/gi) ?? [];
  for (let m of domainMatches) {
    m = m.replace(CLEANUP, '');
    if (!m) continue;
    const domain = m.split('/')[0].toLowerCase();
    if (!schemeDomains.has(domain)) found.push(m);
  }

  return [...new Set(found.filter(Boolean))];
}

function isAllowed(hostname: string, allowedUrls: string[], allowSubdomains: boolean): boolean {
  if (allowedUrls.length === 0) return false;
  const host = hostname.toLowerCase().replace(/^www\./, '');
  for (const entry of allowedUrls) {
    const allowed = entry.toLowerCase().trim().replace(/^www\./, '');
    if (host === allowed) return true;
    if (allowSubdomains && host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

export function urlsCheck(
  text: string,
  allowedUrls: string[],
  allowedSchemes: string[],
  blockUserinfo: boolean,
  allowSubdomains: boolean,
): boolean {
  const urls = detectUrls(text);
  if (urls.length === 0) return false;

  for (const url of urls) {
    try {
      const parsed = new URL(url.includes('://') ? url : `http://${url}`);
      const scheme = parsed.protocol.replace(':', '');
      if (!allowedSchemes.includes(scheme)) return true;
      if (blockUserinfo && (parsed.username || parsed.password)) return true;
      if (!isAllowed(parsed.hostname, allowedUrls, allowSubdomains)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

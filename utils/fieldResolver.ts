/**
 * Resolves a field path from a JSON object.
 *
 * Supported formats:
 *   message                    → obj.message
 *   msg.content                → obj.msg.content
 *   data["key"]                → obj.data.key
 *   data['key']                → obj.data.key
 *   items[0].text              → obj.items[0].text
 *   data[0]["content"].text    → obj.data[0].content.text
 *   a.b[1]['c']["d"][2].e      → fully mixed paths
 *
 * Falls back to treating `path` as a literal value when it contains
 * whitespace or characters that cannot appear in a valid field path
 * (e.g. when an n8n expression resolved to the message text itself).
 */
export function resolveField(obj: unknown, path: string): unknown {
  if (!path) return undefined;

  // If the path looks like resolved message text rather than a field
  // reference (contains whitespace, ?, !, etc.), return it as-is.
  if (/[\s?!,;]/.test(path) && !/^\s*\w[\w.[\]'"]*\s*$/.test(path)) {
    return path;
  }

  const tokens: Array<string | number> = [];
  // Matches: plain identifier, [N], ["key"], ['key']
  const re = /([^.[\s]+)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(path)) !== null) {
    if (match[1] !== undefined) tokens.push(match[1]);
    else if (match[2] !== undefined) tokens.push(Number(match[2]));
    else if (match[3] !== undefined) tokens.push(match[3]);
    else if (match[4] !== undefined) tokens.push(match[4]);
  }

  if (tokens.length === 0) return undefined;

  let current = obj;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string | number, unknown>)[token];
  }
  return current;
}

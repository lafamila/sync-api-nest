const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function remoteTextEdit(previous: string, next: string) {
  const value = next.replaceAll("\u00a0", " ");
  const before = Array.from(graphemes.segment(previous), (part) => part.segment);
  const after = Array.from(graphemes.segment(value), (part) => part.segment);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common += 1;
  return { value, backspaces: before.length - common, insertion: after.slice(common).join("") };
}

export function wireTextChunks(value: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    if (character === "\n") {
      if (current) chunks.push(current);
      chunks.push("\n");
      current = "";
      continue;
    }
    if (current.length + character.length > 1024) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks;
}

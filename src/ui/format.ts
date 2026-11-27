// Numbers and names as Romanian users read them. 1 KB = 1,000 bytes and 1 MB = 1,000,000
// bytes, matching the engine (docs/engine-design.md §6).

const oneDecimal = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 1 });

/** "850 KB", "1,2 MB", "18 MB". Rounds down, so a result never looks bigger than it is. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.floor(bytes / 1000))} KB`;
  return `${oneDecimal.format(Math.floor(bytes / 100_000) / 10)} MB`;
}

/**
 * A count with its noun, by Romanian rules: "1 pagină", "3 pagini", "20 de pagini",
 * "101 pagini". Numbers whose last two digits are 20 or more (or 00) take "de".
 */
export function count(n: number, one: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  const lastTwo = n % 100;
  return n === 0 || (lastTwo >= 1 && lastTwo <= 19) ? `${n} ${many}` : `${n} de ${many}`;
}

/** The size limit as it appears in file names: "1MB", "500KB", "2500KB". */
export function sizeTag(bytes: number): string {
  return bytes % 1_000_000 === 0 ? `${bytes / 1_000_000}MB` : `${Math.round(bytes / 1000)}KB`;
}

/** Output file name: the input's name plus the limit, e.g. "contract-1MB.pdf"; "acte-1MB.pdf" without one. */
export function outputName(inputName: string | null, targetBytes: number): string {
  const base = (inputName ?? '')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '')
    .trim()
    .slice(0, 80);
  return `${base || 'acte'}-${sizeTag(targetBytes)}.pdf`;
}

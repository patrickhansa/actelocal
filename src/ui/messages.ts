// What to tell the user when something goes wrong, in Romanian.

import type { EngineError } from '../engine';
import { formatBytes } from './format';

export function errorMessage(error: unknown, targetBytes: number): string {
  const code = (error as EngineError | null)?.code;
  const detail = (error as EngineError | null)?.detail ?? {};
  switch (code) {
    case 'invalid-pdf':
      return 'Fișierul nu pare a fi un PDF valid sau este deteriorat.';
    case 'password-protected':
      return 'PDF-ul este protejat cu parolă. Deschide-l cu parola, salvează-l din nou fără parolă (de exemplu „Imprimă” → „Salvează ca PDF”) și încearcă iar.';
    case 'unsupported-image':
      return (
        `Poza „${detail.fileName ?? ''}” nu poate fi citită în acest browser. ` +
        'Dacă e o poză HEIC de pe iPhone, alege-o direct din Safari pe iPhone sau salveaz-o întâi ca JPG.'
      );
    case 'no-pages':
      return 'Nu există nicio pagină de pus în PDF.';
    case 'target-unreachable':
      return detail.smallestBytes
        ? `Nu se poate ajunge sub ${formatBytes(targetBytes)} fără ca documentul să devină ilizibil. ` +
            `Cel mai mic fișier posibil are în jur de ${formatBytes(detail.smallestBytes)}. ` +
            'Alege o limită mai mare sau împarte documentul în mai multe fișiere.'
        : `Nu se poate ajunge sub ${formatBytes(targetBytes)}. Alege o limită mai mare.`;
    case 'render-failed':
      return 'Browserul a rămas fără memorie. Închide alte file sau aplicații și încearcă din nou, eventual cu mai puține pagini.';
    default:
      return 'A apărut o eroare neașteptată. Reîncarcă pagina și încearcă din nou.';
  }
}

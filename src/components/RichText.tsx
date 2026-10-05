import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';

/** **negrito** e `código` dentro de uma linha */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      tok.startsWith('**') ? (
        <strong key={`${key}-${i++}`} className="font-semibold text-white">
          {tok.slice(2, -2)}
        </strong>
      ) : (
        <code key={`${key}-${i++}`} className="px-1 rounded bg-white/10 font-mono text-[10.5px] text-slate-100">
          {tok.slice(1, -1)}
        </code>
      )
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Markdown mínimo das respostas da IA: blocos ``` (com botão copiar), `código`,
 * **negrito** e listas. O resto fica como texto (whitespace preservado).
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const code = part.replace(/^[\w-]*\n/, '').replace(/\n$/, '');
          return (
            <span key={i} className="group relative block my-1">
              <pre className="px-2 py-1 rounded-lg bg-black font-mono text-[10.5px] text-slate-100 whitespace-pre-wrap break-all">{code}</pre>
              <button
                type="button"
                aria-label="Copiar"
                title="Copiar"
                onClick={() => void navigator.clipboard?.writeText(code)}
                className="absolute top-1 right-1 p-0.5 rounded text-slate-500 hover:text-white opacity-0 group-hover:opacity-100"
              >
                <Copy className="w-3 h-3" />
              </button>
            </span>
          );
        }
        return (
          <span key={i}>
            {part.split('\n').map((line, j, all) => {
              const bullet = line.match(/^\s*[-*]\s+(.*)$/);
              const content = bullet ? ['• ', ...inline(bullet[1], `${i}-${j}`)] : inline(line, `${i}-${j}`);
              return (
                <span key={j}>
                  {content}
                  {j < all.length - 1 && '\n'}
                </span>
              );
            })}
          </span>
        );
      })}
    </>
  );
}

import { Brain, Plug, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAgentKit } from '../../hooks/useBrain';
import { isTauri } from '../../lib/tauri';

const inputCls =
  'min-w-0 bg-surface-2 border border-white/5 rounded-xl px-2.5 py-1 text-[11px] text-white placeholder-slate-600 focus:outline-none focus:border-white/20';
const smallBtn =
  'shrink-0 inline-flex items-center gap-1 px-2.5 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white text-[11px] disabled:opacity-40 transition-colors';
const hintCls = 'text-[10px] text-slate-500 leading-snug';
const sectionCls = 'flex items-center gap-1.5 pt-2 text-[10px] uppercase tracking-wider text-slate-400 font-semibold';

/** Sugestões de plugins MCP prontos (precisam de npx/uvx instalados) */
const SUGGESTED: { name: string; line: string; hint: string }[] = [
  { name: 'arquivos', line: 'npx -y @modelcontextprotocol/server-filesystem ~', hint: 'ler/organizar arquivos da pasta pessoal' },
  { name: 'web', line: 'uvx mcp-server-fetch', hint: 'abrir páginas da web' },
  { name: 'raciocinio', line: 'npx -y @modelcontextprotocol/server-sequential-thinking', hint: 'planejar tarefas em etapas' },
  { name: 'navegador', line: 'npx -y @playwright/mcp@latest', hint: 'controlar um navegador' },
];

/** Divide "npx -y pacote 'com espaço'" em comando + argumentos */
function splitLine(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));
}

/** Config → Agente: memória, skills e plugins do Lumo */
export function AgentPage() {
  const kit = useAgentKit(true);
  const [fact, setFact] = useState('');
  const [skillSrc, setSkillSrc] = useState('');
  const [skillMsg, setSkillMsg] = useState('');
  const [installing, setInstalling] = useState(false);
  const [pluginName, setPluginName] = useState('');
  const [pluginLine, setPluginLine] = useState('');

  if (!isTauri()) return <p className="text-slate-500">Disponível no app instalado.</p>;

  const installSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!skillSrc.trim()) return;
    setInstalling(true);
    setSkillMsg('');
    const r = await kit.installSkill(skillSrc.trim());
    setInstalling(false);
    if (r) {
      setSkillMsg(`Instalada: ${r.join(', ')}`);
      setSkillSrc('');
    }
  };

  const addPlugin = async (name: string, line: string) => {
    const [command, ...args] = splitLine(line);
    if (!name.trim() || !command) return;
    if (await kit.addPlugin(name.trim(), command, args)) {
      setPluginName('');
      setPluginLine('');
    }
  };

  return (
    <>
      <p className={hintCls}>
        O Lumo guarda o que aprende sobre você, segue skills instaladas e usa plugins externos. Tudo fica neste computador.
      </p>
      {kit.error && <p className="text-[10px] text-amber-400 line-clamp-2" title={kit.error}>{kit.error}</p>}

      <div className={sectionCls}>
        <Brain className="w-3 h-3" /> Memória ({kit.facts.length})
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (fact.trim()) void kit.addFact(fact.trim()).then(() => setFact(''));
        }}
      >
        <input aria-label="Novo fato" className={`${inputCls} flex-1`} placeholder="Ex.: prefiro respostas curtas" value={fact} onChange={(e) => setFact(e.target.value)} />
        <button type="submit" disabled={!fact.trim()} className={smallBtn}>
          Guardar
        </button>
      </form>
      <div className="space-y-1 max-h-28 overflow-y-auto custom-scrollbar">
        {kit.facts.length === 0 && <p className={hintCls}>Nada ainda. Conversando, o Lumo guarda sozinho o que for importante.</p>}
        {[...kit.facts].reverse().map((f) => (
          <div key={f.id} className="flex items-start gap-1.5 text-slate-300">
            <span className="flex-1 leading-snug">{f.text}</span>
            <button type="button" aria-label="Esquecer" title="Esquecer" onClick={() => void kit.forgetFact(f.id)} className="p-0.5 text-slate-500 hover:text-white">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>

      <div className={sectionCls}>
        <Sparkles className="w-3 h-3" /> Skills ({kit.skills.length})
      </div>
      <form onSubmit={installSkill} className="flex gap-1.5">
        <input
          aria-label="Origem da skill"
          className={`${inputCls} flex-1 font-mono`}
          placeholder="dono/repositório, pasta ou URL de um SKILL.md"
          value={skillSrc}
          onChange={(e) => setSkillSrc(e.target.value)}
        />
        <button type="submit" disabled={installing || !skillSrc.trim()} className="lumo-pill shrink-0 px-3 h-6 rounded-full text-white font-semibold disabled:opacity-40">
          {installing ? '…' : 'Instalar'}
        </button>
      </form>
      {skillMsg && <p className={hintCls}>{skillMsg}</p>}
      <div className="space-y-1">
        {kit.skills.map((s) => (
          <div key={s.name} className="flex items-start gap-1.5">
            <div className="flex-1 min-w-0">
              <span className="text-slate-200">{s.name}</span>
              <span className="block text-[10px] text-slate-500 truncate" title={s.description}>
                {s.description}
              </span>
            </div>
            <button type="button" aria-label="Remover skill" title="Remover" onClick={() => void kit.removeSkill(s.name)} className="p-0.5 text-slate-500 hover:text-white">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      <p className={hintCls}>Também dá para pedir no chat: “instale a skill dono/repo”.</p>

      <div className={sectionCls}>
        <Plug className="w-3 h-3" /> Plugins MCP ({kit.plugins.length})
      </div>
      <div className="space-y-1">
        {kit.plugins.map((p) => (
          <div key={p.name} className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.running ? 'bg-emerald-400' : p.error ? 'bg-amber-400' : p.enabled ? 'bg-sky-400 animate-pulse' : 'bg-slate-600'}`} />
            <div className="flex-1 min-w-0">
              <span className="text-slate-200">{p.name}</span>
              <span className="block text-[10px] text-slate-500 truncate" title={p.error || p.tools.join(', ')}>
                {p.error ? p.error : p.running ? `${p.tools.length} ferramentas` : p.enabled ? 'iniciando…' : 'desligado'}
              </span>
            </div>
            <label className="flex items-center gap-1 text-[10px] text-slate-400" title="Usar as ferramentas sem pedir aprovação a cada vez">
              <input type="checkbox" checked={p.trusted} onChange={(e) => void kit.setPlugin(p.name, { trusted: e.target.checked })} /> confiar
            </label>
            <button type="button" className={smallBtn} onClick={() => void kit.setPlugin(p.name, { enabled: !p.enabled })}>
              {p.enabled ? 'Desligar' : 'Ligar'}
            </button>
            <button type="button" aria-label="Remover plugin" title="Remover" onClick={() => void kit.removePlugin(p.name)} className="p-0.5 text-slate-500 hover:text-white">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void addPlugin(pluginName, pluginLine);
        }}
      >
        <input aria-label="Nome do plugin" className={`${inputCls} w-24`} placeholder="nome" value={pluginName} onChange={(e) => setPluginName(e.target.value)} />
        <input aria-label="Comando do plugin" className={`${inputCls} flex-1 font-mono`} placeholder="npx -y @org/servidor-mcp" value={pluginLine} onChange={(e) => setPluginLine(e.target.value)} />
        <button type="submit" disabled={!pluginName.trim() || !pluginLine.trim()} className={smallBtn}>
          Adicionar
        </button>
      </form>
      <div className="flex flex-wrap gap-1">
        {SUGGESTED.filter((s) => !kit.plugins.some((p) => p.name === s.name)).map((s) => (
          <button key={s.name} type="button" title={`${s.hint} — ${s.line}`} onClick={() => void addPlugin(s.name, s.line)} className="px-2 h-5 rounded-full bg-white/[0.06] hover:bg-white/15 text-[10px] text-slate-300">
            + {s.name}
          </button>
        ))}
      </div>
    </>
  );
}

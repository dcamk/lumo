# Continuidade e failover entre provedores

Como o Lumo lida com provedores lentos, fora do ar ou sem suporte a ferramentas sem perder o
progresso de uma tarefa.

## 1. Erros classificados (`src-tauri/src/brain/llm.rs` · `src/api/aiService.ts`)

| Classe | Exemplos | O que acontece |
|---|---|---|
| `Limit` | HTTP 429, “rate limit”, “quota” | troca na hora; pausa pelo `Retry-After` informado (padrão 15 min) |
| `Server` | HTTP 5xx, “overloaded”, conexão recusada/caída | troca na hora; pausa curta de 60 s |
| `Timeout` | sem resposta dentro do limite | troca na hora; pausa de 5 min |
| `Unsupported` | o modelo recusou `tools` | vai para o fim da fila (ver item 2) |
| `Auth` | HTTP 401/402/403, chave inválida, sem saldo | marcado como reprovado até novo teste |
| `Other` | demais erros | passa ao próximo; pausa de 2 min |

`Fail::recoverable()` / `isRecoverable()` marcam as falhas passageiras. Nenhuma delas repete o pedido
no mesmo provedor. No navegador (`npm run dev`), `streamChatFailover` aplica a mesma regra e troca
de provedor se o primeiro pedaço da resposta não chegar em 30 s.

## 2. Ferramentas: failover antecipado (`orchestrator.rs` → `call_model`)

Quando o passo precisa de ferramentas (terminal, arquivos, delegação), a fila é dividida:
primeiro os provedores com ferramentas nativas e, no fim, os que só funcionam em texto. Se um
provedor recusa `tools`, ele é registrado como “só texto” e o próximo compatível assume na mesma
hora. Nada de forçar um modelo fraco a simular ferramentas em texto. O protocolo em texto só é
usado como último recurso, quando nenhum compatível respondeu.

## 3. Contexto de retomada

**Backend:** `run_loop` acumula uma linha por passo concluído (`run_command(ls ~) → Código de saída: 0`,
até 20). Se o provedor que respondia cai e outro assume no meio da tarefa, o novo recebe no
prompt de sistema a instrução **RETOMADA** com essa lista: continua dali, sem repetir. A conversa
inteira (chamadas e resultados) já vai junto, em formato neutro (`Msg`), para qualquer provedor.

**Interface (`src/hooks/useChat.ts`):** se nenhum provedor responder e já havia progresso, o backend
envia o evento `interrupted { done }`. O chat avisa (“retomando em outro…”), espera 4 s (os
provedores que falharam já estão de castigo) e reenvia o pedido original com os passos prontos.
Se ainda assim falhar, a retomada fica guardada e a próxima mensagem do usuário a leva junto.
**Parar** e **Nova conversa** descartam a retomada.

## Testes

```bash
cd src-tauri
cargo test erros_classificados_para_failover     # classificação 429/5xx/rede/tempo/ferramentas
cargo test failover_em_503_retoma_no_proximo      # servidor falso 503 → outro provedor assume com a retomada
```

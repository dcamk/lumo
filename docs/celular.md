# Lumo no celular e no tablet

O Lumo do PC pode ser usado no celular ou tablet pela rede local (os dois no mesmo Wi-Fi).
O celular usa a IA configurada no PC (Claude, Gemini, Groq…): as chaves nunca saem do computador.

## Como usar

1. No PC, abra **Config → Celular** e ligue a ponte.
2. Aponte a câmera do celular para o QR code. O navegador abre o Lumo já pareado.
   Sem câmera: abra o endereço mostrado (ex.: `http://192.168.0.10:4646`) e digite o PIN.
3. Opcional: no navegador, use **Adicionar à tela inicial** para abrir como app.

Funciona em Android e iPhone/iPad pelo navegador, sem instalar nada.

## O que o app móvel faz

| Tela | O que tem |
| --- | --- |
| **Lumo** | Personagem 3D. Toque (pula), dois toques (gira), segurar (fica feliz, faíscas), arrastar (gira com o dedo), inclinar o aparelho (olha junto), sacudir (fica tonto). Parado um minuto, cochila. Atalhos: perguntar, mandar foto, colar do PC, chamar o PC. |
| **Chat** | Conversa com o cérebro do PC (mesma memória). Comandos e gravações que a IA quiser fazer no PC pedem aprovação na tela do celular. |
| **Nuvem** | Nuvem pessoal guardada no PC (`~/Lumo Nuvem`): pastas, envio de fotos e arquivos, download, renomear e apagar (vai para `.lixeira`). Aba **Notas** usa o banco de dados da nuvem (coleções JSON em `.lumo-db/`). |
| **Controle** | CPU, memória, disco, bateria/temperatura; play/pausa/próxima do player do PC; abrir link no PC; mandar e pegar texto da área de transferência. |
| **Ajustes** | Modo claro/escuro, paleta, modelo 3D (Cubo, Orbe, Cristal, Gota), inclinação, vibração, sempre ligado ao carregar, desconectar. |
| **Sempre ligado** | Painel de mesa: relógio, Lumo em descanso e o PC; tela não apaga (Wake Lock) e o conteúdo se desloca para não marcar OLED. Na tela de bloqueio e como widget só no app nativo (fase 2). |

O layout se adapta: no celular as abas ficam embaixo; no tablet (768 px ou mais) viram barra
lateral, e em telas largas o chat mostra o Lumo 3D ao lado. Notch e barras do sistema são
respeitados (`safe-area`).

## Segurança

- A ponte vem **desligada** e só escuta enquanto estiver ligada em Config → Celular.
- Pareamento por PIN de 6 dígitos, de uso único, que expira em 10 minutos e é trocado após 5 erros.
- Cada aparelho recebe um token próprio; só o hash fica em disco (`~/.config/com.lumo.assistant/bridge.json`).
  Dá para remover um aparelho no PC ou desconectar pelo próprio celular.
- No chat do celular nada roda sem aprovação (o modo automático do PC não vale para o celular).
- Todo caminho da nuvem fica preso em `~/Lumo Nuvem` (sem `..`, ocultos ou links para fora).
- **Limite:** é HTTP puro na rede local, sem criptografia. Use em redes de confiança (casa, não Wi-Fi público).

## Organização do código

```
mobile/                 app do celular/tablet (React + three.js), página separada no Vite
  index.html
  src/App.tsx           navegação e layout (celular × tablet)
  src/lib/bridge.ts     cliente da API da ponte
  src/three/LumoStage.tsx   Lumo 3D com os modelos e animações de toque
  src/screens/          Conectar, Início, Chat, Arquivos, Controle, Ajustes
public/mobile/          manifest e ícones do app móvel
src-tauri/src/bridge.rs ponte: servidor HTTP na porta 4646, pareamento, API e arquivos estáticos
src/components/tabs/PhonePage.tsx   Config → Celular no PC
```

`npm run build` gera os dois apps (`dist/index.html` e `dist/mobile/`); o PC embute os dois e a
ponte serve o móvel.

### API da ponte

Sem token: `GET /api/hello`, `POST /api/pair {pin, name}`.
Com `Authorization: Bearer <token>` (ou `?t=` em downloads):
`GET /api/status`, `POST /api/chat {text}` (NDJSON com os eventos do agente),
`POST /api/approve {id, approved}`, `POST /api/cancel`, `POST /api/ask {prompt}`,
`POST /api/media {action}`, `POST /api/open {url}`, `GET|POST /api/clipboard`,
`POST /api/ping {text}`, `GET /api/cloud/list?path=`, `GET /api/cloud/file?path=`,
`POST /api/cloud/upload?path=` (corpo cru + `X-File-Name`), `POST /api/cloud/mkdir|rename|delete`,
`GET /api/db/{coleção}?since=`, `PUT|DELETE /api/db/{coleção}/{id}`, `POST /api/unpair`.

## Próximo passo: app Android instalável

A interface móvel já é a mesma que irá no APK. O plano é empacotar com Tauri 2 mobile (projeto
separado e leve, só a casca), gerar o APK pelo GitHub Actions e depois avaliar o iPhone (exige Mac e
conta de desenvolvedor Apple).

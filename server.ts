import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 1420;

  app.use(express.json());

  const ai = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      })
    : null;

  app.get('/api/ai/health', (req, res) => {
    res.json({
      geminiAvailable: !!process.env.GEMINI_API_KEY,
      status: 'ok',
    });
  });

  // AI Chat endpoint
  app.post('/api/ai/chat', async (req, res) => {
    try {
      const { provider = 'gemini', messages, systemPrompt, customConfig } = req.body;
      const lastMessage = messages?.[messages.length - 1]?.content || 'Olá';

      if (provider === 'gemini') {
        const client = customConfig?.apiKey ? new GoogleGenAI({ apiKey: customConfig.apiKey }) : ai;
        if (!client) {
          return res.status(400).json({ error: 'Chave do Gemini não configurada.' });
        }
        const response = await client.models.generateContent({
          model: customConfig?.model || 'gemini-2.5-flash',
          contents: (messages || [{ role: 'user', content: lastMessage }]).map((m: any) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          config: {
            systemInstruction: systemPrompt || 'Você é o assistente de produtividade Lumo para Linux. Seja conciso, amigável, minimalista e focado em produtividade diária.',
          },
        });
        return res.json({ reply: response.text || 'Sem resposta gerada.' });
      }

      if (provider === 'ollama') {
        const ollamaUrl = customConfig?.endpoint || 'http://localhost:11434';
        const model = customConfig?.model || 'llama3';
        try {
          const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: [
                ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                ...(messages || [{ role: 'user', content: lastMessage }]),
              ],
              stream: false,
            }),
          });
          if (!ollamaRes.ok) {
            const errText = await ollamaRes.text();
            return res.status(ollamaRes.status).json({ error: `Ollama error: ${errText}` });
          }
          const data = (await ollamaRes.json()) as any;
          return res.json({ reply: data.message?.content || '' });
        } catch (fetchErr: any) {
          return res.status(503).json({
            error: `Não foi possível conectar ao Ollama em ${ollamaUrl}. Verifique se o serviço 'ollama serve' está rodando no seu Linux.`
          });
        }
      }

      // OpenAI e todos os provedores compatíveis (Groq, OpenRouter, Cerebras, LLM7…)
      if (provider === 'openai' || provider === 'openai-compatible') {
        const apiKey = customConfig?.apiKey || process.env.OPENAI_API_KEY;
        const base = String(customConfig?.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const model = customConfig?.model || 'gpt-4o-mini';
        const openaiRes = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
              ...(messages || [{ role: 'user', content: lastMessage }]),
            ],
          }),
        });
        if (!openaiRes.ok) {
          const err = await openaiRes.text();
          return res.status(openaiRes.status).json({ error: `Provedor respondeu: ${err.slice(0, 300)}` });
        }
        const data = (await openaiRes.json()) as any;
        return res.json({ reply: data.choices?.[0]?.message?.content || '' });
      }

      if (provider === 'claude') {
        const apiKey = customConfig?.apiKey || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          return res.status(400).json({ error: 'Chave de API Claude não configurada.' });
        }
        const model = customConfig?.model || 'claude-opus-5-5';
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 16000,
            system: systemPrompt || 'Você é o assistente Lumo para Linux.',
            messages: messages || [{ role: 'user', content: lastMessage }],
          }),
        });
        if (!claudeRes.ok) {
          const err = await claudeRes.text();
          return res.status(claudeRes.status).json({ error: `Claude error: ${err}` });
        }
        const data = (await claudeRes.json()) as any;
        return res.json({ reply: data.content?.[0]?.text || '' });
      }

      return res.status(400).json({ error: `Provedor desconhecido: ${provider}` });
    } catch (err: any) {
      console.error('AI Chat Error:', err);
      res.status(500).json({ error: err.message || 'Falha ao processar solicitação com IA' });
    }
  });

  // Task breakdown endpoint
  app.post('/api/ai/breakdown', async (req, res) => {
    try {
      const { title, description } = req.body;
      if (!ai) {
        return res.json({
          subtasks: [
            { id: '1', title: 'Definir escopo e requisitos', completed: false },
            { id: '2', title: 'Executar primeira iteração prática', completed: false },
            { id: '3', title: 'Revisar qualidade e finalizar entrega', completed: false },
          ],
        });
      }

      const prompt = `Você é um planejador de produtividade. Divida a seguinte tarefa em 3 a 5 subtarefas práticas, concisas e acionáveis em português.
Título da Tarefa: "${title}"
Descrição: "${description || ''}"
Responda APENAS com um array JSON com strings puras, exemplo:
["Subtarefa 1", "Subtarefa 2", "Subtarefa 3"]`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const text = response.text || '[]';
      const parsed = JSON.parse(text);
      const subtasks = Array.isArray(parsed)
        ? parsed.map((item: any, idx: number) => ({
            id: String(Date.now() + idx),
            title: typeof item === 'string' ? item : item?.title || `Subtarefa ${idx + 1}`,
            completed: false,
          }))
        : [];

      return res.json({ subtasks });
    } catch (err: any) {
      console.error('Breakdown error:', err);
      return res.json({
        subtasks: [
          { id: '1', title: 'Preparar requisitos e contexto', completed: false },
          { id: '2', title: 'Executar tarefa principal', completed: false },
          { id: '3', title: 'Testar e validar resultado', completed: false },
        ],
      });
    }
  });

  // Notes summarizer endpoint
  app.post('/api/ai/summarize', async (req, res) => {
    try {
      const { content } = req.body;
      if (!content || !ai) {
        return res.json({
          summary: 'Nota concisa registrada no sistema.',
          keyPoints: ['Ponto de ação identificado'],
        });
      }

      const prompt = `Resuma o seguinte texto de notas em 2 a 3 frases objetivas e extraia até 3 pontos de ação principais em português.
Texto:
${content}

Responda em formato JSON:
{
  "summary": "resumo em 2-3 frases",
  "keyPoints": ["ação 1", "ação 2"]
}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const data = JSON.parse(response.text || '{}');
      return res.json({
        summary: data.summary || 'Resumo das anotações gerado com sucesso.',
        keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints : [],
      });
    } catch (err: any) {
      console.error('Summarize error:', err);
      return res.json({
        summary: 'Resumo das anotações efetuado.',
        keyPoints: [],
      });
    }
  });

  // In development, mount Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve dist folder
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
  });
}

startServer();

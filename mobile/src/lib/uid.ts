// crypto.randomUUID só existe em contexto seguro (HTTPS/localhost); pela rede local o app
// roda em http://<ip>, então usamos um id próprio.
let n = 0;
export const uid = () => `${Date.now().toString(36)}-${(n++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

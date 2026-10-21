import { createServer } from "node:http";
import { ejecutarDemo } from "./demo";
import { responderConAgente } from "./agent";

const pagina = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Registro de Contratos Vigentes</title>
<style>
:root{font-family:Inter,Segoe UI,Arial,sans-serif;color:#172b25;background:#f4f7f5}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px}
main{width:min(920px,100%);height:min(850px,94vh);background:white;border:1px solid #dbe5df;border-radius:20px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 16px 50px #173b2912}
header{padding:22px 26px;background:#103e31;color:#fff}h1{font-size:21px;margin:0 0 6px}header p{margin:0;color:#d2e8dc;font-size:13px}
#messages{padding:22px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:14px}
.msg{white-space:pre-wrap;line-height:1.5;padding:14px 16px;border-radius:14px;max-width:95%;font-size:14px}
.bot{background:#f0f5f2;align-self:flex-start;border:1px solid #e1eae4}
.user{background:#d8efe2;align-self:flex-end;max-width:80%}
.controls{padding:14px 20px;border-top:1px solid #e5ece7;display:flex;gap:8px;flex-wrap:wrap}
button{border:0;border-radius:10px;background:#176b4b;color:white;padding:11px 14px;font-weight:600;cursor:pointer}
button.secondary{background:#e9f2ec;color:#18543d}button:disabled{opacity:.5;cursor:wait}
form{padding:14px 20px 20px;display:flex;gap:10px;border-top:1px solid #e5ece7}
input{min-width:0;flex:1;border:1px solid #cbd8d0;border-radius:10px;padding:13px;font-size:14px}
small{color:#65766b;font-size:12px;padding:0 20px 16px}
</style>
</head>
<body><main>
<header><h1>Registro de Contratos Vigentes</h1><p>Asistente local · extracción, validación, registro y alertas</p></header>
<section id="messages"><div class="msg bot">¡Hola! Puedo procesar el buzón de contratos de demostración, mostrar los resultados y generar alertas. Los archivos de salida se guardan en la carpeta <b>out</b>.</div></section>
<div class="controls">
<button class="secondary" onclick="send('Procesar buzón')">Procesar buzón</button>
<button class="secondary" onclick="send('Generar alertas')">Generar alertas</button>
<button class="secondary" onclick="send('Confirmar msg-006')">Confirmar msg-006</button>
</div>
<form id="form"><input id="input" placeholder="Escribe: procesar buzón, alertas o confirmar msg-006" autocomplete="off"><button id="send">Enviar</button></form>
<small>Modo de demostración local. La confirmación de msg-006 simula la acción explícita de un usuario.</small>
</main>
<script>
const messages=document.getElementById('messages'), input=document.getElementById('input'), sendButton=document.getElementById('send');
function add(text,kind){const el=document.createElement('div');el.className='msg '+kind;el.textContent=text;messages.appendChild(el);messages.scrollTop=messages.scrollHeight;return el}
async function send(message){if(!message.trim())return;add(message,'user');input.value='';sendButton.disabled=true;
try{const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message})});const data=await r.json();add(data.reply||data.error||'No hubo respuesta.','bot')}
catch(e){add('No se pudo conectar con el servidor local. Revisa la terminal de VS Code.','bot')}
finally{sendButton.disabled=false;input.focus()}}
document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();send(input.value)});
</script></body></html>`;

const servidor = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pagina);
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    let cuerpo = "";
    req.on("data", (parte: Buffer) => {
      cuerpo += parte.toString("utf8");
      if (cuerpo.length > 20_000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const body = JSON.parse(cuerpo) as { message?: unknown };
        const mensaje = typeof body.message === "string" ? body.message.trim() : "";
        if (!mensaje) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Escribe una solicitud." }));
          return;
        }
        if (/ayuda|qu[eé]\s+puedes|hola/i.test(mensaje) && !/proces|alert|confirm/i.test(mensaje)) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ reply: "Puedo procesar el buzón de seis mensajes, registrar los contratos sin campos pendientes, detectar duplicados, rechazar cotizaciones, generar alertas o simular la confirmación humana de msg-006. Usa los botones para ejecutar una acción." }));
          return;
        }
        const confirmar = /confirm/i.test(mensaje) && /msg-?0?06|006|contrato/i.test(mensaje);
        const reporte = process.env.OPENAI_API_KEY
          ? await responderConAgente(mensaje)
          : await ejecutarDemo(confirmar);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ reply: reporte, modo: process.env.OPENAI_API_KEY ? "llm" : "demo" }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Error interno" }));
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Ruta no encontrada" }));
});
const puerto = Number(process.env.PORT ?? 3000);
servidor.listen(puerto, () => console.log(`Agente local disponible en http://localhost:${puerto}`));

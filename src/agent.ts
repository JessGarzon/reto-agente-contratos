import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  registroHerramientas,
  ejecutarHerramientaPorNombre,
  type ContextoHerramienta,
} from "./tools/registry";

type MensajeChat = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

type RespuestaAPI = {
  error?: { message?: string };
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
};

const InstruccionesBase = `Eres un agente conversacional para gestionar contratos vigentes. Responde en español y usa las herramientas para consultar o modificar datos reales; no inventes resultados. Sigue el prompt de negocio y las políticas que recibes.

Reglas de ejecución:
- Para procesar el buzón, llama contratos_leer_buzon y procesa cada mensaje con contratos_extraer y contratos_validar. Si el documento es cotización o no tiene contrato, recházalo con explicación y no llames contratos_registrar.
- Para validar, pasa el objeto contrato devuelto por extracción y el tipo_documento. Si es otrosí, pasa referencia_contrato y fecha_fin_modificada. Nunca rechaces un otrosí solo porque el documento no repite el objeto original.
- Solo registra nuevo/actualizacion si requiere_revision está vacío. Si hay campos de revisión, no registres hasta que el usuario confirme expresamente ese contrato. Nunca inventes campos: usa null y confianza 0 si no hay evidencia.
- Si la clasificación es duplicado o rechazado, no registres. Para contratos con póliza obligatoria, el estado inicial es pendiente; si no aplica, usa no_aplica.
- Para generar alertas usa contratos_alertas con la fecha actual local de Colombia en YYYY-MM-DD.
- Si la solicitud pide confirmar msg-006, eso es confirmación explícita para ese mensaje solamente. No interpretes una solicitud general de procesar el buzón como confirmación.
- No afirmes que se guardó un registro a menos que contratos_registrar devuelva ok:true. Resume qué herramientas ejecutaste, resultados y bloqueos.
- Si una herramienta devuelve ok:false, explica el error de forma breve y continúa con otros mensajes cuando sea posible.
- Límite de seguridad: máximo 24 rondas de llamadas al modelo por solicitud y no más de 24 llamadas de herramientas. No ejecutes acciones que el usuario no solicitó.`;

function fechaColombia(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function responderConAgente(mensajeUsuario: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta OPENAI_API_KEY. Configura una clave de API para activar el agente LLM.");
  }

  const directorio = process.cwd();
  const promptPath = path.join(directorio, "src", "prompts", "registro-contratos.md");
  const promptNegocio = await readFile(promptPath, "utf8");
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const modelo = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const ctx: ContextoHerramienta = { directory: directorio, sessionId: randomUUID() };
  const mensajes: MensajeChat[] = [
    { role: "system", content: `${InstruccionesBase}\n\nPROMPT DE NEGOCIO:\n${promptNegocio}\n\nFecha local Colombia: ${fechaColombia()}.` },
    { role: "user", content: mensajeUsuario },
  ];
  const herramientas = registroHerramientas.map((herramienta) => {
    const esquema = z.toJSONSchema(herramienta.parameters as z.ZodType<unknown>) as Record<string, unknown>;
    delete esquema["$schema"];
    return {
      type: "function",
      function: {
        name: herramienta.name,
        description: herramienta.description,
        parameters: esquema,
        strict: false,
      },
    };
  });
  let totalHerramientas = 0;

  for (let ronda = 0; ronda < 24; ronda += 1) {
    const respuesta = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelo,
        messages: mensajes,
        tools: herramientas,
        tool_choice: "auto",
        parallel_tool_calls: false,
        temperature: 0.1,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const cuerpo = await respuesta.json() as RespuestaAPI;
    if (!respuesta.ok) {
      throw new Error(cuerpo.error?.message ?? `Error del proveedor LLM (${respuesta.status}).`);
    }
    const respuestaModelo = cuerpo.choices?.[0]?.message;
    if (!respuestaModelo) throw new Error("El proveedor no devolvió un mensaje del modelo.");
    mensajes.push({
      role: "assistant",
      content: respuestaModelo.content ?? null,
      ...(respuestaModelo.tool_calls ? { tool_calls: respuestaModelo.tool_calls } : {}),
    });

    const llamadas = respuestaModelo.tool_calls ?? [];
    if (llamadas.length === 0) {
      return respuestaModelo.content?.trim() || "El agente terminó sin generar una respuesta textual.";
    }

    for (const llamada of llamadas) {
      totalHerramientas += 1;
      if (totalHerramientas > 24) {
        mensajes.push({ role: "tool", tool_call_id: llamada.id, name: llamada.function.name, content: JSON.stringify({ ok: false, error: "Se alcanzó el límite de 24 llamadas de herramientas por solicitud." }) });
        return "Detuve la ejecución por el límite de seguridad de herramientas. Divide la solicitud en pasos más pequeños.";
      }
      let argumentos: unknown;
      try {
        argumentos = JSON.parse(llamada.function.arguments) as unknown;
      } catch {
        mensajes.push({ role: "tool", tool_call_id: llamada.id, name: llamada.function.name, content: JSON.stringify({ ok: false, error: "El modelo generó argumentos JSON inválidos." }) });
        continue;
      }
      const resultado = await ejecutarHerramientaPorNombre(llamada.function.name, argumentos, ctx);
      mensajes.push({ role: "tool", tool_call_id: llamada.id, name: llamada.function.name, content: resultado });
    }
  }
  return "Alcancé el límite de iteraciones del agente. Revisa los resultados de las herramientas en out/log.jsonl y vuelve a solicitar una acción más específica.";
}

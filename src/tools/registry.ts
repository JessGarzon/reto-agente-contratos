import { z } from "zod";
import path from "node:path";
import { contratosLeerBuzon, contratosExtraer, contratosValidar, type ContratoExtraido as ContratoFuente } from "./contratos";
import { contratosRegistrar, type ContratoExtraido as ContratoDestino } from "./contratos-registrar";
import { contratosAlertas } from "./contratos-alertas";
import { registrarLlamadaHerramienta } from "./log";

export type ContextoHerramienta = { directory: string; sessionId: string };
type Herramienta<T> = {
  name: string;
  description: string;
  parameters: z.ZodType<T>;
  execute: (args: T, ctx: ContextoHerramienta) => Promise<string>;
};

const CampoTexto = z.object({
  valor: z.string().nullable().describe("Valor textual extraído; null si no está disponible."),
  confianza: z.number().min(0).max(1).describe("Confianza de extracción entre 0 y 1."),
}).describe("Campo textual extraído con confianza.");
const CampoNumero = z.object({
  valor: z.number().nullable().describe("Importe numérico, sin separadores de miles."),
  confianza: z.number().min(0).max(1).describe("Confianza de extracción entre 0 y 1."),
}).describe("Campo numérico extraído con confianza.");
const CampoBooleano = z.object({
  valor: z.boolean().nullable().describe("Indica si requiere póliza; null si se desconoce."),
  confianza: z.number().min(0).max(1).describe("Confianza de extracción entre 0 y 1."),
}).describe("Campo booleano extraído con confianza.");

const ContratoFuenteSchema = z.object({
  id_contrato: CampoTexto,
  cliente: CampoTexto,
  nit_cliente: CampoTexto,
  contratista: CampoTexto,
  nit_contratista: CampoTexto,
  objeto: CampoTexto,
  valor: CampoNumero,
  fecha_inicio: CampoTexto,
  fecha_fin: CampoTexto,
  requiere_poliza: CampoBooleano,
  estado_poliza: CampoTexto,
  pais: CampoTexto,
  moneda: CampoTexto,
  tipo_poliza: CampoTexto,
  comercial: CampoTexto,
}).describe("Datos extraídos del documento contractual.");

const ContratoDestinoSchema = z.object({
  id_contrato: CampoTexto, cliente: CampoTexto, nit_cliente: CampoTexto,
  pais: CampoTexto, objeto: CampoTexto, valor: CampoNumero, moneda: CampoTexto,
  fecha_inicio: CampoTexto, fecha_fin: CampoTexto, requiere_poliza: CampoBooleano,
  tipo_poliza: CampoTexto, estado_poliza: CampoTexto, comercial: CampoTexto,
}).describe("Campos normalizados para escribir en el maestro de contratos.");

const ValidacionSchema = z.object({
  clasificacion: z.enum(["nuevo", "actualizacion", "duplicado", "rechazado"]).describe("Resultado de clasificación."),
  requiere_revision: z.array(z.string()).describe("Campos que requieren revisión humana."),
  conflictos: z.array(z.string()).describe("Campos que difieren del maestro."),
  motivo: z.string().describe("Explicación de la decisión."),
}).describe("Resultado de validación contra el maestro.");

async function segura<T>(
  name: string,
  args: T,
  ctx: ContextoHerramienta,
  run: () => Promise<string>,
): Promise<string> {
  const inicio = new Date().toISOString();
  const t0 = Date.now();
  let texto = "";
  let estado: "ok" | "error" = "ok";
  try {
    texto = await run();
    const parsed = JSON.parse(texto) as { ok?: boolean };
    if (parsed.ok === false) estado = "error";
    return texto;
  } catch (error: unknown) {
    estado = "error";
    texto = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Error desconocido" });
    return texto;
  } finally {
    try {
      await registrarLlamadaHerramienta(ctx.directory, {
        herramienta: name, sessionId: ctx.sessionId, argumentos: args,
        resultado: estado, inicio, duracion_ms: Date.now() - t0,
        ...(estado === "error" ? { detalle: texto.slice(0, 500) } : {}),
      });
    } catch {
      // Un error de auditoría no debe derribar el flujo de conversación.
    }
  }
}

// Las herramientas se exportan individualmente para conservar sus esquemas
// Zod y permitir que el agente seleccione la herramienta por nombre.
export const contratosLeerBuzonTool: Herramienta<{}> = {
  name: "contratos_leer_buzon",
  description: "Lee el buzón de contratos y devuelve mensajes, adjuntos y tipo probable de documento.",
  parameters: z.object({}).describe("No requiere argumentos."),
  execute: (args, ctx) => segura("contratos_leer_buzon", args, ctx, () =>
    contratosLeerBuzon(path.join(ctx.directory, "fixtures", "reto-02", "buzon"))),
};

export const contratosExtraerTool: Herramienta<{ mensaje_id: string }> = {
  name: "contratos_extraer",
  description: "Extrae datos estructurados y confianza desde los adjuntos de un mensaje.",
  parameters: z.object({
    mensaje_id: z.string().regex(/^msg-\d+$/).describe("Identificador del mensaje, por ejemplo msg-001."),
  }).describe("Argumentos de extracción."),
  execute: (args, ctx) => segura("contratos_extraer", args, ctx, () =>
    contratosExtraer(path.join(ctx.directory, "fixtures", "reto-02", "buzon"), args.mensaje_id)),
};

export const contratosValidarTool: Herramienta<{
  mensaje_id: string; contrato: ContratoFuente; tipo_documento?: "contrato" | "otrosi" | "cotizacion" | "no_identificado";
  referencia_contrato?: string | null; fecha_fin_modificada?: string | null;
}> = {
  name: "contratos_validar",
  description: "Clasifica el documento como nuevo, actualización, duplicado o rechazado y detecta campos que requieren revisión.",
  parameters: z.object({
    mensaje_id: z.string().describe("Identificador del correo de origen."),
    contrato: ContratoFuenteSchema.describe("Contrato extraído del adjunto."),
    tipo_documento: z.enum(["contrato", "otrosi", "cotizacion", "no_identificado"]).optional().describe("Tipo de documento identificado."),
    referencia_contrato: z.string().nullable().optional().describe("ID del contrato original al que refiere un otrosí."),
    fecha_fin_modificada: z.string().nullable().optional().describe("Nueva fecha de fin indicada por el otrosí."),
  }).describe("Contrato y contexto del mensaje para validación."),
  execute: (args, ctx) => segura("contratos_validar", args, ctx, () =>
    contratosValidar(
      path.join(ctx.directory, "fixtures", "reto-02", "maestro-contratos.csv"),
      args.contrato,
      { tipoDocumento: args.tipo_documento, referenciaContrato: args.referencia_contrato, fechaFinModificada: args.fecha_fin_modificada },
    )),
};

export const contratosRegistrarTool: Herramienta<{
  mensaje_id: string; contrato: ContratoDestino; validacion: z.infer<typeof ValidacionSchema>; confirmado?: boolean;
}> = {
  name: "contratos_registrar",
  description: "Registra un contrato nuevo o actualiza uno existente; bloquea revisión pendiente sin confirmación humana.",
  parameters: z.object({
    mensaje_id: z.string().describe("Identificador del correo de origen."),
    contrato: ContratoDestinoSchema.describe("Datos normalizados del contrato."),
    validacion: ValidacionSchema.describe("Resultado de la validación previa."),
    confirmado: z.boolean().optional().describe("Confirmación humana explícita para continuar con campos de baja confianza."),
  }).describe("Datos para registrar el contrato con trazabilidad."),
  execute: (args, ctx) => segura("contratos_registrar", args, ctx, () =>
    contratosRegistrar(ctx.directory, args.mensaje_id, args.contrato as ContratoDestino, args.validacion, args.confirmado ?? false)),
};

export const contratosAlertasTool: Herramienta<{ hoy: string }> = {
  name: "contratos_alertas",
  description: "Genera alertas de vencimientos dentro de 60 días, pólizas no vigentes y registros posteriores al corte.",
  parameters: z.object({
    hoy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha de cálculo en formato YYYY-MM-DD."),
  }).describe("Fecha de referencia para las alertas."),
  execute: (args, ctx) => segura("contratos_alertas", args, ctx, () =>
    contratosAlertas(ctx.directory, args.hoy)),
};

export const registroHerramientas = [
  contratosLeerBuzonTool, contratosExtraerTool, contratosValidarTool,
  contratosRegistrarTool, contratosAlertasTool,
];

/** Ejecuta una herramienta por nombre validando sus argumentos con Zod. */
export async function ejecutarHerramientaPorNombre(
  nombre: string,
  argumentos: unknown,
  ctx: ContextoHerramienta,
): Promise<string> {
  const herramientas = registroHerramientas as unknown as Array<{
    name: string;
    parameters: z.ZodType;
    execute: (args: never, context: ContextoHerramienta) => Promise<string>;
  }>;
  const herramienta = herramientas.find((item) => item.name === nombre);
  if (!herramienta) {
    return JSON.stringify({ ok: false, error: `Herramienta no permitida: ${nombre}` });
  }
  const validacion = herramienta.parameters.safeParse(argumentos);
  if (!validacion.success) {
    return JSON.stringify({
      ok: false,
      error: "Argumentos inválidos para la herramienta.",
      detalles: validacion.error.issues.map((issue) => ({
        campo: issue.path.join("."),
        mensaje: issue.message,
      })),
    });
  }
  return herramienta.execute(validacion.data as never, ctx);
}

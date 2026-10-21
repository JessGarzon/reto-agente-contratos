import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import {
  contratosLeerBuzon,
  contratosExtraer,
  contratosValidar,
  type ContratoExtraido,
} from "./tools/contratos";
import { contratosRegistrar } from "./tools/contratos-registrar";
import { contratosAlertas } from "./tools/contratos-alertas";
import { registrarLlamadaHerramienta } from "./tools/log";

type Maestro = {
  id_contrato: string; cliente: string; nit_cliente: string; pais: string;
  objeto: string; valor: string; moneda: string; fecha_inicio: string;
  fecha_fin: string; requiere_poliza: string; tipo_poliza: string;
  estado_poliza: string; comercial: string; ruta_sharepoint: string;
  fecha_registro: string; fuente: string;
};
type Campo<T> = { valor: T | null; confianza: number };
type ContratoRegistro = {
  id_contrato: Campo<string>; cliente: Campo<string>; nit_cliente: Campo<string>;
  pais: Campo<string>; objeto: Campo<string>; valor: Campo<number>;
  moneda: Campo<string>; fecha_inicio: Campo<string>; fecha_fin: Campo<string>;
  requiere_poliza: Campo<boolean>; tipo_poliza: Campo<string>;
  estado_poliza: Campo<string>; comercial: Campo<string>;
};
type Validacion = {
  clasificacion: "nuevo" | "actualizacion" | "duplicado" | "rechazado";
  requiere_revision: string[]; conflictos: string[]; motivo: string;
};
type ResumenCorreo = { id: string; de: string; asunto: string; adjuntos: string[]; tiene_contrato: boolean };
type Resultado<T> = { ok: boolean; data: T; error?: string };
type DatosExtraccion = {
  mensaje_id: string;
  tipo_documento: "contrato" | "otrosi" | "cotizacion" | "no_identificado";
  contrato: ContratoExtraido | null;
  motivo?: string;
  otrosi?: { id_contrato_relacionado: string | null; fecha_fin_modificada: string | null };
};
type ResultadoRegistro = { accion?: string };
const parseJson = (s: string): unknown => JSON.parse(s) as unknown;
const campo = <T>(valor: T | null, confianza = valor === null ? 0 : 0.95): Campo<T> => ({ valor, confianza });

async function invocar<T>(directorio: string, herramienta: string, argumentos: unknown, fn: () => Promise<string>): Promise<T> {
  const inicio = new Date().toISOString();
  const reloj = Date.now();
  let texto = "";
  let resultado: "ok" | "error" = "ok";
  try {
    texto = await fn();
    const obj = parseJson(texto) as { ok?: boolean };
    if (obj.ok === false) resultado = "error";
    return obj as T;
  } catch (e) {
    resultado = "error";
    throw e;
  } finally {
    await registrarLlamadaHerramienta(directorio, {
      herramienta, sessionId: "demo-local", argumentos, resultado,
      inicio, duracion_ms: Date.now() - reloj,
      ...(resultado === "error" ? { detalle: texto.slice(0, 500) } : {}),
    });
  }
}

export async function ejecutarDemo(confirmarMsg006 = false): Promise<string> {
  const salida: string[] = [];
  const reportar = (...partes: unknown[]) => {
    const linea = partes.map((parte) => typeof parte === "string" ? parte : String(parte)).join(" ");
    salida.push(linea);
    console.log(linea);
  };
  const directorio = process.cwd();
  const buzon = path.join(directorio, "fixtures", "reto-02", "buzon");
  const maestroFuente = path.join(directorio, "fixtures", "reto-02", "maestro-contratos.csv");
  await rm(path.join(directorio, "out"), { recursive: true, force: true });
  await mkdir(path.join(directorio, "out"), { recursive: true });

  const lectura = await invocar<Resultado<ResumenCorreo[]>>(directorio, "contratos_leer_buzon", {}, () => contratosLeerBuzon(buzon));
  if (!lectura.ok) throw new Error(lectura.error);
  const correos = lectura.data;
  reportar("\n=== Registro de Contratos Vigentes ===");
  reportar(`Mensajes encontrados: ${correos.length}\n`);

  const filas = parse(await readFile(maestroFuente, "utf-8"), {
    columns: true, skip_empty_lines: true, bom: true, trim: true,
  }) as Maestro[];
  const comerciales = JSON.parse(
    await readFile(path.join(directorio, "fixtures", "reto-02", "comerciales.json"), "utf-8"),
  ) as Array<{ email: string; nombre: string; region: string }>;

  for (const correo of correos) {
    reportar(`\n[${correo.id}] ${correo.asunto}`);
    const comercialRemitente = comerciales.find(
      (comercial) => comercial.email.toLowerCase() === correo.de.toLowerCase(),
    );
    if (!comercialRemitente) {
      reportar(`  Aviso: remitente ${correo.de} no está en comerciales.json; continúa con revisión normal.`);
    }
    try {
      const extraccion = await invocar<Resultado<DatosExtraccion>>(directorio, "contratos_extraer", { mensaje_id: correo.id }, () => contratosExtraer(buzon, correo.id));
      if (!extraccion.ok) {
        reportar(`  ERROR extracción: ${extraccion.error}`);
        continue;
      }
      const datos = extraccion.data;
      if (!datos.contrato) {
        reportar(`  Clasificación: rechazado — ${datos.motivo}`);
        await registrarLlamadaHerramienta(directorio, {
          herramienta: "contratos_validar", sessionId: "demo-local",
          argumentos: { mensaje_id: correo.id, tipo_documento: datos.tipo_documento },
          resultado: "ok", inicio: new Date().toISOString(), duracion_ms: 0,
          detalle: "Rechazo temprano: no contiene contrato registrable.",
        });
        continue;
      }

      const extraido = datos.contrato;
      const relacionado = datos.tipo_documento === "otrosi"
        ? (datos.otrosi?.id_contrato_relacionado ?? extraido.id_contrato.valor)
        : extraido.id_contrato.valor;

      const validacionRaw = await invocar<Resultado<Validacion>>(
        directorio, "contratos_validar",
        { mensaje_id: correo.id, tipo_documento: datos.tipo_documento, id_contrato: relacionado },
        () => contratosValidar(maestroFuente, extraido, {
          tipoDocumento: datos.tipo_documento,
          referenciaContrato: relacionado,
          fechaFinModificada: datos.otrosi?.fecha_fin_modificada,
        }),
      );
      if (!validacionRaw.ok) {
        reportar(`  ERROR validación: ${validacionRaw.error}`);
        continue;
      }
      const validacion = validacionRaw.data;
      reportar(`  Clasificación: ${validacion.clasificacion}`);
      reportar(`  Motivo: ${validacion.motivo}`);
      if (validacion.requiere_revision.length) {
        reportar(`  Revisión humana: ${validacion.requiere_revision.join(", ")}`);
      }
      if (validacion.conflictos.length) {
        reportar(`  Campos modificados: ${validacion.conflictos.join(", ")}`);
      }

      if (validacion.clasificacion === "rechazado" || validacion.clasificacion === "duplicado") {
        reportar(validacion.clasificacion === "duplicado" ? "  Registro omitido: ya existe." : "  Registro omitido: rechazado.");
        continue;
      }

      if (validacion.requiere_revision.length) {
        reportar("  Registro bloqueado hasta confirmación humana.");
        continue;
      }

      const anterior = filas.find((f) => f.id_contrato === relacionado);
      const contratoRegistro: ContratoRegistro = {
        id_contrato: extraido.id_contrato,
        cliente: extraido.cliente.valor ? extraido.cliente : campo(anterior?.cliente ?? null),
        nit_cliente: extraido.nit_cliente.valor ? extraido.nit_cliente : campo(anterior?.nit_cliente ?? null),
        pais: extraido.pais.valor ? extraido.pais : campo(anterior?.pais ?? null),
        objeto: extraido.objeto.valor ? extraido.objeto : campo(anterior?.objeto ?? null),
        valor: extraido.valor.valor !== null ? extraido.valor : campo(anterior ? Number(anterior.valor) : null),
        moneda: extraido.moneda.valor ? extraido.moneda : campo(anterior?.moneda ?? null),
        fecha_inicio: extraido.fecha_inicio.valor ? extraido.fecha_inicio : campo(anterior?.fecha_inicio ?? null),
        fecha_fin: datos.tipo_documento === "otrosi" && datos.otrosi?.fecha_fin_modificada
          ? campo(datos.otrosi.fecha_fin_modificada, 0.99)
          : extraido.fecha_fin.valor ? extraido.fecha_fin : campo(anterior?.fecha_fin ?? null),
        requiere_poliza: extraido.requiere_poliza.valor !== null ? extraido.requiere_poliza : campo(anterior ? /^(true|1|si|sí)$/i.test(anterior.requiere_poliza) : null),
        tipo_poliza: extraido.tipo_poliza.valor ? extraido.tipo_poliza : campo(anterior?.tipo_poliza ?? null),
        estado_poliza: datos.tipo_documento === "otrosi" && anterior?.requiere_poliza === "true"
          ? campo("pendiente", 0.9)
          : extraido.estado_poliza.valor ? extraido.estado_poliza : campo(anterior?.estado_poliza ?? null),
        comercial: campo(anterior?.comercial ?? comercialRemitente?.nombre ?? (extraido.pais.valor === "CO" ? "Laura Gómez Restrepo" : "Carlos Ruiz Medina"), 0.85),
      };
      const confirmado = confirmarMsg006 && correo.id === "msg-006";
      const registro = await invocar<Resultado<ResultadoRegistro>>(
        directorio, "contratos_registrar",
        { mensaje_id: correo.id, confirmado, clasificacion: validacion.clasificacion },
        () => contratosRegistrar(directorio, correo.id, contratoRegistro, validacion, confirmado),
      );
      reportar(registro.ok
        ? `  Registro: ${registro.data?.accion ?? "completado"}`
        : `  Registro bloqueado: ${registro.error}`);
    } catch (error) {
      reportar(`  Error procesando mensaje: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const alertas = await invocar<Resultado<{ archivo: string; vencimientos: number; polizas_pendientes: number; registros_posteriores_al_corte: number }>>(directorio, "contratos_alertas", { hoy }, () => contratosAlertas(directorio, hoy));
  reportar("\n=== Alertas ===");
  reportar(alertas.ok ? JSON.stringify(alertas.data, null, 2) : alertas.error);
  reportar("\nArchivos generados: out/log.jsonl, out/procesados.json, out/sharepoint/maestro-contratos.csv, out/sharepoint/historial.jsonl y out/alertas.md");
  if (!confirmarMsg006) {
    reportar("\nPara simular la confirmación humana del contrato msg-006, ejecuta: npm.cmd run demo:confirmar");
  }
  return salida.join("\n");
}
if (process.argv[1]?.toLowerCase().includes("demo")) {
  ejecutarDemo(process.argv.includes("--confirmar-msg-006")).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
